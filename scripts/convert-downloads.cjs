#!/usr/bin/env node
/**
 * Convert tất cả file .ts trong thư mục download/ sang .mp4 (ffmpeg -c copy).
 * Chạy: npm run convert-downloads
 */
const fs = require("fs");
const path = require("path");
const { spawn } = require("child_process");

const ROOT = path.join(__dirname, "..");
const DOWNLOAD_DIR = path.join(ROOT, "download");

function runFfmpeg(inputPath, outputPath) {
  return new Promise((resolve, reject) => {
    const ff = spawn(
      "ffmpeg",
      ["-y", "-i", inputPath, "-c", "copy", outputPath],
      {
        stdio: "pipe",
      },
    );
    let err = "";
    ff.stderr.on("data", (d) => (err += d.toString()));
    ff.on("close", (code) => {
      if (code === 0) resolve();
      else reject(new Error(err || `exit ${code}`));
    });
  });
}

if (!fs.existsSync(DOWNLOAD_DIR)) {
  console.log("Thư mục download/ chưa tồn tại.");
  process.exit(0);
}

const files = fs.readdirSync(DOWNLOAD_DIR).filter((f) => /\.ts$/i.test(f));
if (files.length === 0) {
  console.log("Không có file .ts nào trong download/");
  process.exit(0);
}

(async () => {
  for (const f of files) {
    const tsPath = path.join(DOWNLOAD_DIR, f);
    const mp4Path = tsPath.replace(/\.ts$/i, ".mp4");
    process.stdout.write(`Convert ${f} -> ${path.basename(mp4Path)} ... `);
    try {
      await runFfmpeg(tsPath, mp4Path);
      fs.unlinkSync(tsPath);
      console.log("OK");
    } catch (e) {
      console.log("Lỗi:", e.message);
    }
  }
})();
