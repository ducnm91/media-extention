#!/usr/bin/env node
/**
 * Server nhận video từ extension: gộp segments → 1 file .mp4, lưu vào thư mục download trong project.
 * Không lưu lại các file segment (chỉ dùng tạm rồi xóa).
 *
 * Chạy: npm run download-server
 * Thư mục lưu .mp4: download/ trong project. Có thể đổi bằng env DOWNLOAD_DIR.
 * API:
 *   POST /segment  body=bytes, header X-Session-Id, X-Index, X-Total  → tạm lưu segment
 *   POST /finish   header X-Session-Id  → gộp + convert → .mp4 vào download/, xóa folder segments
 *   POST /save     body=.ts đã gộp  → convert → .mp4 vào download/ (fallback)
 */
const http = require("http");
const fs = require("fs");
const path = require("path");
const os = require("os");
const { spawn, execSync } = require("child_process");

const PORT = 8765;
const ROOT = path.join(__dirname, "..");
const OUTPUT_DIR = process.env.DOWNLOAD_DIR || path.join(ROOT, "download");
const TEMP_DIR = path.join(os.tmpdir(), "hls-extension-download");

if (!fs.existsSync(OUTPUT_DIR)) {
  fs.mkdirSync(OUTPUT_DIR, { recursive: true });
}
if (!fs.existsSync(TEMP_DIR)) {
  fs.mkdirSync(TEMP_DIR, { recursive: true });
}

const FFMPEG_CANDIDATES = [
  "/opt/homebrew/bin/ffmpeg",
  "/usr/local/bin/ffmpeg",
  "ffmpeg",
];

function getFfmpegPath() {
  for (const p of FFMPEG_CANDIDATES) {
    if (p === "ffmpeg") return p;
    try {
      if (fs.existsSync(p)) return p;
    } catch {
      // ignore
    }
  }
  try {
    const which = execSync("which ffmpeg", {
      encoding: "utf8",
      env: {
        ...process.env,
        PATH:
          process.env.PATH || "/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin",
      },
    })
      .trim()
      .split("\n")[0];
    if (which) return which;
  } catch {
    // ignore
  }
  return "ffmpeg";
}

const FFMPEG_PATH = getFfmpegPath();

function runFfmpegSingle(inputPath, outputPath) {
  return new Promise((resolve, reject) => {
    const ff = spawn(
      FFMPEG_PATH,
      ["-y", "-i", inputPath, "-c", "copy", outputPath],
      { stdio: "pipe" },
    );
    ff.on("error", (e) => {
      if (e.code === "ENOENT") {
        reject(new Error("FFmpeg chưa cài. Trên macOS: brew install ffmpeg"));
      } else reject(e);
    });
    let err = "";
    ff.stderr.on("data", (d) => (err += d.toString()));
    ff.on("close", (code) => {
      if (code === 0) resolve();
      else reject(new Error(err || `ffmpeg exit ${code}`));
    });
  });
}

function runFfmpegConcat(segmentDir, listFile, outputPathAbsolute) {
  return new Promise((resolve, reject) => {
    const ff = spawn(
      FFMPEG_PATH,
      [
        "-y",
        "-f",
        "concat",
        "-safe",
        "0",
        "-i",
        listFile,
        "-c",
        "copy",
        outputPathAbsolute,
      ],
      { stdio: "pipe", cwd: segmentDir },
    );
    ff.on("error", (e) => {
      if (e.code === "ENOENT") {
        reject(new Error("FFmpeg chưa cài. Trên macOS: brew install ffmpeg"));
      } else reject(e);
    });
    let err = "";
    ff.stderr.on("data", (d) => (err += d.toString()));
    ff.on("close", (code) => {
      if (code === 0) resolve();
      else reject(new Error(err || `ffmpeg exit ${code}`));
    });
  });
}

const server = http.createServer((req, res) => {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "POST, OPTIONS");
  res.setHeader(
    "Access-Control-Allow-Headers",
    "X-Session-Id, X-Index, X-Total, X-Filename, Content-Type",
  );

  if (req.method === "OPTIONS") {
    res.writeHead(204);
    res.end();
    return;
  }

  const urlPath = req.url?.split("?")[0] || "";

  if (req.method === "POST" && urlPath === "/segment") {
    const sessionId = (req.headers["x-session-id"] || "").replace(
      /[^a-zA-Z0-9._-]/g,
      "_",
    );
    const index = parseInt(req.headers["x-index"], 10);
    const total = parseInt(req.headers["x-total"], 10);
    if (!sessionId || isNaN(index) || isNaN(total) || index < 0 || total < 1) {
      res.writeHead(400, { "Content-Type": "application/json" });
      res.end(
        JSON.stringify({ error: "Missing X-Session-Id, X-Index, X-Total" }),
      );
      return;
    }
    const segmentDir = path.join(TEMP_DIR, sessionId);
    const chunks = [];
    req.on("data", (c) => chunks.push(c));
    req.on("end", () => {
      try {
        if (!fs.existsSync(segmentDir)) {
          fs.mkdirSync(segmentDir, { recursive: true });
        }
        const outPath = path.join(
          segmentDir,
          `segment_${String(index).padStart(5, "0")}.ts`,
        );
        const body = Buffer.concat(chunks);
        fs.writeFileSync(outPath, body);
        console.log(
          `[segment] ${sessionId} segment_${String(index).padStart(5, "0")}.ts ${body.length} bytes`,
        );
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ ok: true, index }));
      } catch (e) {
        console.error(e);
        res.writeHead(500, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: e.message || "Write failed" }));
      }
    });
    req.on("error", () => {
      res.writeHead(500, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: "Request error" }));
    });
    return;
  }

  if (req.method === "POST" && urlPath === "/finish") {
    const sessionId = (req.headers["x-session-id"] || "").replace(
      /[^a-zA-Z0-9._-]/g,
      "_",
    );
    if (!sessionId) {
      res.writeHead(400, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: "Missing X-Session-Id" }));
      return;
    }
    const segmentDir = path.join(TEMP_DIR, sessionId);
    const mp4Path = path.join(OUTPUT_DIR, sessionId + ".mp4");
    const listPath = path.join(segmentDir, "list.txt");

    const chunks = [];
    req.on("data", (c) => chunks.push(c));
    req.on("end", async () => {
      try {
        if (!fs.existsSync(segmentDir)) {
          console.error("[finish] No folder:", segmentDir);
          res.writeHead(400, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ error: "No segments found for session" }));
          return;
        }
        const files = fs
          .readdirSync(segmentDir)
          .filter((f) => f.startsWith("segment_") && f.endsWith(".ts"));
        files.sort();
        console.log("[finish]", sessionId, "files:", files.length);
        const listLines = files.map((f) => `file '${f}'`).join("\n");
        fs.writeFileSync(listPath, listLines, "utf8");
        const outputRelative = path.relative(segmentDir, mp4Path);
        await runFfmpegConcat(segmentDir, "list.txt", outputRelative);
        try {
          fs.unlinkSync(listPath);
        } catch {
          // ignore
        }
        // Xóa folder segments (không giữ lại)
        try {
          for (const f of fs.readdirSync(segmentDir)) {
            fs.unlinkSync(path.join(segmentDir, f));
          }
          fs.rmdirSync(segmentDir);
        } catch (e) {
          console.warn("[finish] Xóa folder tạm:", e.message);
        }

        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(
          JSON.stringify({
            ok: true,
            mp4: sessionId + ".mp4",
            path: mp4Path,
          }),
        );
      } catch (e) {
        console.error(e.message || e);
        res.writeHead(500, { "Content-Type": "application/json" });
        res.end(
          JSON.stringify({ ok: false, error: e.message || "Convert failed" }),
        );
      }
    });
    req.on("error", () => {
      res.writeHead(500, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: "Request error" }));
    });
    return;
  }

  if (req.method === "POST" && urlPath === "/save") {
    const filename = req.headers["x-filename"] || `hls-${Date.now()}.ts`;
    const safeName = path
      .basename(String(filename))
      .replace(/[^a-zA-Z0-9._-]/g, "_");
    const tsPath = path.join(TEMP_DIR, safeName);
    const mp4Name = safeName.replace(/\.ts$/i, ".mp4");
    const mp4Path = path.join(OUTPUT_DIR, mp4Name);
    const chunks = [];
    req.on("data", (c) => chunks.push(c));
    req.on("end", async () => {
      try {
        const body = Buffer.concat(chunks);
        fs.writeFileSync(tsPath, body);
        await runFfmpegSingle(tsPath, mp4Path);
        try {
          fs.unlinkSync(tsPath);
        } catch {
          // ignore
        }
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ ok: true, mp4: mp4Name, path: mp4Path }));
      } catch (e) {
        console.error(e.message || e);
        res.writeHead(500, { "Content-Type": "application/json" });
        res.end(
          JSON.stringify({ ok: false, error: e.message || "Convert failed" }),
        );
      }
    });
    req.on("error", () => {
      res.writeHead(500, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: "Request error" }));
    });
    return;
  }

  res.writeHead(404, { "Content-Type": "application/json" });
  res.end(JSON.stringify({ error: "POST /segment, /finish or /save only" }));
});

server.listen(PORT, () => {
  console.log(`Download server: http://localhost:${PORT}`);
  console.log("  POST /segment  → tạm lưu segment");
  console.log("  POST /finish   → gộp → .mp4 rồi xóa segments");
  console.log("  POST /save     → gửi .ts đã gộp → convert → .mp4 (fallback)");
  console.log("Thư mục lưu .mp4:", OUTPUT_DIR);
  const check = spawn(FFMPEG_PATH, ["-version"], { stdio: "ignore" });
  check.on("error", () => {
    console.warn("\n⚠ Không tìm thấy FFmpeg. Cài: brew install ffmpeg\n");
  });
  check.on("close", (code) => {
    if (code === 0) console.log("FFmpeg:", FFMPEG_PATH);
  });
});
