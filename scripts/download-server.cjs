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
const https = require("https");
const fs = require("fs");
const path = require("path");
const os = require("os");
const crypto = require("crypto");
const { spawn, execSync } = require("child_process");

const PORT = 8765;
const ROOT = path.join(__dirname, "..");
const OUTPUT_DIR = process.env.DOWNLOAD_DIR || path.join(ROOT, "download");
const META_FILE = path.join(OUTPUT_DIR, "videos-metadata.jsonl");
const THUMBNAILS_DIR = path.join(OUTPUT_DIR, "thumbnails");
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
const SEEN_SOURCE_URLS = new Set();
/** sourceUrl (đã chuẩn hóa) có trong metadata nhưng thiếu thumbnailPath hoặc views → cần cập nhật bổ sung */
const NEEDS_UPDATE_SOURCE_URLS = new Set();

/** Chuẩn hóa URL để so sánh "cùng video": chỉ dùng origin + pathname (bỏ query, hash). */
function normalizeSourceUrl(url) {
  if (!url || typeof url !== "string") return "";
  const s = url.trim();
  if (!s) return "";
  try {
    const u = new URL(s);
    return u.origin + u.pathname;
  } catch {
    return s;
  }
}

try {
  if (fs.existsSync(META_FILE)) {
    const content = fs.readFileSync(META_FILE, "utf8");
    for (const line of content.split(/\r?\n/)) {
      const trimmed = line.trim();
      if (!trimmed) continue;
      try {
        const obj = JSON.parse(trimmed);
        if (obj && typeof obj.sourceUrl === "string" && obj.sourceUrl) {
          const key = normalizeSourceUrl(obj.sourceUrl);
          if (key) {
            SEEN_SOURCE_URLS.add(key);
            const hasThumb = obj.thumbnailPath != null && String(obj.thumbnailPath).trim() !== "";
            const hasViews = obj.views != null && String(obj.views).trim() !== "";
            const hasDuration = obj.duration != null && String(obj.duration).trim() !== "";
            if (!hasThumb || !hasViews || !hasDuration) NEEDS_UPDATE_SOURCE_URLS.add(key);
          }
        }
      } catch {
        // ignore malformed line
      }
    }
  }
} catch (e) {
  console.warn("[meta] init failed:", e.message || e);
}

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

/** Re-encode sang H.264 + AAC để tránh crash khi mở (HEVC/codec lạ). Dùng khi FORCE_COMPATIBLE_MP4=1 */
function runFfmpegReencode(inputPath, outputPath) {
  return new Promise((resolve, reject) => {
    const ff = spawn(
      FFMPEG_PATH,
      [
        "-y",
        "-i",
        inputPath,
        "-c:v",
        "libx264",
        "-preset",
        "fast",
        "-crf",
        "23",
        "-c:a",
        "aac",
        "-b:a",
        "128k",
        outputPath,
      ],
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

const FORCE_COMPATIBLE_MP4 =
  process.env.FORCE_COMPATIBLE_MP4 === "1" ||
  process.env.FORCE_COMPATIBLE_MP4 === "true";

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

function parseJsonArrayHeader(req, name) {
  const raw = req.headers[name.toLowerCase()] || req.headers[name] || "";
  if (!raw) return [];
  try {
    const v = JSON.parse(String(raw));
    if (Array.isArray(v)) return v.map((x) => String(x));
  } catch {
    // ignore
  }
  return [];
}

/** Tải ảnh từ URL và lưu vào file. Trả về path tương đối từ ROOT hoặc null nếu lỗi. */
function downloadThumbnailToFile(thumbnailUrl, destPathAbsolute) {
  return new Promise((resolve) => {
    if (!thumbnailUrl || typeof thumbnailUrl !== "string") {
      resolve(null);
      return;
    }
    const protocol = thumbnailUrl.startsWith("https") ? https : http;
    const req = protocol.get(thumbnailUrl, { timeout: 15000 }, (res) => {
      if (res.statusCode === 301 || res.statusCode === 302) {
        const loc = res.headers.location;
        if (loc) {
          downloadThumbnailToFile(loc, destPathAbsolute).then(resolve);
          return;
        }
      }
      if (res.statusCode !== 200) {
        resolve(null);
        return;
      }
      const dir = path.dirname(destPathAbsolute);
      if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
      const file = fs.createWriteStream(destPathAbsolute);
      res.pipe(file);
      file.on("finish", () => {
        file.close();
        resolve(destPathAbsolute);
      });
      file.on("error", () => {
        try {
          fs.unlinkSync(destPathAbsolute);
        } catch {}
        resolve(null);
      });
    });
    req.on("error", () => resolve(null));
    req.on("timeout", () => {
      req.destroy();
      resolve(null);
    });
  });
}

function appendMetadata(record) {
  try {
    const key = record.sourceUrl ? normalizeSourceUrl(record.sourceUrl) : "";
    if (key && SEEN_SOURCE_URLS.has(key)) {
      return;
    }
    const line = JSON.stringify(record);
    fs.appendFileSync(META_FILE, line + "\n", "utf8");
    if (key) SEEN_SOURCE_URLS.add(key);
  } catch (e) {
    console.warn("[meta] append failed:", e.message || e);
  }
}

const server = http.createServer((req, res) => {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "POST, OPTIONS");
  res.setHeader(
    "Access-Control-Allow-Headers",
    "X-Session-Id, X-Index, X-Total, X-Filename, X-Source-Url, X-Page-Title, X-Actors, X-Tags, X-Thumbnail-Url, X-Views, X-Duration, Content-Type",
  );

  if (req.method === "OPTIONS") {
    res.writeHead(204);
    res.end();
    return;
  }

  const urlPath = req.url?.split("?")[0] || "";

  if (req.method === "POST" && urlPath === "/filter-source-urls") {
    const chunks = [];
    req.on("data", (c) => chunks.push(c));
    req.on("end", () => {
      try {
        const body = Buffer.concat(chunks).toString("utf8");
        const data = JSON.parse(body);
        const urls = Array.isArray(data?.urls)
          ? data.urls.map((u) => String(u)).filter(Boolean)
          : [];
        const filtered = urls.filter((u) => !SEEN_SOURCE_URLS.has(normalizeSourceUrl(u)));
        const updateUrls = urls.filter((u) => NEEDS_UPDATE_SOURCE_URLS.has(normalizeSourceUrl(u)));
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ urls: filtered, updateUrls }));
      } catch (e) {
        res.writeHead(400, { "Content-Type": "application/json" });
        res.end(
          JSON.stringify({ error: (e && e.message) || "Bad request" }),
        );
      }
    });
    return;
  }

  if (req.method === "POST" && urlPath === "/update-metadata") {
    const chunks = [];
    req.on("data", (c) => chunks.push(c));
    req.on("end", async () => {
      try {
        const body = Buffer.concat(chunks).toString("utf8");
        const data = JSON.parse(body);
        const sourceUrl = data && typeof data.sourceUrl === "string" ? data.sourceUrl.trim() : "";
        const thumbnailUrl = data && typeof data.thumbnailUrl === "string" ? data.thumbnailUrl.trim() : "";
        const views = data && (data.views != null) ? String(data.views).trim() : "";
        const duration = data && (data.duration != null) ? String(data.duration).trim() : "";
        if (!sourceUrl) {
          res.writeHead(400, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ error: "Missing sourceUrl" }));
          return;
        }
        if (!fs.existsSync(META_FILE)) {
          res.writeHead(200, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ ok: true }));
          return;
        }
        const content = fs.readFileSync(META_FILE, "utf8");
        const lines = content.split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
        let found = false;
        const out = [];
        for (const line of lines) {
          let obj;
          try {
            obj = JSON.parse(line);
          } catch {
            out.push(line);
            continue;
          }
          const norm = normalizeSourceUrl(obj.sourceUrl);
          if (norm !== normalizeSourceUrl(sourceUrl)) {
            out.push(line);
            continue;
          }
          found = true;
          if (thumbnailUrl) {
            const id = obj.id || crypto.createHash("sha1").update(sourceUrl).digest("hex").slice(0, 16);
            const thumbPath = path.join(THUMBNAILS_DIR, id + ".jpg");
            const downloaded = await downloadThumbnailToFile(thumbnailUrl, thumbPath);
            if (downloaded) obj.thumbnailPath = path.relative(ROOT, downloaded);
          }
          if (views !== "") obj.views = views;
          if (duration !== "") obj.duration = duration;
          out.push(JSON.stringify(obj));
          if (norm) {
            const hasThumb = obj.thumbnailPath != null && String(obj.thumbnailPath).trim() !== "";
            const hasViews = obj.views != null && String(obj.views).trim() !== "";
            const hasDuration = obj.duration != null && String(obj.duration).trim() !== "";
            if (hasThumb && hasViews && hasDuration) {
              NEEDS_UPDATE_SOURCE_URLS.delete(norm);
            } else {
              NEEDS_UPDATE_SOURCE_URLS.add(norm);
            }
          }
        }
        if (found) {
          fs.writeFileSync(META_FILE, out.join("\n") + (out.length ? "\n" : ""), "utf8");
        }
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ ok: true, updated: found }));
      } catch (e) {
        console.warn("[update-metadata]", e.message || e);
        res.writeHead(500, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: (e && e.message) || "Update failed" }));
      }
    });
    return;
  }

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
        await runFfmpegConcat(segmentDir, "list.txt", path.resolve(mp4Path));
        try {
          fs.unlinkSync(listPath);
        } catch {
          // ignore
        }
        if (FORCE_COMPATIBLE_MP4) {
          const compatPath = path.join(
            TEMP_DIR,
            "compat-" + sessionId + ".mp4",
          );
          await runFfmpegReencode(mp4Path, compatPath);
          try {
            fs.unlinkSync(mp4Path);
            fs.renameSync(compatPath, mp4Path);
          } catch (e) {
            console.warn("[finish] Re-encode replace:", e.message);
          }
        }
        // Ghi metadata JSONL
        const sourceUrl = String(req.headers["x-source-url"] || "");
        const pageTitle = String(req.headers["x-page-title"] || "");
        const actors = parseJsonArrayHeader(req, "x-actors");
        const tags = parseJsonArrayHeader(req, "x-tags");
        const idSource = sourceUrl || sessionId;
        const id = crypto
          .createHash("sha1")
          .update(String(idSource))
          .digest("hex")
          .slice(0, 16);
        const thumbnailUrl = String(req.headers["x-thumbnail-url"] || "").trim();
        const viewsRaw = String(req.headers["x-views"] || "").trim();
        const views = viewsRaw ? viewsRaw : undefined;
        const durationRaw = String(req.headers["x-duration"] || "").trim();
        const duration = durationRaw || undefined;
        let thumbnailPathRel;
        if (thumbnailUrl) {
          const thumbPath = path.join(THUMBNAILS_DIR, id + ".jpg");
          const downloaded = await downloadThumbnailToFile(
            thumbnailUrl,
            thumbPath,
          );
          if (downloaded)
            thumbnailPathRel = path.relative(ROOT, downloaded);
        }
        appendMetadata({
          id,
          title: pageTitle || "",
          fileName: path.basename(mp4Path),
          filePath: path.relative(ROOT, mp4Path),
          sourceUrl,
          actors,
          tags,
          ...(thumbnailPathRel ? { thumbnailPath: thumbnailPathRel } : {}),
          ...(views !== undefined ? { views } : {}),
          ...(duration !== undefined ? { duration } : {}),
        });

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
        if (FORCE_COMPATIBLE_MP4) {
          const compatPath = path.join(
            TEMP_DIR,
            "compat-save-" + safeName + ".mp4",
          );
          await runFfmpegReencode(mp4Path, compatPath);
          try {
            fs.unlinkSync(mp4Path);
            fs.renameSync(compatPath, mp4Path);
          } catch (e) {
            console.warn("[save] Re-encode replace:", e.message);
          }
        }
        const sourceUrl = String(req.headers["x-source-url"] || "");
        const pageTitle = String(req.headers["x-page-title"] || "");
        const actors = parseJsonArrayHeader(req, "x-actors");
        const tags = parseJsonArrayHeader(req, "x-tags");
        const thumbnailUrl = String(req.headers["x-thumbnail-url"] || "").trim();
        const viewsRaw = String(req.headers["x-views"] || "").trim();
        const views = viewsRaw ? viewsRaw : undefined;
        const durationRaw = String(req.headers["x-duration"] || "").trim();
        const duration = durationRaw || undefined;
        const idSource = sourceUrl || mp4Name;
        const id = crypto
          .createHash("sha1")
          .update(String(idSource))
          .digest("hex")
          .slice(0, 16);
        let thumbnailPathRel;
        if (thumbnailUrl) {
          const thumbPath = path.join(THUMBNAILS_DIR, id + ".jpg");
          const downloaded = await downloadThumbnailToFile(
            thumbnailUrl,
            thumbPath,
          );
          if (downloaded)
            thumbnailPathRel = path.relative(ROOT, downloaded);
        }
        appendMetadata({
          id,
          title: pageTitle || "",
          fileName: mp4Name,
          filePath: path.relative(ROOT, mp4Path),
          sourceUrl,
          actors,
          tags,
          ...(thumbnailPathRel ? { thumbnailPath: thumbnailPathRel } : {}),
          ...(views !== undefined ? { views } : {}),
          ...(duration !== undefined ? { duration } : {}),
        });

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
  if (FORCE_COMPATIBLE_MP4)
    console.log("  Re-encode H.264+AAC: BẬT (FORCE_COMPATIBLE_MP4)");
  const check = spawn(FFMPEG_PATH, ["-version"], { stdio: "ignore" });
  check.on("error", () => {
    console.warn("\n⚠ Không tìm thấy FFmpeg. Cài: brew install ffmpeg\n");
  });
  check.on("close", (code) => {
    if (code === 0) console.log("FFmpeg:", FFMPEG_PATH);
  });
});
