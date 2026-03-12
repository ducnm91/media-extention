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
  wrap.appendChild(btn);
  wrap.appendChild(inspectBtn);
  document.body.appendChild(wrap);
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
      pageTitle: document.title || "",
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
