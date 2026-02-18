#!/usr/bin/env node
/**
 * Server nhận video từ extension: lưu từng segment HLS vào 1 folder, gộp và convert sang MP4.
 * File .mp4 lưu ngang cấp với folder chứa segments. Folder segments được giữ lại.
 *
 * Chạy: npm run download-server
 * API:
 *   POST /segment  body=bytes, header X-Session-Id, X-Index, X-Total  → lưu vào download/<sessionId>/segment_<index>.ts
 *   POST /finish   header X-Session-Id  → gộp + convert → download/<sessionId>.mp4
 */
const http = require("http");
const fs = require("fs");
const path = require("path");
const { spawn, execSync } = require("child_process");

const PORT = 8765;
const ROOT = path.join(__dirname, "..");
const DOWNLOAD_DIR = path.join(ROOT, "download");

if (!fs.existsSync(DOWNLOAD_DIR)) {
  fs.mkdirSync(DOWNLOAD_DIR, { recursive: true });
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
    const segmentDir = path.join(DOWNLOAD_DIR, sessionId);
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
    const segmentDir = path.join(DOWNLOAD_DIR, sessionId);
    const mp4Path = path.join(DOWNLOAD_DIR, sessionId + ".mp4");
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
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ ok: true, mp4: sessionId + ".mp4" }));
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
    const tsPath = path.join(DOWNLOAD_DIR, safeName);
    const mp4Path = tsPath.replace(/\.ts$/i, ".mp4");
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
        res.end(JSON.stringify({ ok: true, mp4: path.basename(mp4Path) }));
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
  console.log("  POST /segment  → lưu từng segment vào download/<sessionId>/");
  console.log("  POST /finish    → gộp + convert → download/<sessionId>.mp4");
  console.log("  POST /save      → gửi 1 file .ts → convert → .mp4 (fallback)");
  console.log("Thư mục gốc:", DOWNLOAD_DIR);
  const check = spawn(FFMPEG_PATH, ["-version"], { stdio: "ignore" });
  check.on("error", () => {
    console.warn("\n⚠ Không tìm thấy FFmpeg. Cài: brew install ffmpeg\n");
  });
  check.on("close", (code) => {
    if (code === 0) console.log("FFmpeg:", FFMPEG_PATH);
  });
});
