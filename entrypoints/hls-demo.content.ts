export default defineContentScript({
  matches: ["*://hlsjs.video-dev.org/*"],
  allFrames: false,
  main() {
    injectDownloadButton();
    setupDownloadReadyListener();
  },
});

let downloadChunksByIndex: (ArrayBuffer | null)[] = [];
let downloadFilename = "";
let downloadTotalChunks = 0;

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
          alert(
            `Lỗi tải video (thiếu dữ liệu: ${ready}/${total}). Thử lại hoặc chọn stream khác.`,
          );
        };
        setTimeout(tryBuild, 500);
      }
    },
  );
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

function injectDownloadButton() {
  const btn = document.createElement("button");
  btn.textContent = "⬇ Download HLS";
  btn.id = "hls-download-extension-btn";
  Object.assign(btn.style, {
    position: "fixed",
    bottom: "24px",
    right: "24px",
    zIndex: "2147483647",
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
    const url = findStreamUrl();
    if (!url) {
      const custom = window.prompt(
        "Dán URL stream M3U8 (từ ô nhập hoặc dropdown trên trang):",
      );
      if (!custom?.trim()) return;
      await startDownload(custom.trim());
      return;
    }
    await startDownload(url);
  });
  document.body.appendChild(btn);
}

async function startDownload(m3u8Url: string) {
  const btn = document.getElementById("hls-download-extension-btn");
  if (btn) {
    (btn as HTMLButtonElement).disabled = true;
    (btn as HTMLButtonElement).textContent = "⏳ Đang tải...";
  }
  try {
    const ok = await browser.runtime.sendMessage({
      type: "DOWNLOAD_HLS",
      url: m3u8Url,
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
