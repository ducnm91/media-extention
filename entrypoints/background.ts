// Lưu URL M3U8 gần nhất theo tab (từ webRequest) để content script lấy khi bấm Download
const lastM3u8ByTab = new Map<number, string>();

/** Trả về URL playlist M3U8 thật: hoặc chính url (nếu path kết thúc .m3u8), hoặc trích từ query (vd: ping?mu=...m3u8). */
function getM3u8UrlToStore(requestUrl: string): string | null {
  if (!requestUrl || !requestUrl.includes("m3u8")) return null;
  try {
    const u = new URL(requestUrl);
    if (u.pathname.endsWith(".m3u8") || u.pathname.includes(".m3u8"))
      return requestUrl;
    const params = u.searchParams;
    const keys = ["mu", "url", "src", "manifest", "playlist", "m3u8", "hls"];
    for (const key of keys) {
      const val = params.get(key);
      if (!val) continue;
      const decoded = decodeURIComponent(val);
      if (
        (decoded.startsWith("http://") || decoded.startsWith("https://")) &&
        decoded.includes("m3u8")
      )
        return decoded;
    }
  } catch {
    // ignore
  }
  return null;
}

export default defineBackground(() => {
  console.log("Hello background!", { id: browser.runtime.id });

  let lastError: string | null = null;

  // Chỉ lưu URL thực sự là M3U8 (path .m3u8) hoặc trích từ query (vd: jwplayer ping?mu=...index.m3u8)
  browser.webRequest.onCompleted.addListener(
    (details) => {
      const toStore = getM3u8UrlToStore(details.url || "");
      if (toStore && details.tabId > 0)
        lastM3u8ByTab.set(details.tabId, toStore);
    },
    { urls: ["<all_urls>"] },
  );

  // Dọn URL khi tab đóng
  browser.tabs.onRemoved.addListener((tabId) => {
    lastM3u8ByTab.delete(tabId);
  });

  browser.runtime.onMessage.addListener(
    (
      message: { type: string; url?: string; pageTitle?: string },
      sender: { tab?: { id?: number } },
      sendResponse,
    ) => {
      if (message.type === "GET_LAST_ERROR") {
        sendResponse(lastError ?? "");
        return true;
      }
      if (message.type === "GET_LAST_M3U8" && sender.tab?.id) {
        const url = lastM3u8ByTab.get(sender.tab.id) ?? null;
        sendResponse(url);
        return false;
      }
      if (message.type === "INSPECT_M3U8" && message.url) {
        inspectM3u8(message.url)
          .then(sendResponse)
          .catch((err) =>
            sendResponse({
              error: err instanceof Error ? err.message : String(err),
            }),
          );
        return true;
      }
      if (message.type === "DOWNLOAD_HLS" && message.url && sender.tab?.id) {
        lastError = null;
        const tabId = sender.tab.id;

        if (
          !activeDownloadTabs.has(tabId) &&
          activeDownloadTabs.size >= CONFIG.maxParallelDownloadTabs
        ) {
          lastError = `Đang tải tối đa ${CONFIG.maxParallelDownloadTabs} tab cùng lúc. Đợi một số tab tải xong rồi thử lại.`;
          sendResponse(false);
          return false;
        }

        activeDownloadTabs.add(tabId);
        updateActionBadge();

        downloadHls(message.url, tabId, message.pageTitle || "")
          .then(async (result) => {
            if (!result) {
              sendResponse(true);
              return;
            }
            const sessionId = result.filename
              .replace(/\.ts$/i, "")
              .replace(/\.mp4$/i, "");
            const saved =
              result.segmentBuffers.length > 0
                ? await trySaveSegmentsToServer(
                    result.segmentBuffers,
                    sessionId,
                  )
                : null;
            if (saved) {
              try {
                await browser.tabs.sendMessage(
                  tabId,
                  { type: "HLS_SAVE_RESULT", success: true, mp4: saved },
                  { frameId: 0 },
                );
              } catch {
                // Tab đã đóng hoặc reload
              }
              try {
                await browser.tabs.remove(tabId);
              } catch {
                // ignore
              }
              sendResponse(true);
              return;
            }
            const fallback = await trySaveToServer(
              result.buffer,
              result.filename,
            );
            if (fallback) {
              try {
                await browser.tabs.sendMessage(
                  tabId,
                  { type: "HLS_SAVE_RESULT", success: true, mp4: fallback },
                  { frameId: 0 },
                );
              } catch {
                // Tab đã đóng hoặc reload
              }
              try {
                await browser.tabs.remove(tabId);
              } catch {
                // ignore
              }
              sendResponse(true);
              return;
            }
            const buffer = result.buffer;
            return sendChunksToTab(tabId, buffer, result.filename).then(() =>
              sendResponse(true),
            );
          })
          .catch((err) => {
            lastError = err instanceof Error ? err.message : String(err);
            sendResponse(false);
          })
          .finally(() => {
            activeDownloadTabs.delete(tabId);
            updateActionBadge();
            void notifyAllDownloadsDone();
          });
        return true; // keep channel open for async sendResponse
      }
      return false;
    },
  );
});

function getBaseUrl(url: string): string {
  const lastSlash = url.lastIndexOf("/");
  return lastSlash >= 0 ? url.slice(0, lastSlash + 1) : url + "/";
}

function resolveUrl(base: string, relative: string): string {
  if (relative.startsWith("http://") || relative.startsWith("https://"))
    return relative;
  const rel = relative.trim();
  if (!rel) return base;
  if (rel.startsWith("/")) {
    try {
      const u = new URL(base);
      return u.origin + rel;
    } catch {
      return base + rel.slice(1);
    }
  }
  return base + rel;
}

/** Một segment: URL và tùy chọn byte range (cho fMP4 / single-file). */
type SegmentRef = { url: string; range?: string };

/** Parse m3u8: segment list (TS hoặc fMP4), init segment (fMP4), và variant nếu là master. */
function parseM3u8(
  text: string,
  baseUrl: string,
): {
  segments: SegmentRef[];
  initSegment?: SegmentRef;
  variantUrl: string | null;
  variants: { url: string; bandwidth?: number; resolution?: string }[];
} {
  const lines = text
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter(Boolean);
  const segments: SegmentRef[] = [];
  let initSegment: SegmentRef | undefined;
  const variants: { url: string; bandwidth?: number; resolution?: string }[] =
    [];
  let variantUrl: string | null = null;

  let lastSegmentUri: string | null = null;
  let nextByterange: string | null = null;

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];

    if (line.startsWith("#EXT-X-STREAM-INF")) {
      const next = lines[i + 1];
      if (next && !next.startsWith("#")) {
        const url = resolveUrl(baseUrl, next);
        const bandwidth = line.match(/BANDWIDTH=(\d+)/)?.[1];
        const resolution = line.match(/RESOLUTION=(\d+x\d+)/)?.[1];
        variants.push({
          url,
          bandwidth: bandwidth ? parseInt(bandwidth, 10) : undefined,
          resolution,
        });
        if (!variantUrl) variantUrl = url;
      }
    }

    if (line.startsWith("#EXT-X-MAP:")) {
      const uriMatch = line.match(/URI="([^"]+)"/);
      const rangeMatch = line.match(/BYTERANGE="(\d+)(?:@(\d+))?"/);
      if (uriMatch) {
        const url = resolveUrl(baseUrl, uriMatch[1].trim());
        const range = rangeMatch
          ? rangeMatch[2]
            ? `${rangeMatch[1]}@${rangeMatch[2]}`
            : rangeMatch[1]
          : undefined;
        initSegment = { url, range };
        lastSegmentUri = url;
      }
    }

    if (line.startsWith("#EXT-X-BYTERANGE:")) {
      const m = line.match(/#EXT-X-BYTERANGE:(.+)/);
      nextByterange = m ? m[1].trim() : null;
    }

    if (line.startsWith("#EXTINF:")) {
      const next = lines[i + 1];
      if (next && !next.startsWith("#")) {
        const segUrl = resolveUrl(baseUrl, next);
        lastSegmentUri = segUrl;
        if (nextByterange) {
          segments.push({ url: segUrl, range: nextByterange });
        } else {
          segments.push({ url: segUrl });
        }
        nextByterange = null;
      }
    } else if (nextByterange && lastSegmentUri) {
      segments.push({ url: lastSegmentUri, range: nextByterange });
      nextByterange = null;
    }
  }

  if (variants.length > 1) {
    const videoVariant =
      variants.find((v) => v.resolution) ||
      variants.sort((a, b) => (b.bandwidth ?? 0) - (a.bandwidth ?? 0))[0];
    if (videoVariant) variantUrl = videoVariant.url;
  }

  return { segments, initSegment, variantUrl, variants };
}

async function fetchText(url: string): Promise<string> {
  const res = await fetch(url, { mode: "cors", credentials: "omit" });
  if (!res.ok) throw new Error(`HTTP ${res.status}: ${url}`);
  return res.text();
}

/** Kiểm tra M3U8: fetch, parse, trả về thông tin để debug (hiển thị trong popup). */
async function inspectM3u8(url: string): Promise<{
  inspectedUrl: string;
  fetchError?: string;
  contentType: "master" | "media" | "unknown";
  rawFirstLines: string;
  parsed: {
    segmentsCount: number;
    initSegment: boolean;
    hasByteRange: boolean;
    variantUrl: string | null;
    variantsCount: number;
    variants: { url: string; bandwidth?: number; resolution?: string }[];
  };
  variantRawFirstLines?: string;
  variantParsed?: {
    segmentsCount: number;
    initSegment: boolean;
    hasByteRange: boolean;
  };
}> {
  const baseUrl = getBaseUrl(url);
  let raw = "";
  let fetchError: string | undefined;
  try {
    raw = await fetchText(url);
  } catch (e) {
    fetchError = e instanceof Error ? e.message : String(e);
    return {
      inspectedUrl: url,
      fetchError,
      contentType: "unknown",
      rawFirstLines: "",
      parsed: {
        segmentsCount: 0,
        initSegment: false,
        hasByteRange: false,
        variantUrl: null,
        variantsCount: 0,
        variants: [],
      },
    };
  }
  const lines = raw.split(/\r?\n/);
  const rawFirstLines = lines.slice(0, 60).join("\n");
  const parsed = parseM3u8(raw, baseUrl);
  const contentType = parsed.variants.length > 0 ? "master" : "media";
  let variantRawFirstLines: string | undefined;
  let variantParsed:
    | { segmentsCount: number; initSegment: boolean; hasByteRange: boolean }
    | undefined;
  if (parsed.variantUrl) {
    try {
      const variantText = await fetchText(parsed.variantUrl);
      const vLines = variantText.split(/\r?\n/);
      variantRawFirstLines = vLines.slice(0, 60).join("\n");
      const vParsed = parseM3u8(variantText, getBaseUrl(parsed.variantUrl));
      variantParsed = {
        segmentsCount: vParsed.segments.length,
        initSegment: !!vParsed.initSegment,
        hasByteRange: vParsed.segments.some((s) => !!s.range),
      };
    } catch {
      variantRawFirstLines = "(không fetch được variant)";
    }
  }
  return {
    inspectedUrl: url,
    fetchError,
    contentType,
    rawFirstLines,
    parsed: {
      segmentsCount: parsed.segments.length,
      initSegment: !!parsed.initSegment,
      hasByteRange: parsed.segments.some((s) => !!s.range),
      variantUrl: parsed.variantUrl,
      variantsCount: parsed.variants.length,
      variants: parsed.variants,
    },
    variantRawFirstLines,
    variantParsed,
  };
}

/** Fetch với tùy chọn Range (cho fMP4 single-file). range dạng "length@offset" hoặc "length". */
async function fetchBytes(url: string, range?: string): Promise<ArrayBuffer> {
  const headers: Record<string, string> = {};
  if (range) {
    const [len, off] = range.split("@").map((s) => s.trim());
    const length = parseInt(len, 10);
    const offset = off ? parseInt(off, 10) : 0;
    headers.Range = `bytes=${offset}-${offset + length - 1}`;
  }
  const res = await fetch(url, {
    mode: "cors",
    credentials: "omit",
    headers: Object.keys(headers).length ? headers : undefined,
  });
  if (!res.ok) throw new Error(`HTTP ${res.status}: ${url}`);
  return res.arrayBuffer();
}

const SERVER_BASE = "http://127.0.0.1:8765";
const CHUNK_SIZE = 8 * 1024 * 1024; // 8MB mỗi message (tránh giới hạn postMessage)

const CONFIG = {
  // Số tab tối đa được phép tải HLS cùng lúc
  maxParallelDownloadTabs: 4,
  // Số segment tải song song cho mỗi video
  segmentFetchConcurrency: 8,
} as const;

const activeDownloadTabs = new Set<number>();

function updateActionBadge() {
  const count = activeDownloadTabs.size;
  if (count > 0) {
    browser.action.setBadgeText({ text: String(count) });
    browser.action.setBadgeBackgroundColor({ color: "#2e7d32" });
  } else {
    browser.action.setBadgeText({ text: "" });
  }
}

async function notifyAllDownloadsDone() {
  if (activeDownloadTabs.size === 0) {
    try {
      await browser.notifications.create({
        type: "basic",
        iconUrl: browser.runtime.getURL("wxt.svg"),
        title: "HLS Downloader",
        message: "Đã tải xong tất cả video đang xử lý.",
      });
    } catch {
      // ignore nếu trình duyệt không hỗ trợ notifications
    }
  }
}

function sanitizeTitleForFilename(title: string): string {
  const trimmed = (title || "").trim();
  if (!trimmed) return "";
  const noExt = trimmed.replace(/\.[a-zA-Z0-9]{1,4}$/, "");
  const replaced = noExt
    .replace(/[\/\\:*?"<>|]+/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .replace(/\s+/g, "_");
  return replaced.slice(0, 80);
}

/** Gửi từng segment lên server, sau đó /finish → .mp4 + folder segments. */
async function trySaveSegmentsToServer(
  segmentBuffers: ArrayBuffer[],
  sessionId: string,
): Promise<string | null> {
  try {
    const total = segmentBuffers.length;
    const concurrency = Math.max(
      1,
      Math.min(CONFIG.segmentFetchConcurrency, total),
    );
    for (let i = 0; i < total; i += concurrency) {
      const batch = segmentBuffers.slice(i, i + concurrency);
      const responses = await Promise.all(
        batch.map((buf, idx) => {
          const body = new Uint8Array(buf);
          const index = i + idx;
          return fetch(`${SERVER_BASE}/segment`, {
            method: "POST",
            body,
            headers: {
              "X-Session-Id": sessionId,
              "X-Index": String(index),
              "X-Total": String(total),
            },
          });
        }),
      );
      if (responses.some((res) => !res.ok)) return null;
    }
    const finishRes = await fetch(`${SERVER_BASE}/finish`, {
      method: "POST",
      body: new ArrayBuffer(0),
      headers: { "X-Session-Id": sessionId },
    });
    const data = (await finishRes.json().catch(() => ({}))) as {
      ok?: boolean;
      mp4?: string;
    };
    if (finishRes.ok && data.ok && data.mp4) return data.mp4;
  } catch {
    // Server không chạy hoặc lỗi mạng
  }
  return null;
}

/** Fallback: gửi 1 file .ts đã gộp lên /save (luồng cũ, không giữ folder segments). */
async function trySaveToServer(
  buffer: ArrayBuffer,
  filename: string,
): Promise<string | null> {
  try {
    const res = await fetch(`${SERVER_BASE}/save`, {
      method: "POST",
      body: buffer,
      headers: { "X-Filename": filename },
    });
    const data = (await res.json().catch(() => ({}))) as {
      ok?: boolean;
      mp4?: string;
    };
    if (res.ok && data.ok && data.mp4) return data.mp4;
  } catch {
    // ignore
  }
  return null;
}

const SEND_OPTIONS = { frameId: 0 } as const;

async function sendChunksToTab(
  tabId: number,
  buffer: ArrayBuffer,
  filename: string,
): Promise<void> {
  const u8 = new Uint8Array(buffer);
  const totalChunks = Math.ceil(u8.length / CHUNK_SIZE);
  await browser.tabs.sendMessage(
    tabId,
    { type: "HLS_DOWNLOAD_START", filename, totalChunks },
    SEND_OPTIONS,
  );
  for (let i = 0; i < totalChunks; i++) {
    const start = i * CHUNK_SIZE;
    const end = Math.min(start + CHUNK_SIZE, u8.length);
    const slice = u8.slice(start, end);
    const chunkCopy = new Uint8Array(slice.length);
    chunkCopy.set(slice);
    await browser.tabs.sendMessage(
      tabId,
      { type: "HLS_DOWNLOAD_CHUNK", buffer: chunkCopy.buffer, index: i },
      SEND_OPTIONS,
    );
    await new Promise((r) => setTimeout(r, 0));
  }
  await browser.tabs.sendMessage(
    tabId,
    { type: "HLS_DOWNLOAD_READY" },
    SEND_OPTIONS,
  );
}

async function downloadHls(
  m3u8Url: string,
  tabId: number,
  pageTitle: string,
): Promise<{
  buffer: ArrayBuffer;
  filename: string;
  segmentBuffers: ArrayBuffer[];
} | null> {
  const baseUrl = getBaseUrl(m3u8Url);
  let text = await fetchText(m3u8Url);
  let parsed = parseM3u8(text, baseUrl);
  let { segments, initSegment, variantUrl } = parsed;

  if (variantUrl) {
    const variantBase = getBaseUrl(variantUrl);
    text = await fetchText(variantUrl);
    parsed = parseM3u8(text, variantBase);
    if (parsed.segments.length || parsed.initSegment) {
      segments = parsed.segments;
      initSegment = parsed.initSegment;
    }
  }

  const isFmp4 = !!initSegment || segments.some((s) => s.range);
  if (!segments.length && !initSegment)
    throw new Error(
      "Không tìm thấy segment nào trong M3U8 (có thể là DASH .mpd hoặc định dạng khác).",
    );

  const segmentBuffers: ArrayBuffer[] = [];
  const totalParts = (initSegment ? 1 : 0) + segments.length;

  if (initSegment) {
    const buf = await fetchBytes(initSegment.url, initSegment.range);
    segmentBuffers.push(buf);
    try {
      await browser.tabs.sendMessage(
        tabId,
        { type: "HLS_DOWNLOAD_PROGRESS", current: 1, total: totalParts },
        { frameId: 0 },
      );
    } catch {}
  }

  const concurrency = Math.max(
    1,
    Math.min(CONFIG.segmentFetchConcurrency, segments.length),
  );
  for (let i = 0; i < segments.length; i += concurrency) {
    const batch = segments.slice(i, i + concurrency);
    const buffers = await Promise.all(
      batch.map((seg) => fetchBytes(seg.url, seg.range)),
    );
    for (let j = 0; j < buffers.length; j++) {
      const buf = buffers[j];
      segmentBuffers.push(buf);
      const segIndex = i + j;
      try {
        await browser.tabs.sendMessage(
          tabId,
          {
            type: "HLS_DOWNLOAD_PROGRESS",
            current: (initSegment ? 1 : 0) + segIndex + 1,
            total: totalParts,
          },
          { frameId: 0 },
        );
      } catch {}
    }
  }

  const totalLength = segmentBuffers.reduce((s, c) => s + c.byteLength, 0);
  const combined = new Uint8Array(totalLength);
  let offset = 0;
  for (const c of segmentBuffers) {
    combined.set(new Uint8Array(c), offset);
    offset += c.byteLength;
  }

  const safeTitle = sanitizeTitleForFilename(pageTitle);
  const base =
    safeTitle || `hls-download-${new Date().toISOString().replace(/[:.]/g, "-")}`;
  const filename = isFmp4 ? `${base}.mp4` : `${base}.ts`;
  return {
    buffer: combined.buffer,
    filename,
    segmentBuffers: isFmp4 ? [] : segmentBuffers,
  };
}
