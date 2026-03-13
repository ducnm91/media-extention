import { defineConfig } from "wxt";

// See https://wxt.dev/api/config.html
export default defineConfig({
  modules: ["@wxt-dev/module-vue"],
  manifest: {
    // Full host permissions: truy cập mọi trang web + server tải video local
    host_permissions: ["<all_urls>", "http://127.0.0.1:8765/*", "http://localhost:8765/*"],
    // Đầy đủ permissions API thường dùng cho extension
    permissions: [
      "tabs",
      "scripting",
      "storage",
      "activeTab",
      "contextMenus",
      "downloads",
      "notifications",
      "clipboardRead",
      "clipboardWrite",
      "cookies",
      "webRequest",
      "declarativeNetRequest",
      "management",
      "bookmarks",
      "history",
      "sessions",
      "tabCapture",
      "desktopCapture",
      "debugger",
      "proxy",
      "alarms",
      "idle",
      "power",
      "system.display",
      "system.cpu",
      "system.memory",
      "unlimitedStorage",
    ],
  },
});
