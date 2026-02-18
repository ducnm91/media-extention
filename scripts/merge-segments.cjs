#!/usr/bin/env node
/**
 * Gộp thủ công các file segment trong 1 thư mục → file .mp4 ngang cấp với thư mục.
 * Cách chạy:
 *   node scripts/merge-segments.cjs [đường/dẫn/thư/mục]
 *   node scripts/merge-segments.cjs                    → tìm các thư mục trong download/ có segment_*.ts và gộp từng cái
 *   node scripts/merge-segments.cjs download/hls-xxx   → gộp chỉ thư mục đó
 */
const fs = require("fs");
const path = require("path");
const { spawn, execSync } = require("child_process");

const ROOT = path.join(__dirname, "..");
const DOWNLOAD_DIR = path.join(ROOT, "download");

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

function runFfmpegConcat(segmentDir, listFile, outputRelative) {
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
        outputRelative,
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

function mergeFolder(segmentDir) {
  const absPath = path.isAbsolute(segmentDir)
    ? segmentDir
    : path.join(process.cwd(), segmentDir);
  if (!fs.existsSync(absPath) || !fs.statSync(absPath).isDirectory()) {
    console.error("Không tìm thấy thư mục:", absPath);
    return Promise.resolve(false);
  }
  const files = fs
    .readdirSync(absPath)
    .filter((f) => f.startsWith("segment_") && f.endsWith(".ts"));
  if (files.length === 0) {
    console.error("Thư mục không chứa file segment_*.ts:", absPath);
    return Promise.resolve(false);
  }
  files.sort();
  const listPath = path.join(absPath, "list.txt");
  const listLines = files.map((f) => `file '${f}'`).join("\n");
  fs.writeFileSync(listPath, listLines, "utf8");
  const folderName = path.basename(absPath);
  const parentDir = path.dirname(absPath);
  const mp4Path = path.join(parentDir, folderName + ".mp4");
  const outputRelative = path.relative(absPath, mp4Path);
  console.log(
    "Gộp",
    files.length,
    "file trong",
    folderName,
    "→",
    folderName + ".mp4",
  );
  return runFfmpegConcat(absPath, "list.txt", outputRelative)
    .then(() => {
      try {
        fs.unlinkSync(listPath);
      } catch {
        // ignore
      }
      console.log("OK:", mp4Path);
      return true;
    })
    .catch((e) => {
      console.error("Lỗi:", e.message);
      return false;
    });
}

async function main() {
  const arg = process.argv[2];
  if (arg) {
    await mergeFolder(arg);
    return;
  }
  if (!fs.existsSync(DOWNLOAD_DIR)) {
    console.log(
      "Không có thư mục download/. Chạy với đường dẫn thư mục chứa segment_*.ts",
    );
    return;
  }
  const dirs = fs
    .readdirSync(DOWNLOAD_DIR, { withFileTypes: true })
    .filter((d) => d.isDirectory())
    .map((d) => path.join(DOWNLOAD_DIR, d.name))
    .filter((dir) => {
      const files = fs.readdirSync(dir);
      return files.some((f) => f.startsWith("segment_") && f.endsWith(".ts"));
    });
  if (dirs.length === 0) {
    console.log(
      "Không tìm thấy thư mục nào trong download/ có file segment_*.ts",
    );
    return;
  }
  console.log(
    "Tìm thấy",
    dirs.length,
    "thư mục chứa segments. Đang gộp từng thư mục...\n",
  );
  for (const dir of dirs) {
    await mergeFolder(dir);
  }
}

main();
