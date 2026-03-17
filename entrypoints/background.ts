// Lưu URL M3U8 gần nhất theo tab (từ webRequest) để content script lấy khi bấm Download
const lastM3u8ByTab = new Map<number, string>();

/** Trả về URL playlist M3U8 thật: hoặc chính url (nếu path kết thúc .m3u8), hoặc trích từ query (vd: ping?mu=...m3u8). */
function getM3u8UrlToStore(requestUrl: string): string | null {
  if (!requestUrl || !requestUrl.includes("m3u8")) return null;
  try {
    const u = new URL(requestUrl);
    if (u.pathname.endsWith(".m3u8") || u.pathname.includes(".m3u8"))
      return requestUrl;
    const params = u.searchParams;
    const keys = ["mu", "url", "src", "manifest", "playlist", "m3u8", "hls"];
    for (const key of keys) {
      const val = params.get(key);
      if (!val) continue;
      const decoded = decodeURIComponent(val);
      if (
        (decoded.startsWith("http://") || decoded.startsWith("https://")) &&
        decoded.includes("m3u8")
      )
        return decoded;
    }
  } catch {
    // ignore
  }
  return null;
}

export default defineBackground(() => {
  console.log("Hello background!", { id: browser.runtime.id });

  let lastError: string | null = null;

  (async () => {
    try {
      const stored = await browser.storage.sync.get([
        "maxParallelDownloadTabs",
        "segmentFetchConcurrency",
        "autoTriggerDelaySec",
      ]);
      const maxTabs =
        typeof stored.maxParallelDownloadTabs === "number"
          ? stored.maxParallelDownloadTabs
          : DEFAULT_CONFIG.maxParallelDownloadTabs;
      const segConc =
        typeof stored.segmentFetchConcurrency === "number"
          ? stored.segmentFetchConcurrency
          : DEFAULT_CONFIG.segmentFetchConcurrency;
      const delaySec =
        typeof stored.autoTriggerDelaySec === "number"
          ? stored.autoTriggerDelaySec
          : DEFAULT_CONFIG.autoTriggerDelaySec;
      CONFIG = {
        maxParallelDownloadTabs: Math.max(
          1,
          Math.min(20, Math.floor(maxTabs)),
        ),
        segmentFetchConcurrency: Math.max(
          1,
          Math.min(64, Math.floor(segConc)),
        ),
        autoTriggerDelaySec: Math.max(
          1,
          Math.min(60, Math.floor(delaySec)),
        ),
      };
      console.log("Loaded download config:", CONFIG);
    } catch (e) {
      console.warn(
        "[background] Không thể tải cấu hình, dùng mặc định.",
        e && (e as Error).message,
      );
      CONFIG = { ...DEFAULT_CONFIG };
    }

    try {
      browser.storage.onChanged.addListener((changes, area) => {
        if (area !== "sync") return;
        let changed = false;
        if (changes.maxParallelDownloadTabs) {
          const v = changes.maxParallelDownloadTabs.newValue;
          if (typeof v === "number") {
            CONFIG.maxParallelDownloadTabs = Math.max(
              1,
              Math.min(20, Math.floor(v)),
            );
            changed = true;
          }
        }
        if (changes.segmentFetchConcurrency) {
          const v = changes.segmentFetchConcurrency.newValue;
          if (typeof v === "number") {
            CONFIG.segmentFetchConcurrency = Math.max(
              1,
              Math.min(64, Math.floor(v)),
            );
            changed = true;
          }
        }
        if (changes.autoTriggerDelaySec) {
          const v = changes.autoTriggerDelaySec.newValue;
          if (typeof v === "number") {
            CONFIG.autoTriggerDelaySec = Math.max(
              1,
              Math.min(60, Math.floor(v)),
            );
            changed = true;
          }
        }
        if (changed) {
          console.log("Updated download config:", CONFIG);
        }
      });
    } catch {
      // ignore
    }
  })();

  // Chỉ lưu URL thực sự là M3U8 (path .m3u8) hoặc trích từ query (vd: jwplayer ping?mu=...index.m3u8)
  browser.webRequest.onCompleted.addListener(
    (details) => {
      const toStore = getM3u8UrlToStore(details.url || "");
      if (toStore && details.tabId > 0)
        lastM3u8ByTab.set(details.tabId, toStore);
    },
    { urls: ["<all_urls>"] },
  );

  // Dọn URL khi tab đóng; batch: tab xong thì mở tab tiếp theo
  browser.tabs.onRemoved.addListener((tabId) => {
    lastM3u8ByTab.delete(tabId);
    if (batchTabIds.has(tabId)) {
      batchTabIds.delete(tabId);
      batchPendingTrigger.delete(tabId);
      batchTabIdToExtraMeta.delete(tabId);
      void processBatchQueue();
    }
    if (updateTabIds.has(tabId)) {
      updateTabIds.delete(tabId);
      updatePendingTrigger.delete(tabId);
      updateTabIdToItem.delete(tabId);
      void processUpdateQueue();
    }
  });

  // Batch: khi tab video load xong, chờ delay rồi gửi TRIGGER_DOWNLOAD hoặc TRIGGER_UPDATE_METADATA
  browser.tabs.onUpdated.addListener((tabId, changeInfo) => {
    if (changeInfo.status !== "complete") return;
    if (batchPendingTrigger.has(tabId)) {
      batchPendingTrigger.delete(tabId);
      const delayMs = CONFIG.autoTriggerDelaySec * 1000;
      setTimeout(() => {
        browser.tabs
          .sendMessage(tabId, {
            type: "TRIGGER_DOWNLOAD",
            delayMs: 0,
            tabId,
          })
          .catch(() => {
            if (batchTabIds.has(tabId)) {
              batchTabIds.delete(tabId);
              void processBatchQueue();
            }
          });
      }, delayMs);
      return;
    }
    if (updatePendingTrigger.has(tabId)) {
      updatePendingTrigger.delete(tabId);
      setTimeout(() => {
        browser.tabs
          .sendMessage(tabId, { type: "TRIGGER_UPDATE_METADATA", tabId })
          .catch(() => {
            if (updateTabIds.has(tabId)) {
              updateTabIds.delete(tabId);
              updateTabIdToItem.delete(tabId);
              void processUpdateQueue();
            }
          });
      }, 3000);
      return;
    }
    if (
      categoryScanTabId != null &&
      tabId === categoryScanTabId &&
      currentCategoryPageUrl
    ) {
      browser.tabs
        .sendMessage(tabId, {
          type: "SCAN_CATEGORY_PAGE",
          minViews: autoscanMinViews,
        })
        .then((res: any) => {
          if (!res) return;
          if (res.redirected === true) {
            return;
          }
          const videos = Array.isArray(res.videos) ? res.videos : [];
          const hasHighVideos = !!res.hasHighVideos;
          const nextPageUrl =
            typeof res.nextPageUrl === "string" && res.nextPageUrl
              ? (res.nextPageUrl as string)
              : null;

          if (videos.length) {
            const items: BatchItem[] = videos.map((v: any) => ({
              url: String(v.url),
              thumbnailUrl: v.thumbnailUrl ? String(v.thumbnailUrl) : undefined,
            }));
            const urls = items.map((i) => i.url);

            // Dùng cùng cơ chế filter/update như BATCH_QUEUE_URLS:
            // - Không download lại video đã có trong metadata (filteredUrls)
            // - Với URL đã có nhưng thiếu thumbnail/views/duration → đưa vào updateQueue
            (async () => {
              let filteredUrls = urls;
              try {
                const res = await fetch(`${SERVER_BASE}/filter-source-urls`, {
                  method: "POST",
                  headers: { "Content-Type": "application/json" },
                  body: JSON.stringify({ urls }),
                });
                if (res.ok) {
                  const data = (await res.json()) as {
                    urls?: string[];
                    updateUrls?: string[];
                  };
                  filteredUrls = Array.isArray(data.urls) ? data.urls : urls;
                  const updateUrls = Array.isArray(data.updateUrls)
                    ? data.updateUrls
                    : [];
                  const existingUpdateUrls = new Set(
                    updateQueue.map((i) => i.url),
                  );
                  for (const url of updateUrls) {
                    if (!existingUpdateUrls.has(url)) {
                      updateQueue.push({
                        url,
                        thumbnailUrl: items.find((i) => i.url === url)
                          ?.thumbnailUrl,
                      });
                      existingUpdateUrls.add(url);
                    }
                  }
                  void processUpdateQueue();
                }
              } catch (e) {
                console.warn(
                  "[autoscan] Filter request failed, using all URLs",
                  e && (e as Error).message,
                );
              }

              const toQueue: BatchItem[] = filteredUrls.map((url) => ({
                url,
                thumbnailUrl: items.find((i) => i.url === url)?.thumbnailUrl,
              }));
              const existingUrls = new Set(batchQueue.map((i) => i.url));
              for (const item of toQueue) {
                if (!existingUrls.has(item.url)) {
                  batchQueue.push(item);
                  existingUrls.add(item.url);
                }
              }
              void processBatchQueue();
            })();
          }

          if (hasHighVideos && nextPageUrl) {
            currentCategoryPageUrl = nextPageUrl;
            setTimeout(() => {
              void openOrReuseCategoryScanTab(nextPageUrl);
            }, 3000);
          } else {
            currentCategoryUrl = categoryQueue.shift() ?? null;
            currentCategoryPageUrl = currentCategoryUrl;
            if (currentCategoryPageUrl) {
              void openOrReuseCategoryScanTab(currentCategoryPageUrl);
            } else {
              categoryScanTabId = null;
            }
          }
        })
        .catch(() => {
          // ignore scan error
        });
    }
  });

  browser.runtime.onMessage.addListener(
    (
      message: {
        type: string;
        url?: string;
        pageTitle?: string;
        tabId?: number;
        sourceUrl?: string;
        views?: string;
        meta?: {
          sourceUrl?: string;
          actors?: string[];
          tags?: string[];
          pageTitle?: string;
        };
      },
      sender: { tab?: { id?: number } },
      sendResponse,
    ) => {
      if (message.type === "GET_LAST_ERROR") {
        sendResponse(lastError ?? "");
        return true;
      }
      if (message.type === "GET_BATCH_QUEUE_COUNT") {
        sendResponse({ count: batchQueue.length });
        return false;
      }
      if (message.type === "SCAN_CATEGORIES_AT_INDEX") {
        const tabId = message.tabId ?? sender.tab?.id;
        if (!tabId) {
          sendResponse({ categories: [] });
          return false;
        }
        browser.tabs
          .sendMessage(tabId, { type: "SCAN_CATEGORIES_AT_INDEX" })
          .then((res) => {
            sendResponse(res ?? { categories: [] });
          })
          .catch(() => sendResponse({ categories: [] }));
        return true;
      }
      if (message.type === "START_CATEGORY_AUTOSCAN") {
        const list = Array.isArray(message.categories)
          ? (message.categories as string[])
          : [];
        autoscanMinViews =
          typeof message.minViews === "number"
            ? message.minViews
            : 1_000_000;
        categoryQueue = list.filter((u) => typeof u === "string" && u.length);
        currentCategoryUrl = categoryQueue.shift() ?? null;
        currentCategoryPageUrl = currentCategoryUrl;
        if (currentCategoryPageUrl) {
          void openOrReuseCategoryScanTab(currentCategoryPageUrl);
        }
        sendResponse(true);
        return false;
      }
      if (message.type === "PAUSE_BATCH") {
        isBatchPaused = true;
        sendResponse(true);
        return false;
      }
      if (message.type === "RESUME_BATCH") {
        isBatchPaused = false;
        void processBatchQueue();
        void processUpdateQueue();
        sendResponse(true);
        return false;
      }
      if (message.type === "GET_LAST_M3U8" && sender.tab?.id) {
        const url = lastM3u8ByTab.get(sender.tab.id) ?? null;
        sendResponse(url);
        return false;
      }
      if (message.type === "INSPECT_M3U8" && message.url) {
        inspectM3u8(message.url)
          .then(sendResponse)
          .catch((err) =>
            sendResponse({
              error: err instanceof Error ? err.message : String(err),
            }),
          );
        return true;
      }
      if (
        message.type === "BATCH_QUEUE_URLS" &&
        (Array.isArray(message.items) || Array.isArray(message.urls))
      ) {
        const items: BatchItem[] = Array.isArray(message.items)
          ? (message.items as BatchItem[])
          : (message.urls as string[]).map((url: string) => ({ url }));
        const urls = items.map((i) => i.url);
        const reply = sendResponse;
        (async () => {
          let filteredUrls = urls;
          try {
            const res = await fetch(`${SERVER_BASE}/filter-source-urls`, {
              method: "POST",
              headers: { "Content-Type": "application/json" },
              body: JSON.stringify({ urls }),
            });
            if (res.ok) {
              const data = (await res.json()) as {
                urls?: string[];
                updateUrls?: string[];
              };
              filteredUrls = Array.isArray(data.urls) ? data.urls : urls;
              const updateUrls = Array.isArray(data.updateUrls)
                ? data.updateUrls
                : [];
              const existingUpdateUrls = new Set(updateQueue.map((i) => i.url));
              for (const url of updateUrls) {
                if (!existingUpdateUrls.has(url)) {
                  updateQueue.push({
                    url,
                    thumbnailUrl: items.find((i) => i.url === url)?.thumbnailUrl,
                  });
                  existingUpdateUrls.add(url);
                }
              }
              void processUpdateQueue();
            }
          } catch (e) {
            console.warn(
              "[batch] Filter request failed, using all URLs",
              e && (e as Error).message,
            );
          }
          const toQueue: BatchItem[] = filteredUrls.map((url) => ({
            url,
            thumbnailUrl: items.find((i) => i.url === url)?.thumbnailUrl,
          }));
          const existingUrls = new Set(batchQueue.map((i) => i.url));
          let newlyAdded = 0;
          for (const item of toQueue) {
            if (!existingUrls.has(item.url)) {
              batchQueue.push(item);
              existingUrls.add(item.url);
              newlyAdded++;
            }
          }
          void processBatchQueue();
          try {
            reply({
              ok: true,
              total: urls.length,
              queued: newlyAdded,
              skipped: urls.length - toQueue.length,
              totalInQueue: batchQueue.length,
            });
          } catch {
            // ignore
          }
          if (newlyAdded === 0 && toQueue.length === 0 && urls.length > 0) {
            try {
              await browser.notifications.create({
                type: "basic",
                iconUrl: browser.runtime.getURL("wxt.svg"),
                title: "HLS Downloader",
                message:
                  "Không có video mới để tải (đã có trong metadata).",
              });
            } catch {
              // ignore
            }
          }
        })();
        return true; // giữ channel mở cho sendResponse bất đồng bộ
      }
      if (message.type === "UPDATE_METADATA") {
        const tabId =
          typeof message.tabId === "number"
            ? message.tabId
            : sender.tab?.id;
        if (tabId == null) return false;
        const item = updateTabIdToItem.get(tabId);
        const sourceUrl =
          typeof message.sourceUrl === "string" && message.sourceUrl.trim()
            ? message.sourceUrl.trim()
            : item?.url;
        const views =
          typeof message.views === "string" ? message.views.trim() : "";
        (async () => {
          try {
            await fetch(`${SERVER_BASE}/update-metadata`, {
              method: "POST",
              headers: { "Content-Type": "application/json" },
              body: JSON.stringify({
                sourceUrl: sourceUrl || "",
                thumbnailUrl: item?.thumbnailUrl || "",
                views: views || undefined,
                duration:
                  typeof message.duration === "string" &&
                  message.duration.trim()
                    ? message.duration.trim()
                    : undefined,
              }),
            });
          } catch (e) {
            console.warn("[update-metadata] request failed", e);
          }
          updateTabIds.delete(tabId);
          updatePendingTrigger.delete(tabId);
          updateTabIdToItem.delete(tabId);
          try {
            await browser.tabs.remove(tabId);
          } catch {
            // ignore
          }
          void processUpdateQueue();
        })();
        return false;
      }
      if (message.type === "BATCH_DONE") {
        const tabId =
          typeof message.tabId === "number"
            ? message.tabId
            : sender.tab?.id;
        if (tabId == null) return false;
        batchTabIds.delete(tabId);
        batchPendingTrigger.delete(tabId);
        batchTabIdToExtraMeta.delete(tabId);
        browser.tabs.remove(tabId).catch(() => {});
        void processBatchQueue();
        return false;
      }
      if (message.type === "DOWNLOAD_HLS" && message.url && sender.tab?.id) {
        lastError = null;
        const tabId = sender.tab.id;
        const rawMeta = message.meta || {};
        const sanitizedTitle = sanitizePageTitleForMetadata(
          rawMeta.sourceUrl,
          message.pageTitle,
        );
        const titleKey = normalizeTitleKey(sanitizedTitle);
        const meta = {
          ...rawMeta,
          pageTitle: sanitizedTitle,
        };

        const startDownload = () => {
          if (titleKey && activeDownloadTitles.has(titleKey)) {
            lastError =
              "Video này (theo title trang) đang được tải. Đợi tải xong rồi hãy bấm lại để tránh trùng.";
            sendResponse(false);
            return;
          }

          if (
            !activeDownloadTabs.has(tabId) &&
            activeDownloadTabs.size >= CONFIG.maxParallelDownloadTabs
          ) {
            lastError = `Đang tải tối đa ${CONFIG.maxParallelDownloadTabs} tab cùng lúc. Đợi một số tab tải xong rồi thử lại.`;
            sendResponse(false);
            return;
          }

          activeDownloadTabs.add(tabId);
          if (titleKey) activeDownloadTitles.add(titleKey);
          updateActionBadge();

          downloadHls(message.url, tabId, message.pageTitle || "")
            .then(async (result) => {
              if (!result) {
                sendResponse(true);
                return;
              }
              const sessionId = result.filename
                .replace(/\.ts$/i, "")
                .replace(/\.mp4$/i, "");
              const extra = batchTabIdToExtraMeta.get(tabId);
              const metaWithThumb = {
                ...meta,
                thumbnailUrl: extra?.thumbnailUrl,
              };
              const saved =
                result.segmentBuffers.length > 0
                  ? await trySaveSegmentsToServer(
                      result.segmentBuffers,
                      sessionId,
                      metaWithThumb,
                    )
                  : null;
              if (saved) {
                try {
                  await browser.tabs.sendMessage(
                    tabId,
                    { type: "HLS_SAVE_RESULT", success: true, mp4: saved },
                    { frameId: 0 },
                  );
                } catch {
                  // Tab đã đóng hoặc reload
                }
                try {
                  await browser.tabs.remove(tabId);
                } catch {
                  // ignore
                }
                sendResponse(true);
                return;
              }
              const fallback = await trySaveToServer(
                result.buffer,
                result.filename,
                metaWithThumb,
              );
              if (fallback) {
                try {
                  await browser.tabs.sendMessage(
                    tabId,
                    { type: "HLS_SAVE_RESULT", success: true, mp4: fallback },
                    { frameId: 0 },
                  );
                } catch {
                  // Tab đã đóng hoặc reload
                }
                try {
                  await browser.tabs.remove(tabId);
                } catch {
                  // ignore
                }
                sendResponse(true);
                return;
              }
              const buffer = result.buffer;
              return sendChunksToTab(tabId, buffer, result.filename).then(() =>
                sendResponse(true),
              );
            })
            .catch((err) => {
              lastError = err instanceof Error ? err.message : String(err);
              sendResponse(false);
              if (batchTabIds.has(tabId)) {
                batchTabIds.delete(tabId);
                batchPendingTrigger.delete(tabId);
                batchTabIdToExtraMeta.delete(tabId);
                browser.tabs.remove(tabId).catch(() => {});
                void processBatchQueue();
              }
            })
            .finally(() => {
              activeDownloadTabs.delete(tabId);
              if (titleKey) activeDownloadTitles.delete(titleKey);
              batchTabIdToExtraMeta.delete(tabId);
              updateActionBadge();
              void notifyAllDownloadsDone();
            });
        };

        if (meta.sourceUrl) {
          fetch(`${SERVER_BASE}/filter-source-urls`, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ urls: [meta.sourceUrl] }),
          })
            .then((resp) => {
              if (!resp.ok) return null;
              return resp
                .json()
                .then(
                  (data) =>
                    (data as { urls?: string[]; updateUrls?: string[] }) || null,
                )
                .catch(() => null);
            })
            .then((data) => {
              if (!data) {
                startDownload();
                return;
              }
              const urls = Array.isArray(data.urls) ? data.urls : [];
              if (urls.length === 0) {
                lastError =
                  "Video này đã có trong metadata (theo sourceUrl). Bỏ qua để tránh tải trùng.";
                sendResponse(false);
                return;
              }
              startDownload();
            })
            .catch(() => {
              // nếu server lỗi thì bỏ qua check trùng, tiếp tục tải như bình thường
              startDownload();
            });
          return true; // giữ kênh mở cho sendResponse async
        }

        // Không có sourceUrl → không kiểm tra trùng, tải như bình thường
        startDownload();
        return true; // keep channel open for async sendResponse
      }
      return false;
    },
  );
});

function getBaseUrl(url: string): string {
  const lastSlash = url.lastIndexOf("/");
  return lastSlash >= 0 ? url.slice(0, lastSlash + 1) : url + "/";
}

function resolveUrl(base: string, relative: string): string {
  if (relative.startsWith("http://") || relative.startsWith("https://"))
    return relative;
  const rel = relative.trim();
  if (!rel) return base;
  if (rel.startsWith("/")) {
    try {
      const u = new URL(base);
      return u.origin + rel;
    } catch {
      return base + rel.slice(1);
    }
  }
  return base + rel;
}

/** Một segment: URL và tùy chọn byte range (cho fMP4 / single-file). */
type SegmentRef = { url: string; range?: string };

/** Parse m3u8: segment list (TS hoặc fMP4), init segment (fMP4), và variant nếu là master. */
function parseM3u8(
  text: string,
  baseUrl: string,
): {
  segments: SegmentRef[];
  initSegment?: SegmentRef;
  variantUrl: string | null;
  variants: { url: string; bandwidth?: number; resolution?: string }[];
} {
  const lines = text
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter(Boolean);
  const segments: SegmentRef[] = [];
  let initSegment: SegmentRef | undefined;
  const variants: { url: string; bandwidth?: number; resolution?: string }[] =
    [];
  let variantUrl: string | null = null;

  let lastSegmentUri: string | null = null;
  let nextByterange: string | null = null;

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];

    if (line.startsWith("#EXT-X-STREAM-INF")) {
      const next = lines[i + 1];
      if (next && !next.startsWith("#")) {
        const url = resolveUrl(baseUrl, next);
        const bandwidth = line.match(/BANDWIDTH=(\d+)/)?.[1];
        const resolution = line.match(/RESOLUTION=(\d+x\d+)/)?.[1];
        variants.push({
          url,
          bandwidth: bandwidth ? parseInt(bandwidth, 10) : undefined,
          resolution,
        });
        if (!variantUrl) variantUrl = url;
      }
    }

    if (line.startsWith("#EXT-X-MAP:")) {
      const uriMatch = line.match(/URI="([^"]+)"/);
      const rangeMatch = line.match(/BYTERANGE="(\d+)(?:@(\d+))?"/);
      if (uriMatch) {
        const url = resolveUrl(baseUrl, uriMatch[1].trim());
        const range = rangeMatch
          ? rangeMatch[2]
            ? `${rangeMatch[1]}@${rangeMatch[2]}`
            : rangeMatch[1]
          : undefined;
        initSegment = { url, range };
        lastSegmentUri = url;
      }
    }

    if (line.startsWith("#EXT-X-BYTERANGE:")) {
      const m = line.match(/#EXT-X-BYTERANGE:(.+)/);
      nextByterange = m ? m[1].trim() : null;
    }

    if (line.startsWith("#EXTINF:")) {
      const next = lines[i + 1];
      if (next && !next.startsWith("#")) {
        const segUrl = resolveUrl(baseUrl, next);
        lastSegmentUri = segUrl;
        if (nextByterange) {
          segments.push({ url: segUrl, range: nextByterange });
        } else {
          segments.push({ url: segUrl });
        }
        nextByterange = null;
      }
    } else if (nextByterange && lastSegmentUri) {
      segments.push({ url: lastSegmentUri, range: nextByterange });
      nextByterange = null;
    }
  }

  if (variants.length > 1) {
    const videoVariant =
      variants.find((v) => v.resolution) ||
      variants.sort((a, b) => (b.bandwidth ?? 0) - (a.bandwidth ?? 0))[0];
    if (videoVariant) variantUrl = videoVariant.url;
  }

  return { segments, initSegment, variantUrl, variants };
}

async function fetchText(url: string): Promise<string> {
  const res = await fetch(url, { mode: "cors", credentials: "omit" });
  if (!res.ok) throw new Error(`HTTP ${res.status}: ${url}`);
  return res.text();
}

/** Kiểm tra M3U8: fetch, parse, trả về thông tin để debug (hiển thị trong popup). */
async function inspectM3u8(url: string): Promise<{
  inspectedUrl: string;
  fetchError?: string;
  contentType: "master" | "media" | "unknown";
  rawFirstLines: string;
  parsed: {
    segmentsCount: number;
    initSegment: boolean;
    hasByteRange: boolean;
    variantUrl: string | null;
    variantsCount: number;
    variants: { url: string; bandwidth?: number; resolution?: string }[];
  };
  variantRawFirstLines?: string;
  variantParsed?: {
    segmentsCount: number;
    initSegment: boolean;
    hasByteRange: boolean;
  };
}> {
  const baseUrl = getBaseUrl(url);
  let raw = "";
  let fetchError: string | undefined;
  try {
    raw = await fetchText(url);
  } catch (e) {
    fetchError = e instanceof Error ? e.message : String(e);
    return {
      inspectedUrl: url,
      fetchError,
      contentType: "unknown",
      rawFirstLines: "",
      parsed: {
        segmentsCount: 0,
        initSegment: false,
        hasByteRange: false,
        variantUrl: null,
        variantsCount: 0,
        variants: [],
      },
    };
  }
  const lines = raw.split(/\r?\n/);
  const rawFirstLines = lines.slice(0, 60).join("\n");
  const parsed = parseM3u8(raw, baseUrl);
  const contentType = parsed.variants.length > 0 ? "master" : "media";
  let variantRawFirstLines: string | undefined;
  let variantParsed:
    | { segmentsCount: number; initSegment: boolean; hasByteRange: boolean }
    | undefined;
  if (parsed.variantUrl) {
    try {
      const variantText = await fetchText(parsed.variantUrl);
      const vLines = variantText.split(/\r?\n/);
      variantRawFirstLines = vLines.slice(0, 60).join("\n");
      const vParsed = parseM3u8(variantText, getBaseUrl(parsed.variantUrl));
      variantParsed = {
        segmentsCount: vParsed.segments.length,
        initSegment: !!vParsed.initSegment,
        hasByteRange: vParsed.segments.some((s) => !!s.range),
      };
    } catch {
      variantRawFirstLines = "(không fetch được variant)";
    }
  }
  return {
    inspectedUrl: url,
    fetchError,
    contentType,
    rawFirstLines,
    parsed: {
      segmentsCount: parsed.segments.length,
      initSegment: !!parsed.initSegment,
      hasByteRange: parsed.segments.some((s) => !!s.range),
      variantUrl: parsed.variantUrl,
      variantsCount: parsed.variants.length,
      variants: parsed.variants,
    },
    variantRawFirstLines,
    variantParsed,
  };
}

/** Fetch với tùy chọn Range (cho fMP4 single-file). range dạng "length@offset" hoặc "length". */
async function fetchBytes(url: string, range?: string): Promise<ArrayBuffer> {
  const headers: Record<string, string> = {};
  if (range) {
    const [len, off] = range.split("@").map((s) => s.trim());
    const length = parseInt(len, 10);
    const offset = off ? parseInt(off, 10) : 0;
    headers.Range = `bytes=${offset}-${offset + length - 1}`;
  }
  const res = await fetch(url, {
    mode: "cors",
    credentials: "omit",
    headers: Object.keys(headers).length ? headers : undefined,
  });
  if (!res.ok) throw new Error(`HTTP ${res.status}: ${url}`);
  return res.arrayBuffer();
}

const SERVER_BASE = "http://127.0.0.1:8765";
const CHUNK_SIZE = 8 * 1024 * 1024; // 8MB mỗi message (tránh giới hạn postMessage)

type DownloadConfig = {
  maxParallelDownloadTabs: number;
  segmentFetchConcurrency: number;
  autoTriggerDelaySec: number;
};

const DEFAULT_CONFIG: DownloadConfig = {
  maxParallelDownloadTabs: 4,
  segmentFetchConcurrency: 8,
  autoTriggerDelaySec: 5,
};

let CONFIG: DownloadConfig = { ...DEFAULT_CONFIG };

const activeDownloadTabs = new Set<number>();
const activeDownloadTitles = new Set<string>();

type BatchItem = { url: string; thumbnailUrl?: string };
const batchQueue: BatchItem[] = [];
const batchTabIds = new Set<number>();
const batchPendingTrigger = new Set<number>();
const batchTabIdToExtraMeta = new Map<number, { thumbnailUrl?: string }>();

const updateQueue: BatchItem[] = [];
const updateTabIds = new Set<number>();
const updatePendingTrigger = new Set<number>();
const updateTabIdToItem = new Map<number, BatchItem>();

let categoryQueue: string[] = [];
let currentCategoryUrl: string | null = null;
let currentCategoryPageUrl: string | null = null;
let autoscanMinViews = 1_000_000;
let categoryScanTabId: number | null = null;
let isBatchPaused = false;

async function processBatchQueue() {
  if (isBatchPaused) return;
  while (
    batchQueue.length > 0 &&
    batchTabIds.size < CONFIG.maxParallelDownloadTabs
  ) {
    const item = batchQueue.shift();
    if (!item) break;
    try {
      const tab = await browser.tabs.create({ url: item.url });
      const tabId = tab?.id;
      if (tabId) {
        batchTabIds.add(tabId);
        batchPendingTrigger.add(tabId);
        batchTabIdToExtraMeta.set(tabId, {
          thumbnailUrl: item.thumbnailUrl,
        });
      }
    } catch (e) {
      console.warn("[batch] Failed to create tab:", e);
    }
  }
}

async function processUpdateQueue() {
  if (isBatchPaused) return;
  if (updateQueue.length === 0 || updateTabIds.size >= CONFIG.maxParallelDownloadTabs)
    return;
  const item = updateQueue.shift();
  if (!item) return;
  try {
    const tab = await browser.tabs.create({ url: item.url });
    const tabId = tab?.id;
    if (tabId) {
      updateTabIds.add(tabId);
      updatePendingTrigger.add(tabId);
      updateTabIdToItem.set(tabId, item);
    }
  } catch (e) {
    console.warn("[update] Failed to create tab:", e);
    void processUpdateQueue();
  }
}

async function openOrReuseCategoryScanTab(url: string) {
  if (categoryScanTabId != null) {
    try {
      await browser.tabs.update(categoryScanTabId, { url, active: false });
      return;
    } catch {
      categoryScanTabId = null;
    }
  }
  const tab = await browser.tabs.create({ url, active: false });
  categoryScanTabId = tab.id ?? null;
}

function updateActionBadge() {
  const count = activeDownloadTabs.size;
  if (count > 0) {
    browser.action.setBadgeText({ text: String(count) });
    browser.action.setBadgeBackgroundColor({ color: "#2e7d32" });
  } else {
    browser.action.setBadgeText({ text: "" });
  }
}

async function notifyAllDownloadsDone() {
  if (activeDownloadTabs.size === 0) {
    try {
      await browser.notifications.create({
        type: "basic",
        iconUrl: browser.runtime.getURL("wxt.svg"),
        title: "HLS Downloader",
        message: "Đã tải xong tất cả video đang xử lý.",
      });
    } catch {
      // ignore nếu trình duyệt không hỗ trợ notifications
    }
  }
}

function sanitizeTitleForFilename(title: string): string {
  const trimmed = (title || "").trim();
  if (!trimmed) return "";
  const noExt = trimmed.replace(/\.[a-zA-Z0-9]{1,4}$/, "");
  const replaced = noExt
    .replace(/[\/\\:*?"<>|]+/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .replace(/\s+/g, "_");
  return replaced.slice(0, 80);
}

function normalizeTitleKey(title: string | undefined): string {
  if (!title) return "";
  return title.trim().toLowerCase().replace(/\s+/g, " ");
}

function sanitizePageTitleForMetadata(
  sourceUrl: string | undefined,
  pageTitle: string | undefined,
): string {
  if (!pageTitle) return "";
  let host = "";
  try {
    if (sourceUrl) {
      host = new URL(sourceUrl).hostname || "";
    }
  } catch {
    // ignore invalid URL
  }
  let t = pageTitle.trim();
  if (host.includes("xvideos.com")) {
    t = t.replace(/\s*-\s*XVIDEOS\.COM\s*$/i, "").trim();
  }
  return t;
}

/** Gửi từng segment lên server, sau đó /finish → .mp4 + folder segments. */
async function trySaveSegmentsToServer(
  segmentBuffers: ArrayBuffer[],
  sessionId: string,
  meta: {
    sourceUrl?: string;
    actors?: string[];
    tags?: string[];
    pageTitle?: string;
    views?: string;
    thumbnailUrl?: string;
    duration?: string;
  },
): Promise<string | null> {
  try {
    const total = segmentBuffers.length;
    const concurrency = Math.max(
      1,
      Math.min(CONFIG.segmentFetchConcurrency, total),
    );
    for (let i = 0; i < total; i += concurrency) {
      const batch = segmentBuffers.slice(i, i + concurrency);
      const responses = await Promise.all(
        batch.map((buf, idx) => {
          const body = new Uint8Array(buf);
          const index = i + idx;
          return fetch(`${SERVER_BASE}/segment`, {
            method: "POST",
            body,
            headers: {
              "X-Session-Id": sessionId,
              "X-Index": String(index),
              "X-Total": String(total),
            },
          });
        }),
      );
      if (responses.some((res) => !res.ok)) return null;
    }
    const finishRes = await fetch(`${SERVER_BASE}/finish`, {
      method: "POST",
      body: new ArrayBuffer(0),
      headers: {
        "X-Session-Id": sessionId,
        "X-Source-Url": meta.sourceUrl || "",
        "X-Page-Title": meta.pageTitle || "",
        "X-Actors": JSON.stringify(meta.actors || []),
        "X-Tags": JSON.stringify(meta.tags || []),
        ...(meta.views !== undefined && meta.views !== ""
          ? { "X-Views": String(meta.views) }
          : {}),
        ...(meta.thumbnailUrl
          ? { "X-Thumbnail-Url": meta.thumbnailUrl }
          : {}),
        ...(meta.duration !== undefined && meta.duration !== ""
          ? { "X-Duration": String(meta.duration) }
          : {}),
      },
    });
    const data = (await finishRes.json().catch(() => ({}))) as {
      ok?: boolean;
      mp4?: string;
    };
    if (finishRes.ok && data.ok && data.mp4) return data.mp4;
  } catch {
    // Server không chạy hoặc lỗi mạng
  }
  return null;
}

/** Fallback: gửi 1 file .ts đã gộp lên /save (luồng cũ, không giữ folder segments). */
async function trySaveToServer(
  buffer: ArrayBuffer,
  filename: string,
  meta: {
    sourceUrl?: string;
    actors?: string[];
    tags?: string[];
    pageTitle?: string;
    views?: string;
    thumbnailUrl?: string;
    duration?: string;
  },
): Promise<string | null> {
  try {
    const res = await fetch(`${SERVER_BASE}/save`, {
      method: "POST",
      body: buffer,
      headers: {
        "X-Filename": filename,
        "X-Source-Url": meta.sourceUrl || "",
        "X-Page-Title": meta.pageTitle || "",
        "X-Actors": JSON.stringify(meta.actors || []),
        "X-Tags": JSON.stringify(meta.tags || []),
        ...(meta.views !== undefined && meta.views !== ""
          ? { "X-Views": String(meta.views) }
          : {}),
        ...(meta.thumbnailUrl
          ? { "X-Thumbnail-Url": meta.thumbnailUrl }
          : {}),
        ...(meta.duration !== undefined && meta.duration !== ""
          ? { "X-Duration": String(meta.duration) }
          : {}),
      },
    });
    const data = (await res.json().catch(() => ({}))) as {
      ok?: boolean;
      mp4?: string;
    };
    if (res.ok && data.ok && data.mp4) return data.mp4;
  } catch {
    // ignore
  }
  return null;
}

const SEND_OPTIONS = { frameId: 0 } as const;

async function sendChunksToTab(
  tabId: number,
  buffer: ArrayBuffer,
  filename: string,
): Promise<void> {
  const u8 = new Uint8Array(buffer);
  const totalChunks = Math.ceil(u8.length / CHUNK_SIZE);
  await browser.tabs.sendMessage(
    tabId,
    { type: "HLS_DOWNLOAD_START", filename, totalChunks },
    SEND_OPTIONS,
  );
  for (let i = 0; i < totalChunks; i++) {
    const start = i * CHUNK_SIZE;
    const end = Math.min(start + CHUNK_SIZE, u8.length);
    const slice = u8.slice(start, end);
    const chunkCopy = new Uint8Array(slice.length);
    chunkCopy.set(slice);
    await browser.tabs.sendMessage(
      tabId,
      { type: "HLS_DOWNLOAD_CHUNK", buffer: chunkCopy.buffer, index: i },
      SEND_OPTIONS,
    );
    await new Promise((r) => setTimeout(r, 0));
  }
  await browser.tabs.sendMessage(
    tabId,
    { type: "HLS_DOWNLOAD_READY" },
    SEND_OPTIONS,
  );
}

async function downloadHls(
  m3u8Url: string,
  tabId: number,
  pageTitle: string,
): Promise<{
  buffer: ArrayBuffer;
  filename: string;
  segmentBuffers: ArrayBuffer[];
} | null> {
  const baseUrl = getBaseUrl(m3u8Url);
  let text = await fetchText(m3u8Url);
  let parsed = parseM3u8(text, baseUrl);
  let { segments, initSegment, variantUrl } = parsed;

  if (variantUrl) {
    const variantBase = getBaseUrl(variantUrl);
    text = await fetchText(variantUrl);
    parsed = parseM3u8(text, variantBase);
    if (parsed.segments.length || parsed.initSegment) {
      segments = parsed.segments;
      initSegment = parsed.initSegment;
    }
  }

  const isFmp4 = !!initSegment || segments.some((s) => s.range);
  if (!segments.length && !initSegment)
    throw new Error(
      "Không tìm thấy segment nào trong M3U8 (có thể là DASH .mpd hoặc định dạng khác).",
    );

  const segmentBuffers: ArrayBuffer[] = [];
  const totalParts = (initSegment ? 1 : 0) + segments.length;

  if (initSegment) {
    const buf = await fetchBytes(initSegment.url, initSegment.range);
    segmentBuffers.push(buf);
    try {
      await browser.tabs.sendMessage(
        tabId,
        { type: "HLS_DOWNLOAD_PROGRESS", current: 1, total: totalParts },
        { frameId: 0 },
      );
    } catch {}
  }

  const concurrency = Math.max(
    1,
    Math.min(CONFIG.segmentFetchConcurrency, segments.length),
  );
  for (let i = 0; i < segments.length; i += concurrency) {
    const batch = segments.slice(i, i + concurrency);
    const buffers = await Promise.all(
      batch.map((seg) => fetchBytes(seg.url, seg.range)),
    );
    for (let j = 0; j < buffers.length; j++) {
      const buf = buffers[j];
      segmentBuffers.push(buf);
      const segIndex = i + j;
      try {
        await browser.tabs.sendMessage(
          tabId,
          {
            type: "HLS_DOWNLOAD_PROGRESS",
            current: (initSegment ? 1 : 0) + segIndex + 1,
            total: totalParts,
          },
          { frameId: 0 },
        );
      } catch {}
    }
  }

  const totalLength = segmentBuffers.reduce((s, c) => s + c.byteLength, 0);
  const combined = new Uint8Array(totalLength);
  let offset = 0;
  for (const c of segmentBuffers) {
    combined.set(new Uint8Array(c), offset);
    offset += c.byteLength;
  }

  const shortId = Date.now().toString(36);
  const base = `vid-${shortId}`;
  const filename = isFmp4 ? `${base}.mp4` : `${base}.ts`;
  return {
    buffer: combined.buffer,
    filename,
    segmentBuffers: isFmp4 ? [] : segmentBuffers,
  };
}
