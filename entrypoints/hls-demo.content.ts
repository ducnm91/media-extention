export default defineContentScript({
  // Chạy trên mọi trang để nút Download HLS xuất hiện (vd: phimmoichill, hlsjs demo, ...)
  matches: ["<all_urls>"],
  allFrames: false,
  main() {
    injectDownloadButton();
    setupDownloadReadyListener();
  },
});

let downloadChunksByIndex: (ArrayBuffer | null)[] = [];
let downloadFilename = "";
let downloadTotalChunks = 0;
/** Tab này được mở bởi batch (nhận TRIGGER_DOWNLOAD) → khi lỗi gửi BATCH_DONE để đóng tab. */
let isBatchTab = false;
/** Tab ID do background gửi kèm TRIGGER_DOWNLOAD, dùng để gửi lại trong BATCH_DONE (tránh sender.tab undefined). */
let batchTabId: number | undefined;

function normalizeChunkBuffer(buf: unknown): ArrayBuffer | null {
  if (buf instanceof ArrayBuffer) return buf;
  if (ArrayBuffer.isView(buf) && (buf as ArrayBufferView).buffer) {
    const v = buf as ArrayBufferView;
    if (v.byteLength === 0) return new ArrayBuffer(0);
    const copy = new Uint8Array(v.byteLength);
    copy.set(new Uint8Array(v.buffer, v.byteOffset, v.byteLength));
    return copy.buffer;
  }
  if (
    buf &&
    typeof buf === "object" &&
    "byteLength" in buf &&
    typeof (buf as ArrayBuffer).byteLength === "number"
  ) {
    const ab = buf as ArrayBuffer;
    const copy = new Uint8Array(ab.byteLength);
    copy.set(new Uint8Array(ab));
    return copy.buffer;
  }
  return null;
}

function setButtonText(text: string) {
  const btn = document.getElementById("hls-download-extension-btn");
  if (btn) (btn as HTMLButtonElement).textContent = text;
}

function finishDownload(blob: Blob, tsFilename: string) {
  setButtonText("Đang tải file...");
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = tsFilename;
  a.style.display = "none";
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  URL.revokeObjectURL(url);
  setButtonText("⬇ Download HLS (MP4)");
  alert(
    'Đã tải file .ts vào thư mục Download của trình duyệt.\n\nĐể tự động lưu MP4 vào thư mục download/ trong project: chạy "npm run download-server" rồi bấm Download lại.',
  );
}

function setupDownloadReadyListener() {
  browser.runtime.onMessage.addListener(
    (msg: {
      type: string;
      buffer?: ArrayBuffer;
      filename?: string;
      totalChunks?: number;
      index?: number;
      current?: number;
      total?: number;
      success?: boolean;
      mp4?: string;
      delayMs?: number;
      tabId?: number;
    }) => {
      if (msg.type === "HLS_SAVE_RESULT" && msg.success && msg.mp4) {
        setButtonText("⬇ Download HLS (MP4)");
        alert(`Đã lưu MP4: ${msg.mp4}\nThư mục: download/ trong project.`);
        return;
      }
      if (
        msg.type === "HLS_DOWNLOAD_PROGRESS" &&
        msg.current != null &&
        msg.total != null
      ) {
        setButtonText(`Đang tải ${msg.current}/${msg.total} segment...`);
        return;
      }
      if (
        msg.type === "HLS_DOWNLOAD_START" &&
        msg.filename &&
        msg.totalChunks
      ) {
        downloadChunksByIndex = new Array(msg.totalChunks).fill(null);
        downloadFilename = msg.filename;
        downloadTotalChunks = msg.totalChunks;
        return;
      }
      if (
        msg.type === "HLS_DOWNLOAD_CHUNK" &&
        msg.buffer !== undefined &&
        msg.index !== undefined
      ) {
        const buf = normalizeChunkBuffer(msg.buffer);
        if (buf && msg.index >= 0 && msg.index < downloadChunksByIndex.length) {
          downloadChunksByIndex[msg.index] = buf;
        }
        return;
      }
      if (msg.type === "HLS_DOWNLOAD_READY") {
        const name = downloadFilename;
        const total = downloadTotalChunks;
        const tryBuild = () => {
          const ready = downloadChunksByIndex.filter((c) => c != null).length;
          if (ready === total && total > 0) {
            const ordered = downloadChunksByIndex as ArrayBuffer[];
            downloadChunksByIndex = [];
            downloadFilename = "";
            downloadTotalChunks = 0;
            const blob = new Blob(ordered, { type: "video/MP2T" });
            finishDownload(blob, name);
            return;
          }
          downloadChunksByIndex = [];
          downloadFilename = "";
          downloadTotalChunks = 0;
          setButtonText("⬇ Download HLS (MP4)");
          if (isBatchTab) {
            try {
              browser.runtime.sendMessage({
                type: "BATCH_DONE",
                success: false,
                tabId: batchTabId,
              });
            } catch {
              // ignore
            }
          }
          alert(
            `Lỗi tải video (thiếu dữ liệu: ${ready}/${total}). Thử lại hoặc chọn stream khác.`,
          );
        };
        setTimeout(tryBuild, 500);
      }
      if (msg.type === "TRIGGER_DOWNLOAD") {
        isBatchTab = true;
        batchTabId = msg.tabId;
        // Extension mở tab và yêu cầu tự trigger tải (dùng cho batch). delayMs = 0 vì background đã chờ trước khi gửi.
        const delay = typeof msg.delayMs === "number" ? msg.delayMs : 0;
        setTimeout(() => {
          runDownloadForBatch().then((success) => {
            if (!success) {
              try {
                browser.runtime.sendMessage({
                  type: "BATCH_DONE",
                  success: false,
                  tabId: batchTabId,
                });
              } catch {
                // ignore
              }
            }
          });
        }, delay);
      }
      if (msg.type === "TRIGGER_UPDATE_METADATA") {
        const meta = collectPageMetadata();
        const tabId =
          typeof (msg as { tabId?: number }).tabId === "number"
            ? (msg as { tabId?: number }).tabId
            : undefined;
        try {
          browser.runtime.sendMessage({
            type: "UPDATE_METADATA",
            sourceUrl: meta.sourceUrl,
            views: meta.views,
            duration: meta.duration,
            tabId,
          });
        } catch {
          // ignore
        }
      }
    },
  );
}

browser.runtime.onMessage.addListener(
  (
    msg:
      | { type: "SCAN_CATEGORIES_AT_INDEX" }
      | { type: "SCAN_CATEGORY_PAGE"; minViews?: number; maxViews?: number },
    _sender,
    sendResponse,
  ) => {
    if (msg.type === "SCAN_CATEGORIES_AT_INDEX") {
      const cats = scanXvideosCategories();
      sendResponse({ categories: cats });
      return true;
    }
    if (msg.type === "SCAN_CATEGORY_PAGE") {
      const mv =
        typeof msg.minViews === "number" ? msg.minViews : 1_000_000;
      const maxv =
        typeof msg.maxViews === "number" ? msg.maxViews : 10_000_000_000;
      const res = scanXvideosCategoryListPage(mv, maxv);
      sendResponse(res);
      return true;
    }
    return false;
  },
);

function scanXvideosCategories(): { url: string; label: string }[] {
  const base = `${window.location.protocol}//${window.location.host}`;
  // Lấy TẤT CẢ <li> trong #main-cats-sub-list (dyn, dyntopterm, dyntop-cat, ...)
  const anchors = document.querySelectorAll<HTMLAnchorElement>(
    "#main-cats-sub-list li > a",
  );
  const res: { url: string; label: string }[] = [];
  for (const a of anchors) {
    const href = (a.getAttribute("href") || "").trim();
    if (!href) continue;
    const full = href.startsWith("http") ? href : new URL(href, base).href;
    const label = (a.textContent || "").trim();
    if (!label) continue;
    // Bỏ mục "All tags" nếu có
    if (label.toLowerCase().includes("all tags")) continue;
    res.push({ url: full, label });
  }
  return res;
}

function parseViews(text: string): number {
  // Ví dụ text: "12 min 1pondo - 38.3M Views -"
  const withoutViews = text.replace(/Views?/gi, "").replace(/[-–—]/g, " ");
  const tokens = withoutViews.split(/\s+/).filter((t) => t.length > 0);
  for (let i = tokens.length - 1; i >= 0; i--) {
    const tok = tokens[i];
    const m = tok.match(/^([\d.,]+)\s*([kKmMbB])?$/);
    if (!m) continue;
    const num = parseFloat(m[1].replace(/,/g, ""));
    if (!isFinite(num)) continue;
    const unit = (m[2] || "").toLowerCase();
    if (unit === "k") return num * 1e3;
    if (unit === "m") return num * 1e6;
    if (unit === "b") return num * 1e9;
    return num;
  }
  return 0;
}

function parseDurationToMinutes(text: string): number {
  const t = text.trim().toLowerCase();
  if (!t) return 0;
  const m1 = t.match(/^(\d+)\s*min/);
  if (m1) return parseInt(m1[1], 10) || 0;
  const parts = t.split(":").map((p) => p.trim());
  if (parts.length === 2) {
    const mm = parseInt(parts[0], 10) || 0;
    const ss = parseInt(parts[1], 10) || 0;
    return mm + ss / 60;
  }
  if (parts.length === 3) {
    const hh = parseInt(parts[0], 10) || 0;
    const mm = parseInt(parts[1], 10) || 0;
    const ss = parseInt(parts[2], 10) || 0;
    return hh * 60 + mm + ss / 60;
  }
  const n = parseInt(t, 10);
  return Number.isFinite(n) ? n : 0;
}

function scanXvideosCategoryListPage(
  minViews: number,
  maxViews: number,
): {
  videos: { url: string; thumbnailUrl: string; views: number; durationMinutes: number }[];
  hasHighVideos: boolean;
  nextPageUrl: string | null;
  redirected?: boolean;
} {
  const base = `${window.location.protocol}//${window.location.host}`;
  const sortViewsLink = document.querySelector<HTMLAnchorElement>(
    '.niv2.search-filters .uls ul li a[href^="/c/s:views"]',
  );
  const hrefNow = window.location.href;
  const isSortedByViews =
    (sortViewsLink && sortViewsLink.classList.contains("current")) ||
    hrefNow.includes("/c/s:views") ||
    hrefNow.includes("views") ||
    hrefNow.includes("sort=views");
  if (!isSortedByViews && sortViewsLink?.href) {
    // Giả lập click tay vào nút sort theo views để site xử lý đúng logic
    sortViewsLink.click();
    return { videos: [], hasHighVideos: false, nextPageUrl: null, redirected: true };
  }

  const items = document.querySelectorAll<HTMLDivElement>(
    "div.frame-block.thumb-block",
  );
  const videos: {
    url: string;
    thumbnailUrl: string;
    views: number;
    durationMinutes: number;
  }[] = [];

  for (const item of items) {
    const aVideo = item.querySelector<HTMLAnchorElement>(
      '.thumb a[href*="/video."]',
    );
    if (!aVideo) continue;
    const href = (aVideo.getAttribute("href") || "").trim();
    if (!href) continue;
    const url = href.startsWith("http") ? href : new URL(href, base).href;

    const img = aVideo.querySelector<HTMLImageElement>("img");
    const thumbnailUrl = img?.src || "";

    const metadataP =
      item.querySelector<HTMLElement>(".thumb-under p.metadata");
    const viewsText = metadataP?.textContent || "";
    const views = parseViews(viewsText);

    const durationSpan = item.querySelector<HTMLElement>(
      ".thumb-under p.title span.duration",
    );
    const durationText = durationSpan?.textContent || "";
    const durationMinutes = parseDurationToMinutes(durationText);

    if (
      views >= minViews &&
      views < maxViews &&
      durationMinutes <= 30
    ) {
      videos.push({ url, thumbnailUrl, views, durationMinutes });
    }
  }

  const hasHighVideos = videos.length > 0;

  let nextPageUrl: string | null = null;
  const nextLink =
    document.querySelector<HTMLAnchorElement>(
      ".pagination ul li a.no-page.next-page",
    ) ||
    document.querySelector<HTMLAnchorElement>(
      ".pagination ul li a:not(.active)",
    );
  if (nextLink) {
    const nhref = (nextLink.getAttribute("href") || "").trim();
    if (nhref) {
      nextPageUrl = nhref.startsWith("http")
        ? nhref
        : new URL(nhref, base).href;
    }
  }

  return { videos, hasHighVideos, nextPageUrl };
}

function findStreamUrl(): string | null {
  // Trang demo: ô nhập URL hoặc dropdown - tìm input có giá trị giống URL m3u8
  const inputs = document.querySelectorAll<HTMLInputElement>(
    'input[type="text"], input[type="url"]',
  );
  for (const input of inputs) {
    const v = (input.value || "").trim();
    if (v && (v.includes(".m3u8") || v.includes("m3u8"))) return v;
  }
  // Thử lấy từ thẻ video (một số trang set src)
  const video = document.querySelector<HTMLVideoElement>("video");
  if (video?.src && (video.src.includes(".m3u8") || video.src.includes("m3u8")))
    return video.src;
  // Thử tìm link chứa m3u8
  const links = document.querySelectorAll<HTMLAnchorElement>('a[href*="m3u8"]');
  if (links.length) return (links[0].href || "").trim();
  return null;
}

function showInspectModal(report: string) {
  const overlay = document.createElement("div");
  overlay.id = "hls-inspect-overlay";
  Object.assign(overlay.style, {
    position: "fixed",
    inset: "0",
    zIndex: "2147483646",
    background: "rgba(0,0,0,0.6)",
    display: "flex",
    alignItems: "center",
    justifyContent: "center",
    padding: "20px",
  });
  const box = document.createElement("div");
  Object.assign(box.style, {
    background: "#1e1e1e",
    color: "#eee",
    maxWidth: "90vw",
    maxHeight: "85vh",
    borderRadius: "12px",
    padding: "16px",
    display: "flex",
    flexDirection: "column",
    boxShadow: "0 8px 32px rgba(0,0,0,0.5)",
  });
  const title = document.createElement("div");
  title.textContent = "🔍 Kết quả kiểm tra M3U8 (copy gửi developer)";
  Object.assign(title.style, {
    marginBottom: "8px",
    fontWeight: "600",
    fontSize: "14px",
  });
  const textarea = document.createElement("textarea");
  textarea.value = report;
  textarea.readOnly = true;
  Object.assign(textarea.style, {
    width: "min(600px, 85vw)",
    height: "320px",
    fontFamily: "monospace",
    fontSize: "12px",
    padding: "10px",
    background: "#2d2d2d",
    color: "#eee",
    border: "1px solid #444",
    borderRadius: "8px",
    resize: "vertical",
  });
  const row = document.createElement("div");
  Object.assign(row.style, {
    marginTop: "12px",
    display: "flex",
    gap: "8px",
    justifyContent: "flex-end",
  });
  const copyBtn = document.createElement("button");
  copyBtn.textContent = "Copy";
  Object.assign(copyBtn.style, {
    padding: "8px 16px",
    background: "#0d47a1",
    color: "#fff",
    border: "none",
    borderRadius: "8px",
    cursor: "pointer",
  });
  copyBtn.addEventListener("click", () => {
    textarea.select();
    document.execCommand("copy");
    copyBtn.textContent = "Đã copy!";
    setTimeout(() => (copyBtn.textContent = "Copy"), 1500);
  });
  const closeBtn = document.createElement("button");
  closeBtn.textContent = "Đóng";
  Object.assign(closeBtn.style, {
    padding: "8px 16px",
    background: "#444",
    color: "#fff",
    border: "none",
    borderRadius: "8px",
    cursor: "pointer",
  });
  closeBtn.addEventListener("click", () => overlay.remove());
  overlay.addEventListener("click", (e) => {
    if (e.target === overlay) overlay.remove();
  });
  row.append(copyBtn, closeBtn);
  box.append(title, textarea, row);
  overlay.appendChild(box);
  document.body.appendChild(overlay);
}

function formatInspectReport(data: Record<string, unknown>): string {
  const err = data.error as string | undefined;
  if (err) return `LỖI FETCH:\n${err}\n\nURL: ${data.inspectedUrl}`;
  const lines: string[] = [];
  lines.push("=== URL ===\n" + (data.inspectedUrl as string));
  lines.push("\n=== LOẠI PLAYLIST ===");
  lines.push("contentType: " + (data.contentType as string));
  const p = data.parsed as Record<string, unknown>;
  if (p) {
    lines.push("\n=== PARSED (playlist này) ===");
    lines.push("số segment: " + (p.segmentsCount as number));
    lines.push("có initSegment (fMP4): " + (p.initSegment as boolean));
    lines.push("có byte range: " + (p.hasByteRange as boolean));
    lines.push("số variant (master): " + (p.variantsCount as number));
    if (p.variantUrl as string)
      lines.push("variantUrl: " + (p.variantUrl as string));
  }
  if (data.variantParsed) {
    const v = data.variantParsed as Record<string, unknown>;
    lines.push("\n=== PARSED (variant đã fetch) ===");
    lines.push("số segment: " + (v.segmentsCount as number));
    lines.push("có initSegment: " + (v.initSegment as boolean));
    lines.push("có byte range: " + (v.hasByteRange as boolean));
  }
  lines.push("\n=== RAW (50 dòng đầu playlist) ===");
  lines.push((data.rawFirstLines as string) || "(rỗng)");
  if (data.variantRawFirstLines) {
    lines.push("\n=== RAW (50 dòng đầu variant) ===");
    lines.push(data.variantRawFirstLines as string);
  }
  return lines.join("\n");
}

function collectPageMetadata(): {
  sourceUrl: string;
  actors: string[];
  tags: string[];
  views?: string;
  duration?: string;
} {
  const sourceUrl = window.location.href;
  const hostname = window.location.hostname || "";

  let actors: string[] = [];
  let tags: string[] = [];
  let views: string | undefined;
  let duration: string | undefined;

  if (hostname.includes("xvideos.com")) {
    actors = Array.from(
      document.querySelectorAll<HTMLElement>("li.model span.name"),
    )
      .map((el) => (el.textContent || "").trim())
      .filter((v) => v.length > 0);
    tags = Array.from(
      document.querySelectorAll<HTMLAnchorElement>(
        'a.is-keyword.btn.btn-default[href^="/tags/"]',
      ),
    )
      .map((el) => (el.textContent || "").trim())
      .filter((v) => v.length > 0);
    const viewsEl = document.querySelector<HTMLElement>(
      "#v-views strong.mobile-hide",
    );
    if (viewsEl) {
      const raw = (viewsEl.textContent || "").trim().replace(/,/g, "");
      if (raw) views = raw;
    }
    // Trang detail: <span class="duration">8 min</span> — ưu tiên trong #main trước
    const main = document.querySelector("#main, main");
    const scope = main || document;
    const durationSpans = scope.querySelectorAll<HTMLElement>("span.duration");
    for (const el of durationSpans) {
      const raw = (el.textContent || "").trim();
      if (raw) {
        duration = raw;
        break;
      }
    }
  }

  return { sourceUrl, actors, tags, views, duration };
}

/** Item: url trang video + thumbnail từ img trong thẻ a (để server tải ảnh và lưu path). */
type VideoPageItem = { url: string; thumbnailUrl?: string };

/** Quét trang hiện tại lấy danh sách link tới page chứa video + thumbnail (theo từng site). */
function collectVideoPageLinks(): VideoPageItem[] {
  const hostname = window.location.hostname || "";
  const base = `${window.location.protocol}//${window.location.host}`;
  const seen = new Map<string, string>(); // url canonical -> thumbnailUrl

  if (hostname.includes("xvideos.com")) {
    const links = document.querySelectorAll<HTMLAnchorElement>(
      'a[href*="/video."]',
    );
    for (const a of links) {
      const href = (a.getAttribute("href") || "").trim();
      if (!href) continue;
      const full = href.startsWith("http") ? href : new URL(href, base).href;
      try {
        const u = new URL(full);
        if (
          u.hostname.includes("xvideos.com") &&
          u.pathname.includes("/video.")
        ) {
          const canonical = u.origin + u.pathname;
          const img = a.querySelector("img");
          const thumb = img?.getAttribute("src")?.trim();
          if (thumb && !seen.has(canonical)) seen.set(canonical, thumb);
          else if (!seen.has(canonical)) seen.set(canonical, "");
        }
      } catch {
        // skip invalid
      }
    }
  }
  return Array.from(seen.entries()).map(([url, thumbnailUrl]) => ({
    url,
    thumbnailUrl: thumbnailUrl || undefined,
  }));
}

function injectDownloadButton() {
  const wrap = document.createElement("div");
  wrap.id = "hls-download-extension-wrap";
  Object.assign(wrap.style, {
    position: "fixed",
    bottom: "24px",
    right: "24px",
    zIndex: "2147483647",
    display: "flex",
    flexDirection: "column",
    gap: "8px",
  });
  const btn = document.createElement("button");
  btn.textContent = "⬇ Download HLS";
  btn.id = "hls-download-extension-btn";
  Object.assign(btn.style, {
    padding: "10px 16px",
    fontSize: "14px",
    fontWeight: "600",
    color: "#fff",
    background: "linear-gradient(135deg, #1a73e8 0%, #0d47a1 100%)",
    border: "none",
    borderRadius: "8px",
    cursor: "pointer",
    boxShadow: "0 4px 12px rgba(0,0,0,0.3)",
  });
  btn.addEventListener("click", async () => {
    let url: string | null = null;
    try {
      url = (await browser.runtime.sendMessage({ type: "GET_LAST_M3U8" })) as
        | string
        | null;
    } catch {
      // ignore
    }
    if (!url) url = findStreamUrl();
    if (!url) {
      const custom = window.prompt(
        "Không tìm thấy M3U8 trên trang. Dán URL stream M3U8 (lấy từ DevTools → Network, lọc m3u8):",
      );
      if (!custom?.trim()) return;
      url = custom.trim();
    }
    await startDownload(url);
  });
  const inspectBtn = document.createElement("button");
  inspectBtn.textContent = "🔍 Kiểm tra M3U8";
  Object.assign(inspectBtn.style, {
    padding: "8px 14px",
    fontSize: "13px",
    color: "#fff",
    background: "#333",
    border: "none",
    borderRadius: "8px",
    cursor: "pointer",
  });
  inspectBtn.addEventListener("click", async () => {
    let url: string | null = null;
    try {
      url = (await browser.runtime.sendMessage({ type: "GET_LAST_M3U8" })) as
        | string
        | null;
    } catch {
      // ignore
    }
    if (!url) url = findStreamUrl();
    if (!url) {
      const custom = window.prompt(
        "Chưa bắt được M3U8. Dán URL M3U8 (hoặc để trống nếu trang đang phát video):",
      );
      if (custom === null) return;
      url = (custom || "").trim();
    }
    if (!url) {
      alert(
        "Không có URL để kiểm tra. Mở video rồi bấm lại, hoặc dán URL M3U8.",
      );
      return;
    }
    inspectBtn.textContent = "⏳ Đang kiểm tra...";
    try {
      const result = (await browser.runtime.sendMessage({
        type: "INSPECT_M3U8",
        url,
      })) as Record<string, unknown>;
      const report = formatInspectReport(result);
      showInspectModal(report);
    } catch (e) {
      showInspectModal("LỖI: " + (e instanceof Error ? e.message : String(e)));
    } finally {
      inspectBtn.textContent = "🔍 Kiểm tra M3U8";
    }
  });
  const batchBtn = document.createElement("button");
  batchBtn.textContent = "📋 Quét và tải hàng loạt";
  Object.assign(batchBtn.style, {
    padding: "8px 14px",
    fontSize: "13px",
    color: "#fff",
    background: "#0d47a1",
    border: "none",
    borderRadius: "8px",
    cursor: "pointer",
  });
  batchBtn.addEventListener("click", async () => {
    const items = collectVideoPageLinks();
    if (!items.length) {
      alert(
        "Không tìm thấy link video trên trang này. Mở trang danh sách (vd: category/search) rồi thử lại.",
      );
      return;
    }
    const prevText = batchBtn.textContent;
    batchBtn.textContent = "Đang xử lý...";
    batchBtn.disabled = true;
    try {
      const res = (await browser.runtime.sendMessage({
        type: "BATCH_QUEUE_URLS",
        items,
      })) as
        | { ok: boolean; total: number; queued: number; skipped?: number }
        | undefined;
      if (res?.ok) {
        if (res.queued === 0 && (res.totalInQueue ?? 0) === 0) {
          alert(
            res.total > 0
              ? `Đã quét ${res.total} link nhưng không có video mới (đã có trong metadata).`
              : "Không có link video.",
          );
        } else {
          const totalInQueue =
            typeof res.totalInQueue === "number" ? res.totalInQueue : res.queued;
          const msg =
            res.queued === 0
              ? `Hàng đợi: ${totalInQueue} link (trang này không thêm mới).`
              : res.skipped && res.skipped > 0
                ? `Đã thêm ${res.queued} link. Tổng hàng đợi: ${totalInQueue}. Đang mở tab...`
                : `Đã thêm ${res.queued} link. Tổng hàng đợi: ${totalInQueue}. Đang mở tab...`;
          batchBtn.textContent = msg;
          setTimeout(() => {
            batchBtn.textContent = prevText;
            batchBtn.disabled = false;
          }, 3000);
          return;
        }
      }
    } catch (e) {
      console.error("BATCH_QUEUE_URLS:", e);
      alert(
        "Lỗi: " +
          (e instanceof Error ? e.message : String(e)) +
          "\n\nKiểm tra: 1) Extension đã reload chưa. 2) Đã chạy npm run download-server chưa.",
      );
    }
    batchBtn.textContent = prevText;
    batchBtn.disabled = false;
  });
  wrap.appendChild(btn);
  wrap.appendChild(inspectBtn);
  wrap.appendChild(batchBtn);
  document.body.appendChild(wrap);
}

async function startDownload(m3u8Url: string) {
  const btn = document.getElementById("hls-download-extension-btn");
  if (btn) {
    (btn as HTMLButtonElement).disabled = true;
    (btn as HTMLButtonElement).textContent = "⏳ Đang tải...";
  }
  try {
    const meta = collectPageMetadata();
    const ok = await browser.runtime.sendMessage({
      type: "DOWNLOAD_HLS",
      url: m3u8Url,
      pageTitle: document.title || "",
      meta,
    });
    if (!ok && ok !== undefined) {
      const err = await browser.runtime.sendMessage({ type: "GET_LAST_ERROR" });
      alert(err || "Không thể tải. Kiểm tra URL và quyền extension.");
    }
  } catch (e) {
    console.error("HLS download error:", e);
    alert("Lỗi: " + (e instanceof Error ? e.message : String(e)));
  } finally {
    if (btn) {
      (btn as HTMLButtonElement).disabled = false;
      (btn as HTMLButtonElement).textContent = "⬇ Download HLS";
    }
  }
}

const BATCH_M3U8_RETRY_MS = 3000;
const BATCH_M3U8_MAX_ATTEMPTS = 5;

/** Gọi từ batch: trả về true nếu bắt đầu tải thành công, false nếu thất bại (không alert). Có retry vì player có thể chưa request M3U8 ngay. */
async function runDownloadForBatch(): Promise<boolean> {
  let url: string | null = null;
  for (let attempt = 0; attempt < BATCH_M3U8_MAX_ATTEMPTS; attempt++) {
    try {
      url = (await browser.runtime.sendMessage({ type: "GET_LAST_M3U8" })) as
        | string
        | null;
    } catch {
      // ignore
    }
    if (!url) url = findStreamUrl();
    if (url) break;
    if (attempt < BATCH_M3U8_MAX_ATTEMPTS - 1) {
      await new Promise((r) => setTimeout(r, BATCH_M3U8_RETRY_MS));
    }
  }
  if (!url) return false;
  try {
    const meta = collectPageMetadata();
    const ok = await browser.runtime.sendMessage({
      type: "DOWNLOAD_HLS",
      url,
      pageTitle: document.title || "",
      meta,
    });
    return ok === true;
  } catch {
    return false;
  }
}
