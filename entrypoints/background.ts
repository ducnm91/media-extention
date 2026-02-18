export default defineBackground(() => {
  console.log("Hello background!", { id: browser.runtime.id });

  let lastError: string | null = null;

  browser.runtime.onMessage.addListener(
    (
      message: { type: string; url?: string },
      sender: { tab?: { id?: number } },
      sendResponse,
    ) => {
      if (message.type === "GET_LAST_ERROR") {
        sendResponse(lastError ?? "");
        return true;
      }
      if (message.type === "DOWNLOAD_HLS" && message.url && sender.tab?.id) {
        lastError = null;
        const tabId = sender.tab.id;
        downloadHls(message.url, tabId)
          .then(async (result) => {
            if (!result) {
              sendResponse(true);
              return;
            }
            const sessionId = result.filename.replace(/\.ts$/i, "");
            const saved = await trySaveSegmentsToServer(
              result.segmentBuffers,
              sessionId,
            );
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

/** Parse m3u8 text, return segment URIs (and variant URL if master). */
function parseM3u8(
  text: string,
  baseUrl: string,
): { segments: string[]; variantUrl: string | null } {
  const lines = text
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter(Boolean);
  const segments: string[] = [];
  let variantUrl: string | null = null;

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (line.startsWith("#EXT-X-STREAM-INF")) {
      const next = lines[i + 1];
      if (next && !next.startsWith("#")) {
        variantUrl = resolveUrl(baseUrl, next);
        break;
      }
    }
    if (line.startsWith("#EXTINF:")) {
      const next = lines[i + 1];
      if (next && !next.startsWith("#")) {
        segments.push(resolveUrl(baseUrl, next));
      }
    }
  }
  return { segments, variantUrl };
}

async function fetchText(url: string): Promise<string> {
  const res = await fetch(url, { mode: "cors", credentials: "omit" });
  if (!res.ok) throw new Error(`HTTP ${res.status}: ${url}`);
  return res.text();
}

async function fetchBytes(url: string): Promise<ArrayBuffer> {
  const res = await fetch(url, { mode: "cors", credentials: "omit" });
  if (!res.ok) throw new Error(`HTTP ${res.status}: ${url}`);
  return res.arrayBuffer();
}

const SERVER_BASE = "http://127.0.0.1:8765";
const CHUNK_SIZE = 8 * 1024 * 1024; // 8MB mỗi message (tránh giới hạn postMessage)

/** Gửi từng segment lên server, sau đó /finish → .mp4 + folder segments. */
async function trySaveSegmentsToServer(
  segmentBuffers: ArrayBuffer[],
  sessionId: string,
): Promise<string | null> {
  try {
    const total = segmentBuffers.length;
    for (let i = 0; i < total; i++) {
      const body = new Uint8Array(segmentBuffers[i]);
      const res = await fetch(`${SERVER_BASE}/segment`, {
        method: "POST",
        body,
        headers: {
          "X-Session-Id": sessionId,
          "X-Index": String(i),
          "X-Total": String(total),
        },
      });
      if (!res.ok) return null;
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
): Promise<{
  buffer: ArrayBuffer;
  filename: string;
  segmentBuffers: ArrayBuffer[];
} | null> {
  const baseUrl = getBaseUrl(m3u8Url);
  let text = await fetchText(m3u8Url);
  let { segments, variantUrl } = parseM3u8(text, baseUrl);

  if (variantUrl) {
    const variantBase = getBaseUrl(variantUrl);
    text = await fetchText(variantUrl);
    const parsed = parseM3u8(text, variantBase);
    if (parsed.segments.length) segments = parsed.segments;
  }

  if (!segments.length)
    throw new Error("Không tìm thấy segment nào trong M3U8.");

  const segmentBuffers: ArrayBuffer[] = [];
  for (let i = 0; i < segments.length; i++) {
    const buf = await fetchBytes(segments[i]);
    segmentBuffers.push(buf);
    try {
      await browser.tabs.sendMessage(
        tabId,
        {
          type: "HLS_DOWNLOAD_PROGRESS",
          current: i + 1,
          total: segments.length,
        },
        { frameId: 0 },
      );
    } catch {
      // Tab có thể đã đóng
    }
  }

  const totalLength = segmentBuffers.reduce((s, c) => s + c.byteLength, 0);
  const combined = new Uint8Array(totalLength);
  let offset = 0;
  for (const c of segmentBuffers) {
    combined.set(new Uint8Array(c), offset);
    offset += c.byteLength;
  }

  const filename = `hls-download-${Date.now()}.ts`;
  return {
    buffer: combined.buffer,
    filename,
    segmentBuffers,
  };
}
