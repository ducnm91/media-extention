import { defineConfig } from "wxt";

// See https://wxt.dev/api/config.html
export default defineConfig({
  modules: ["@wxt-dev/module-vue"],
  manifest: {
    // Full host permissions: truy cập mọi trang web
    host_permissions: ["<all_urls>"],
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
