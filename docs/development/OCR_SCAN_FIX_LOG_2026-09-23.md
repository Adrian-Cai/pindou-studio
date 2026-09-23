# open-code-review 全量扫描 · 修复记录

- 扫描时间：2026-09-23
- 范围：`miniprogram/`（119 个文件送审，148 个被规则过滤）
- 成本：16m13s / 约 210 万 token（input 186 万 + output 24 万）
- 分布：**bug 139 / maintainability 98 / performance 14 / security 13 / other 5**；严重度 **high 39 / medium 131 / low 99**
- 原始结果：`.tmp-ocr-scan-miniprogram.txt`（269 条）；medium+high 摘录：`.tmp-ocr-significant.txt`

处置结论：`已修` / `驳回` = 误报或有意设计（附理由） / `降级` = 真实但严重度被高估 / `待定`

| # | 严重度 | 类别 | 位置 | 问题摘要 | 处置 | 说明 |
|---|---|---|---|---|---|---|
| 1 | high | bug | `miniprogram/app.ts:34-34` | Unhandled promise rejections from fire-and-forget async calls in app.ts: `void | 待定 |  |
| 2 | high | bug | `miniprogram/packages/account/index.ts:57-59` | applyAuthState always overwrites avatarPath with DEFAULT_AVATAR_PATH, ignoring any | 待定 |  |
| 3 | high | bug | `miniprogram/packages/account/privacy-document/index.ts:46-50` | Cache-first strategy updates title/version/effectiveAt/content from cache, but the | 待定 |  |
| 4 | high | bug | `miniprogram/packages/account/privacy/index.ts:29-31` | The `isDeleting` concurrency guard relies on `setData`, which is asynchronous in WeChat | 待定 |  |
| 5 | high | bug | `miniprogram/packages/download/index.ts:75-76` | Null-safety bug: `authStore.getSnapshot().profile?.quota.remaining` / `.dailyFree` only | 待定 |  |
| 6 | high | bug | `miniprogram/packages/editor/index.ts:481-486` | In finishSingleTouch, after awaiting touchToGridCell, the code re-checks canvasReady | 待定 |  |
| 7 | high | bug | `miniprogram/packages/editor/services/pattern-editor-service.ts:158-161` | No guard against a zero or negative transform.scale. cellWidth/cellHeight are derived | 待定 |  |
| 8 | high | bug | `miniprogram/packages/payment/payment-success/index.ts:67-75` | Final-attempt catch sets state to 'failed', contradicting the stated design. The file | 待定 |  |
| 9 | high | bug | `miniprogram/packages/payment/recharge/index.ts:44-46` | refreshQuota assumes authStore.refreshAiQuota() returns a non-null object whose | 待定 |  |
| 10 | high | bug | `miniprogram/packages/result/index.ts:218-220` | The increment `this.favoriteRefreshToken += 1` here is dead code and does NOT protect | 待定 |  |
| 11 | high | bug | `miniprogram/packages/result/index.ts:435-436` | Quota accounting bug when cloud quota is unavailable. `recordLocalDownloadResult` | 待定 |  |
| 12 | high | bug | `miniprogram/packages/result/services/result-download-service.ts:181-185` | After await createDownload(...) the server has already deducted the quota. If | 待定 |  |
| 13 | high | bug | `miniprogram/pages/profile/index.ts:104-112` | In `applyAuthState`, when `profile` exists but `profile.quota` is undefined, the code | 待定 |  |
| 14 | high | bug | `miniprogram/pages/projects/index.ts:240-243` | In the cloud-open branch, after fetching the detail you call | 待定 |  |
| 15 | high | bug | `miniprogram/pages/projects/index.ts:379-382` | cancelAiTask's doc comment says it does "停止任务 + 删除占位作品" (stop task + delete placeholder | 待定 |  |
| 16 | high | bug | `miniprogram/services/ai-generation-flow.ts:225-234` | AiGenerationFlow lacks this.destroyed re-check after await points | 待定 |  |
| 17 | high | bug | `miniprogram/services/ai-generation-manager.ts:571-574` | Timeout uses `task.startedAt ?? task.createdAt`, but `startedAt` is `null` for any task | 待定 |  |
| 18 | high | bug | `miniprogram/services/ai-generation-parser.ts:30-33` | Legacy errorCode fallback rejects valid in-progress items. When `value.failure` is | 待定 |  |
| 19 | high | bug | `miniprogram/services/ai-generation-service.ts:0-0` | normalizeFailureCode remaps several codes whose raw forms have DIFFERENT messages in | 待定 |  |
| 20 | high | bug | `miniprogram/services/ai-task-store.ts:191-195` | Terminal-task TTL expiry is computed from `createdAt` instead of `finishedAt`. Terminal | 待定 |  |
| 21 | high | bug | `miniprogram/services/ai-task-store.ts:265-269` | Migration marks itself done BEFORE the new task is actually created, and | 待定 |  |
| 22 | high | bug | `miniprogram/services/auth-service.ts:152-156` | parseUser always returns avatarUrl: null and never reads value.avatarUrl from the | 待定 |  |
| 23 | high | security | `miniprogram/services/download-service.ts:103-103` | The `idempotencyKey` is the only protection against duplicate quota deduction on | 待定 |  |
| 24 | high | bug | `miniprogram/services/image-service.ts:256-266` | The `generationMode` parameter is accepted and stored into the returned `PatternDraft`, | 待定 |  |
| 25 | high | bug | `miniprogram/services/pattern-generation/cleanup.ts:102-102` | Replacement may corrupt grid geometry. `cleaned[index] = { ...replacement }` copies the | 待定 |  |
| 26 | high | bug | `miniprogram/services/pattern-generation/cleanup.ts:81-82` | Center color support is undercounted. `counts` only aggregates the 3x3 neighbors | 待定 |  |
| 27 | high | bug | `miniprogram/services/pattern-generation/color-utils.ts:8-9` | findNearestColor accesses palette[0] without checking whether the palette is empty. If | 待定 |  |
| 28 | high | bug | `miniprogram/services/pattern-generation/crop.ts:14-19` | No validation/guard for zero or negative dimensions. If any of sourceWidth, | 待定 |  |
| 29 | high | bug | `miniprogram/services/pattern-generation/edge-detector.ts:36-46` | Transparent pixels (alpha < OPAQUE_ALPHA_THRESHOLD) are left at luminance 0 (the | 待定 |  |
| 30 | high | bug | `miniprogram/services/pattern-generation/edge-detector.ts:64-67` | Sobel normalization by 4 is far too small and clamps almost everything to 1. The | 待定 |  |
| 31 | high | bug | `miniprogram/services/pattern-generation/oklab-matcher.ts:16-21` | Empty palette crash: if `palette` is empty, `forEach` never runs, `nearestIndex` stays | 待定 |  |
| 32 | high | bug | `miniprogram/services/pattern-generation/palette-selector.ts:138-139` | If MARD_CLASSIC_PALETTE is empty (e.g. the regex filter `/^(?:[A-H]/M)\d+$/` matches | 待定 |  |
| 33 | high | bug | `miniprogram/services/payment-service.ts:42-45` | Idempotency key is generated *inside* this function on every call (default parameter is | 待定 |  |
| 34 | high | security | `miniprogram/services/session-service.ts:14-16` | loginWithWechat() is awaited without any try/catch. If WeChat login or the | 待定 |  |
| 35 | high | bug | `miniprogram/services/token-storage.ts:52-56` | parseUser always hardcodes `avatarUrl: null` and ignores any stored `avatarUrl`. This | 待定 |  |
| 36 | high | bug | `miniprogram/store/auth-store.ts:158-159` | Offline fallback dereferences `cachedUser.id` without a null check. | 待定 |  |
| 37 | high | bug | `miniprogram/store/auth-store.ts:443-447` | The favorites pagination loop can infinite-loop if the server response does not include | 待定 |  |
| 38 | high | bug | `miniprogram/tests/pattern-generation/wechat-canvas-baseline.ts:47-52` | No per-case error handling. If `getImageInfo` or `createDraft` rejects for any single | 待定 |  |
| 39 | high | bug | `miniprogram/utils/navigation.ts:10-14` | wx.getWindowInfo() and wx.getMenuButtonBoundingClientRect() may return objects whose | 待定 |  |
| 40 | medium | bug | `miniprogram/components/editor-control-panel/index.ts:23-23` | PALETTE_PLACEHOLDER_COUNT = 16 is a hardcoded business number never reconciled with | 待定 |  |
| 41 | medium | bug | `miniprogram/components/main-tab-bar/index.ts:58-61` | When no `selected` prop is provided and the current page route does not match any tab | 待定 |  |
| 42 | medium | security | `miniprogram/components/main-tab-bar/index.ts:72-72` | `wx.switchTab({ url: item.pagePath })` is called without a `fail` callback. If | 待定 |  |
| 43 | medium | bug | `miniprogram/components/page-layout/index.ts:47-49` | `getCustomNavigationMetrics()` is called without try/catch. If it throws (e.g., | 待定 |  |
| 44 | medium | bug | `miniprogram/components/page-layout/index.ts:56-58` | `getCurrentPages()` can return an empty array in rare edge cases (e.g., component | 待定 |  |
| 45 | medium | maintainability | `miniprogram/components/page-layout/index.ts:59-59` | Main tab routes are hardcoded here. This violates the project rule | 待定 |  |
| 46 | medium | maintainability | `miniprogram/components/top-bar/index.ts:12-18` | The navigationBarHeight observer in top-bar/index.ts only updates | 待定 |  |
| 47 | medium | maintainability | `miniprogram/components/upload-status-card/index.ts:11-11` | The `uploadStatus` property is typed as `String` (the WeChat Component | 待定 |  |
| 48 | medium | maintainability | `miniprogram/config/api.ts:3-7` | All three environments (develop/trial/release) hardcode the exact same | 待定 |  |
| 49 | medium | bug | `miniprogram/config/api.ts:41-46` | buildAiFileUrl rejects valid media URLs that carry query strings or fragments because | 待定 |  |
| 50 | medium | bug | `miniprogram/config/api.ts:70-78` | getMiniProgramEnvironment silently returns 'develop' for ANY non-'trial'/'release' | 待定 |  |
| 51 | medium | bug | `miniprogram/config/cloud.ts:9-10` | wx.cloud.init() is called fire-and-forget and `initialized = true` is set | 待定 |  |
| 52 | medium | maintainability | `miniprogram/custom-tab-bar/index.ts:11-11` | The business route paths are hardcoded in the component. This violates | 待定 |  |
| 53 | medium | bug | `miniprogram/custom-tab-bar/index.ts:12-12` | If the current page route is not in the `routes` list, `indexOf` returns -1 and | 待定 |  |
| 54 | medium | maintainability | `miniprogram/models/pattern.ts:199-203` | resolveSyncFields documents itself as the ONLY place enforcing 'AI | 待定 |  |
| 55 | medium | maintainability | `miniprogram/packages/account/about/index.ts:4-19` | In packages/account/about/index.ts, multiple business navigation URLs are | 待定 |  |
| 56 | medium | performance | `miniprogram/packages/account/favorites/index.ts:171-177` | `removeFavorite` already updated local state via `appStore.setFavorite(id, | 待定 |  |
| 57 | medium | bug | `miniprogram/packages/account/favorites/index.ts:52-61` | Pagination loop in favorites/index.ts relies on server-echoed response.page and stops | 待定 |  |
| 58 | medium | bug | `miniprogram/packages/account/help/index.ts:20-21` | Dataset values can be missing or malformed. `event.currentTarget.dataset.index` may | 待定 |  |
| 59 | medium | bug | `miniprogram/packages/account/help/index.ts:25-30` | If `event.currentTarget.dataset.id` is missing/undefined, `String(undefined)` becomes | 待定 |  |
| 60 | medium | maintainability | `miniprogram/packages/account/help/index.ts:27-27` | The navigateTo URL '/packages/account/feedback/index' is a business route | 待定 |  |
| 61 | medium | bug | `miniprogram/packages/account/index.ts:100-102` | The catch block shows a hardcoded '退出前保存本地数据失败' message for ANY logout error. | 待定 |  |
| 62 | medium | bug | `miniprogram/packages/account/index.ts:47-54` | In packages/account/index.ts, applyAuthState triggers wx.navigateBack on | 待定 |  |
| 63 | medium | bug | `miniprogram/packages/account/index.ts:68-71` | Concurrency hazard: refreshAccountData guards re-entry with `if | 待定 |  |
| 64 | medium | bug | `miniprogram/packages/account/privacy-document/index.ts:51-58` | When a fetch fails but cached content already exists, the error is silently swallowed | 待定 |  |
| 65 | medium | bug | `miniprogram/packages/account/privacy-document/index.ts:62-68` | applyDocument stores the UNTRIMMED document.content into data.content, but computes | 待定 |  |
| 66 | medium | maintainability | `miniprogram/packages/account/privacy/index.ts:16-16` | The navigation URL `/packages/account/privacy-document/index?key=${key}` | 待定 |  |
| 67 | medium | maintainability | `miniprogram/packages/account/privacy/index.ts:8-11` | Session loading and validation is duplicated in `onShow` (lines 10-11) | 待定 |  |
| 68 | medium | bug | `miniprogram/packages/account/profile-edit/index.ts:11-15` | Avatar is never actually editable. `profileDraftAvatarPath` is always set to | 待定 |  |
| 69 | medium | bug | `miniprogram/packages/account/profile-edit/index.ts:34-34` | Mismatch between `profileCanSave` (only checks non-empty trimmed nickname) and | 待定 |  |
| 70 | medium | security | `miniprogram/packages/account/services/legal-document-service.ts:10-12` | `LegalDocument.content` is declared with `contentType: 'rich-text'` and is | 待定 |  |
| 71 | medium | bug | `miniprogram/packages/ai-generation/index.ts:186-189` | In packages/ai-generation/index.ts, async task calls (cancelTask in | 待定 |  |
| 72 | medium | bug | `miniprogram/packages/ai-generation/index.ts:224-231` | If `createDraft` succeeds but `cancelTask` or `setCurrentDraft` subsequently rejects, | 待定 |  |
| 73 | medium | bug | `miniprogram/packages/download/index.ts:67-69` | Data-consistency concern: only local records with `fileType === 'palette'` are merged | 待定 |  |
| 74 | medium | maintainability | `miniprogram/packages/download/index.ts:73-79` | Duplicate setData mapping in loadCloudRecords/loadLocalRecords | 待定 |  |
| 75 | medium | maintainability | `miniprogram/packages/editor/index.ts:362-371` | onWorkspaceTouchMove only handles 2-finger pinch and explicitly does NOT | 待定 |  |
| 76 | medium | bug | `miniprogram/packages/editor/index.ts:438-450` | Pinch translation math uses anchored base from _pinchStartTransform plus the live | 待定 |  |
| 77 | medium | bug | `miniprogram/packages/editor/index.ts:522-526` | Pencil colorCode is derived by searching draft.cells for a cell with matching color | 待定 |  |
| 78 | medium | bug | `miniprogram/packages/editor/index.ts:697-702` | When !hasCloudSession the work is saved with syncStatus 'guest' and never queued for | 待定 |  |
| 79 | medium | bug | `miniprogram/packages/editor/index.ts:709-713` | Cloud save id mismatch: when existing.id !== summary.id, the code deletes the | 待定 |  |
| 80 | medium | bug | `miniprogram/packages/editor/services/pattern-editor-service.ts:330-330` | Flood-fill replaces a matched cell with `{ ...replacement }`, i.e. a shallow copy of | 待定 |  |
| 81 | medium | maintainability | `miniprogram/packages/editor/services/pattern-editor-service.ts:80-92` | The bead (shadow + highlight) drawing logic here is duplicated almost | 待定 |  |
| 82 | medium | maintainability | `miniprogram/packages/payment/orders/index.ts:50-50` | fetchOrders is called with a hardcoded page:1, pageSize:20 and there is | 待定 |  |
| 83 | medium | bug | `miniprogram/packages/payment/orders/index.ts:85-85` | order.id.slice(-8) assumes `id` is a string of sufficient length. If `id` is not a | 待定 |  |
| 84 | medium | bug | `miniprogram/packages/payment/orders/index.ts:89-91` | formatFen has no null/undefined guard. If `priceFen` is undefined/null (e.g. missing | 待定 |  |
| 85 | medium | bug | `miniprogram/packages/payment/orders/index.ts:93-98` | formatDateTime does not validate the parsed date. If `value` is an invalid/empty | 待定 |  |
| 86 | medium | performance | `miniprogram/packages/payment/payment-success/index.ts:43-48` | Parallel fetch of orders on every poll is wasteful when the order is already | 待定 |  |
| 87 | medium | bug | `miniprogram/packages/payment/payment-success/index.ts:47-49` | Quota fallback can yield undefined and break setData. `quotaResponse?.aiGeneration ?? | 待定 |  |
| 88 | medium | bug | `miniprogram/packages/payment/payment-success/index.ts:48-48` | Missing null check on `ordersResponse.items`. If `fetchOrders` resolves with `items` | 待定 |  |
| 89 | medium | security | `miniprogram/packages/payment/recharge/index.ts:83-85` | purchase() does not verify the current auth/session state before calling | 待定 |  |
| 90 | medium | bug | `miniprogram/packages/payment/recharge/index.ts:90-94` | paymentLoading is reset to false twice (inside try before navigation, and again in | 待定 |  |
| 91 | medium | maintainability | `miniprogram/packages/payment/services/order-service.ts:28-28` | The API path `/api/orders` and the query-string pagination params | 待定 |  |
| 92 | medium | bug | `miniprogram/packages/payment/services/order-service.ts:69-71` | The server-returned `quotaKind` and `currency` values are validated against the | 待定 |  |
| 93 | medium | maintainability | `miniprogram/packages/result/components/download-bottom-sheet/index.ts:49-51` | This `preventTouchMove` method is an empty no-op. In WeChat Mini | 待定 |  |
| 94 | medium | maintainability | `miniprogram/packages/result/components/materials-panel/index.ts:43-48` | The preview limit constant MATERIAL_PREVIEW_LIMIT (5) is duplicated as a | 待定 |  |
| 95 | medium | maintainability | `miniprogram/packages/result/config/download.ts:26-29` | In packages/result/config/download.ts, | 待定 |  |
| 96 | medium | maintainability | `miniprogram/packages/result/index.json:6-8` | Component path correctness cannot be fully verified within this JSON file | 待定 |  |
| 97 | medium | bug | `miniprogram/packages/result/index.ts:466-480` | Inconsistent chart preview fallback. `createDownloadImage` returns `chartHdSrc // | 待定 |  |
| 98 | medium | bug | `miniprogram/packages/result/services/pattern-render-service.ts:124-125` | No guard against `draft.settings.width`/`height` being 0 or falsy. | 待定 |  |
| 99 | medium | maintainability | `miniprogram/packages/result/services/pattern-render-service.ts:128-155` | Duplicate cell-drawing loop: `drawThumbnail` and `drawPreviewImage` | 待定 |  |
| 100 | medium | bug | `miniprogram/packages/result/services/pattern-render-service.ts:300-303` | The HD chart canvas does NOT apply `devicePixelRatio` scaling (unlike | 待定 |  |
| 101 | medium | maintainability | `miniprogram/packages/result/services/result-download-service.ts:123-127` | Error classification is done by regex over the localized wx errMsg | 待定 |  |
| 102 | medium | bug | `miniprogram/packages/result/services/result-download-service.ts:157-158` | The download-record id is built with Date.now() only. Rapid successive calls (e.g. | 待定 |  |
| 103 | medium | bug | `miniprogram/packages/result/utils.ts:25-25` | summarizeMaterials keys materials by `${cell.colorCode}-${cell.color}`, but it skips | 待定 |  |
| 104 | medium | bug | `miniprogram/packages/result/utils.ts:59-65` | createDraftRenderKey computes an FNV-1a hash over a concatenation of each cell's | 待定 |  |
| 105 | medium | maintainability | `miniprogram/pages/home/index.ts:152-156` | When the page unloads while a feedback/queue tip is still visible, the | 待定 |  |
| 106 | medium | maintainability | `miniprogram/pages/home/index.ts:282-294` | The source-path and upload-status validation block here is duplicated | 待定 |  |
| 107 | medium | bug | `miniprogram/pages/home/index.ts:350-353` | If `persistImage(this.data.contentSecurityImagePath)` throws (e.g. disk/quota error), | 待定 |  |
| 108 | medium | bug | `miniprogram/pages/profile/index.ts:264-278` | Focus Area 3: `onHide` clears the `loginCloseTimer` and immediately resets the sheet | 待定 |  |
| 109 | medium | bug | `miniprogram/pages/profile/index.ts:295-307` | Focus Area 2: In `purchase()`, `paymentLoading` is set true, then set false in the | 待定 |  |
| 110 | medium | performance | `miniprogram/pages/profile/index.ts:58-61` | Focus Area 1: `appStore.subscribe` re-applies the auth snapshot on EVERY app | 待定 |  |
| 111 | medium | bug | `miniprogram/pages/projects/index.ts:319-328` | persistRename captures `work` from the snapshot BEFORE awaiting checkTextContent and | 待定 |  |
| 112 | medium | maintainability | `miniprogram/pages/projects/index.ts:355-362` | downloadWork does not actually download anything — it just resets nav | 待定 |  |
| 113 | medium | bug | `miniprogram/services/ai-generation-manager.ts:179-181` | The queue-full guard uses `listActiveAiTasks().length >= QUEUE_MAX`. | 待定 |  |
| 114 | medium | bug | `miniprogram/services/ai-generation-manager.ts:448-461` | The succeeded branch of `applyTaskToWorkItem` only patches the work when `existing` | 待定 |  |
| 115 | medium | bug | `miniprogram/services/ai-generation-parser.ts:133-135` | `isIsoTime` is too lenient and violates the assumed ISO-8601 contract. It only checks | 待定 |  |
| 116 | medium | bug | `miniprogram/services/ai-generation-service.ts:292-292` | The guard `error.retryable !== null` is too loose. `undefined !== null` is true, so | 待定 |  |
| 117 | medium | bug | `miniprogram/services/ai-generation-service.ts:335-336` | Client-side input validation failure reuses the code 'INVALID_RESPONSE', which the | 待定 |  |
| 118 | medium | bug | `miniprogram/services/ai-generation-service.ts:378-380` | When the caught error is NOT an ApiError (e.g. an unexpected throw, a timeout thrown | 待定 |  |
| 119 | medium | bug | `miniprogram/services/ai-task-store.ts:198-207` | When the number of NON-terminal tasks exceeds MAX_TASKS, the overflow eviction only | 待定 |  |
| 120 | medium | bug | `miniprogram/services/ai-task-store.ts:239-240` | Orphan image cleanup derives file age purely from the filename prefix | 待定 |  |
| 121 | medium | maintainability | `miniprogram/services/ai-task-store.ts:306-312` | All mutations (createAiTask, patchAiTask, removeAiTask, prune*) route | 待定 |  |
| 122 | medium | bug | `miniprogram/services/auth-service.ts:110-118` | createdAt and quota.resetsAt are only checked as typeof string, but never validated | 待定 |  |
| 123 | medium | maintainability | `miniprogram/services/auth-service.ts:16-20` | Business API URL paths ('/api/auth/login', '/api/users/me') are hardcoded | 待定 |  |
| 124 | medium | bug | `miniprogram/services/content-security-service.ts:19-31` | The file-level doc comment states '检测成功返回 safe=true 与 checkId，供后续 AI 任务关联', but | 待定 |  |
| 125 | medium | maintainability | `miniprogram/services/content-security-service.ts:61-80` | The apiUploadFile call with identical parameters is duplicated (lines | 待定 |  |
| 126 | medium | bug | `miniprogram/services/content-security-service.ts:91-94` | parseImageContentCheck only models the success case (ImageContentCheck has safe: | 待定 |  |
| 127 | medium | bug | `miniprogram/services/download-service.ts:123-123` | `Date.parse(record.downloadedAt)` is called without guarding against an invalid | 待定 |  |
| 128 | medium | maintainability | `miniprogram/services/download-service.ts:59-59` | API endpoint paths are hardcoded inline in multiple functions | 待定 |  |
| 129 | medium | bug | `miniprogram/services/download-service.ts:78-78` | Inconsistent query-string encoding: `query` is encoded with `encodeURIComponent` but | 待定 |  |
| 130 | medium | performance | `miniprogram/services/http-client.ts:73-78` | Duplicate request-setup logic between apiRequest and apiUploadFile: both | 待定 |  |
| 131 | medium | bug | `miniprogram/services/http-client.ts:95-98` | Success path casts `response.data` directly to `T` without verifying its shape. If | 待定 |  |
| 132 | medium | maintainability | `miniprogram/services/image-service.ts:101-111` | The offscreen-canvas creation, image-load Promise, `drawImage`, and | 待定 |  |
| 133 | medium | maintainability | `miniprogram/services/image-service.ts:288-291` | On copy failure, `persistImage` returns the original temporary path with | 待定 |  |
| 134 | medium | security | `miniprogram/services/image-service.ts:69-76` | When `readFileHeader` rejects with a non-format error (anything other than | 待定 |  |
| 135 | medium | maintainability | `miniprogram/services/pattern-generation/cell-sampler.ts:18-20` | Focus area #3: The error message '采样图片数据尺寸不匹配' provides no diagnostic | 待定 |  |
| 136 | medium | maintainability | `miniprogram/services/pattern-generation/cleanup.ts:79-80` | Redundant/dead guard on small neighborhoods. With at most 8 neighbors, | 待定 |  |
| 137 | medium | bug | `miniprogram/services/pattern-generation/color-space.ts:15-16` | This function assumes `channel` is a valid sRGB byte in [0, 255] but performs no | 待定 |  |
| 138 | medium | bug | `miniprogram/services/pattern-generation/color-utils.ts:24-26` | rgbToHex does not validate that r/g/b are integers within 0-255. Negative values | 待定 |  |
| 139 | medium | bug | `miniprogram/services/pattern-generation/crop.ts:29-34` | When sourceWidth or sourceHeight equals 0/negative, or when targetRatio is | 待定 |  |
| 140 | medium | bug | `miniprogram/services/pattern-generation/edge-detector.ts:93-99` | Validation permits width === 0 or height === 0 (only `width < 0` / `height < 0` are | 待定 |  |
| 141 | medium | bug | `miniprogram/services/pattern-generation/median-cut.ts:51-54` | The selected `bucket` is a reference to the caller's `pixels` array (the first | 待定 |  |
| 142 | medium | bug | `miniprogram/services/pattern-generation/palette-selector.ts:153-159` | hexToRgb assumes a strict '#RRGGBB' format with no validation. If any entry in | 待定 |  |
| 143 | medium | maintainability | `miniprogram/services/pattern-generation/standard-generator.ts:51-54` | generateStandardPatternCells is an async entry function but has no | 待定 |  |
| 144 | medium | bug | `miniprogram/services/payment-service.ts:133-146` | parsePackage validates several server fields (quotaAmount, quotaKind, membershipType, | 待定 |  |
| 145 | medium | bug | `miniprogram/services/payment-service.ts:69-77` | requestWechatPayment rejects with the raw wx error object (a plain object like | 待定 |  |
| 146 | medium | security | `miniprogram/services/payment-service.ts:80-82` | The idempotency key is built from Date.now() + Math.random(), which is not | 待定 |  |
| 147 | medium | maintainability | `miniprogram/services/payment-service.ts:85-88` | isWechatPaymentCancelled relies on a substring match of | 待定 |  |
| 148 | medium | bug | `miniprogram/services/session-service.ts:11-13` | securitySession is only updated on successful login and never invalidated if token | 待定 |  |
| 149 | medium | maintainability | `miniprogram/services/token-storage.ts:15-17` | saveAuthSession calls `wx.setStorageSync` without any error handling. On | 待定 |  |
| 150 | medium | maintainability | `miniprogram/services/token-storage.ts:62-62` | Redundant/confused control flow: after `parseUser(value.user)` already | 待定 |  |
| 151 | medium | bug | `miniprogram/services/work-service.ts:217-218` | Date fields are parsed with Date.parse and assigned directly into numeric fields | 待定 |  |
| 152 | medium | bug | `miniprogram/services/work-service.ts:307-307` | The idempotency key is derived from draft.id. If draft.id is empty/undefined/reused | 待定 |  |
| 153 | medium | bug | `miniprogram/services/work-sync-service.ts:23-23` | When the local draft is missing, the work is marked with syncStatus 'failed' but | 待定 |  |
| 154 | medium | bug | `miniprogram/services/work-sync-service.ts:36-37` | On a network error the work status is set to 'pending' (so it will be retried on the | 待定 |  |
| 155 | medium | bug | `miniprogram/store/app-store.ts:111-111` | The guard for adopting the guest's in-progress draft uses `ids` (the set of guest | 待定 |  |
| 156 | medium | bug | `miniprogram/store/app-store.ts:144-145` | This non-AI branch writes syncStatus/ownerId/isCloud directly instead of going | 待定 |  |
| 157 | medium | performance | `miniprogram/store/auth-store.ts:178-193` | Both `refreshQuota` and `refreshAiQuota` read `this.state.profile` and then | 待定 |  |
| 158 | medium | bug | `miniprogram/store/auth-store.ts:340-342` | The optimistic remaining calc `Math.max(0, nextFreeQuota + profile.quota.purchased)` | 待定 |  |
| 159 | medium | maintainability | `miniprogram/tests/pattern-generation/standard-generator-phase-3.ts:48-48` | The local `Canvas2DContext` interface redeclares | 待定 |  |
| 160 | medium | maintainability | `miniprogram/tests/pattern-generation/standard-generator-phase-3.ts:76-76` | The alpha cutoff `< 32` is a magic number duplicated in two places (here | 待定 |  |
| 161 | medium | bug | `miniprogram/tests/pattern-generation/standard-generator-phase-3.ts:78-90` | The palette index lookup is both fragile and redundant. `findNearestColorOklab` | 待定 |  |
| 162 | medium | bug | `miniprogram/tests/pattern-generation/wechat-canvas-baseline.ts:119-119` | `derivePalette` sorts by `leftCode.localeCompare(rightCode)`, which is | 待定 |  |
| 163 | medium | bug | `miniprogram/tests/pattern-generation/wechat-canvas-baseline.ts:133-133` | No null/undefined guard on `wx.env.USER_DATA_PATH`. The code assumes the env value | 待定 |  |
| 164 | medium | maintainability | `miniprogram/tests/pattern-generation/wechat-canvas-baseline.ts:48-48` | Hardcoded test-asset base path `/test-assets/pattern-generation/` is | 待定 |  |
| 165 | medium | bug | `miniprogram/tests/pattern-generation/wechat-canvas-phase-3.ts:6-9` | The async callback passed to runWechatCanvasBaseline awaits | 待定 |  |
| 166 | medium | bug | `miniprogram/tests/pattern-generation/wechat-canvas-phase-5.ts:4-6` | According to the project's async handling standard, async functions must include | 待定 |  |
| 167 | medium | bug | `miniprogram/tests/pattern-generation/wechat-canvas-runner.ts:134-136` | fnv1a32 concatenates cells using '/' and cells use ':' as delimiter | 待定 |  |
| 168 | medium | bug | `miniprogram/tests/pattern-generation/wechat-canvas-runner.ts:139-143` | derivePalette keys by colorCode but stores the first-seen color string. If two cells | 待定 |  |
| 169 | medium | maintainability | `miniprogram/tests/pattern-generation/wechat-canvas-runner.ts:28-35` | WechatCanvasOutput.sampleScale is declared as the literal type `4` | 待定 |  |
| 170 | medium | maintainability | `miniprogram/utils/navigation.ts:30-30` | The home tab path '/pages/home/index' is hardcoded. Per project rules, | 待定 |  |
| 171 | low | maintainability | `miniprogram/app.ts:17-23` | `runStartupSafely` only catches SYNCHRONOUS throws (it calls `run()` without | 待定 |  |
| 172 | low | other | `miniprogram/components/main-tab-bar/index.json:2-2` | The JSON key 'component' is correctly spelled per WeChat miniprogram custom component | 待定 |  |
| 173 | low | maintainability | `miniprogram/components/main-tab-bar/index.ts:28-31` | The `items` array is duplicated: it is declared at module scope AND assigned | 待定 |  |
| 174 | low | bug | `miniprogram/components/main-tab-bar/index.ts:28-31` | `data.currentSelected` defaults to 0 while `properties.selected` defaults to -1. On | 待定 |  |
| 175 | low | maintainability | `miniprogram/components/page-layout/index.ts:12-12` | `selectedTab` property is declared but never read or used anywhere in the | 待定 |  |
| 176 | low | maintainability | `miniprogram/components/top-bar/index.ts:20-24` | Hardcoded fallback magic numbers (`statusBarHeight: 20`, `menuButtonReserve: | 待定 |  |
| 177 | low | maintainability | `miniprogram/components/upload-status-card/index.ts:12-13` | The `uploadProgress` property documents that `-1` means the SDK provided no | 待定 |  |
| 178 | low | maintainability | `miniprogram/config/product.ts:5-5` | The brand value 'MARD' in config/product.ts is a hardcoded business string | 待定 |  |
| 179 | low | maintainability | `miniprogram/custom-tab-bar/index.ts:18-18` | The `switchTab` method does not handle the failure callback of | 待定 |  |
| 180 | low | maintainability | `miniprogram/custom-tab-bar/index.ts:4-4` | The `hidden` field is declared in `data` but is never read or updated | 待定 |  |
| 181 | low | maintainability | `miniprogram/models/pattern.ts:123-123` | `index` is already typed as `number` because `payload.cells` is `number[]` | 待定 |  |
| 182 | low | bug | `miniprogram/models/pattern.ts:176-178` | `status` is optional on WorkItem. `isWorkDraft` returns `work.status !== 'completed'`, | 待定 |  |
| 183 | low | bug | `miniprogram/models/pattern.ts:99-99` | The dedup key uses `cell.color.toLowerCase()`, so two cells whose only difference is | 待定 |  |
| 184 | low | bug | `miniprogram/packages/account/about/index.ts:24-24` | If the tapped item's dataset.id is not one of the handled keys, messages[id] is | 待定 |  |
| 185 | low | maintainability | `miniprogram/packages/account/config/help.ts:4-4` | Several help answer strings in packages/account/config/help.ts are missing | 待定 |  |
| 186 | low | bug | `miniprogram/packages/account/favorites/index.json:2-4` | JSON keys 'usingComponents' and the custom component tag name 'page-layout' are | 待定 |  |
| 187 | low | maintainability | `miniprogram/packages/account/favorites/index.ts:93-97` | The `.map((work) => ...)` callback parameter is named `work`, which SHADOWS | 待定 |  |
| 188 | low | security | `miniprogram/packages/account/help/index.ts:11-12` | Minor hardening: user input `query` is passed straight into `setData` and rendered | 待定 |  |
| 189 | low | maintainability | `miniprogram/packages/account/privacy-document/index.ts:34-35` | onLoad sets the title from the local TITLES constant, but applyDocument | 待定 |  |
| 190 | low | maintainability | `miniprogram/packages/account/privacy-document/index.ts:80-85` | Legal document key values are hardcoded in multiple places (TITLES keys, | 待定 |  |
| 191 | low | maintainability | `miniprogram/packages/account/privacy/index.ts:15-15` | The whitelist check for `key` (`privacy-policy`, `personal-information`, | 待定 |  |
| 192 | low | performance | `miniprogram/packages/account/profile-edit/index.ts:19-19` | authStore.getSnapshot() is called twice in one expression/function | 待定 |  |
| 193 | low | maintainability | `miniprogram/packages/account/profile-edit/index.ts:19-20` | When both `snapshot.profile?.user` and `snapshot.user` are undefined, `user` | 待定 |  |
| 194 | low | bug | `miniprogram/packages/account/services/legal-document-service.ts:24-28` | When a cached value exists in `wx` storage but `parseDocument(raw)` returns `null` | 待定 |  |
| 195 | low | maintainability | `miniprogram/packages/account/services/legal-document-service.ts:30-33` | Both `getCachedLegalDocument` and `saveCachedLegalDocument` silently swallow | 待定 |  |
| 196 | low | maintainability | `miniprogram/packages/account/services/legal-document-service.ts:49-52` | `fetchLegalDocument` only checks `isRecord(response)` and then reads | 待定 |  |
| 197 | low | maintainability | `miniprogram/packages/account/settings/index.ts:2-13` | In settings/index.ts, four navigation handlers repeat wx.navigateTo with | 待定 |  |
| 198 | low | maintainability | `miniprogram/packages/ai-generation/index.ts:219-223` | When `getTaskView` returns null, this calls `selectNewImage()`, which in | 待定 |  |
| 199 | low | bug | `miniprogram/packages/editor/index.ts:560-561` | Undo/redo snapshots deep-copy only one level: cells.map((cell) => ({ ...cell })) clones | 待定 |  |
| 200 | low | maintainability | `miniprogram/packages/editor/index.ts:685-686` | Hardcoded title fallback string '未命名作品' appears in multiple places | 待定 |  |
| 201 | low | performance | `miniprogram/packages/editor/services/pattern-editor-service.ts:128-130` | This function uses raw Promise + nested wx callback style, which the project's | 待定 |  |
| 202 | low | maintainability | `miniprogram/packages/payment/orders/index.ts:0-0` | Orders with status 'pending' are shown but the page provides no 'pay' action | 待定 |  |
| 203 | low | bug | `miniprogram/packages/payment/orders/index.ts:80-80` | statusLabels lookup has no fallback. If `order.status` is a valid OrderStatus value not | 待定 |  |
| 204 | low | maintainability | `miniprogram/packages/payment/payment-success/index.ts:50-54` | No logging/observability when the order is missing from the list during | 待定 |  |
| 205 | low | maintainability | `miniprogram/packages/payment/recharge/index.ts:33-38` | The quota-deriving setData block is duplicated between onShow and | 待定 |  |
| 206 | low | security | `miniprogram/packages/payment/services/order-service.ts:87-89` | `isIsoDate` uses `Date.parse(value)`, which accepts many non-ISO strings such as | 待定 |  |
| 207 | low | maintainability | `miniprogram/packages/result/components/download-bottom-sheet/index.ts:26-39` | The guard `if (this.data.state === 'processing') return` is duplicated | 待定 |  |
| 208 | low | maintainability | `miniprogram/packages/result/components/download-bottom-sheet/index.ts:7-10` | The `state` property accepts any string with default 'closed', and the | 待定 |  |
| 209 | low | maintainability | `miniprogram/packages/result/components/download-quota-bar/index.ts:18-20` | Event names emitted via `triggerEvent` are all lowercase ('toggletips', | 待定 |  |
| 210 | low | maintainability | `miniprogram/packages/result/components/download-quota-bar/index.ts:30-30` | The `keepTipsOpen` method has an empty body and is not referenced anywhere | 待定 |  |
| 211 | low | bug | `miniprogram/packages/result/components/materials-panel/index.ts:44-47` | The observer guards against a null/undefined `materials` array but does not validate the | 待定 |  |
| 212 | low | maintainability | `miniprogram/packages/result/components/palette-panel/index.ts:19-22` | In palette-panel/index.ts, downloadingType and downloadLoading properties | 待定 |  |
| 213 | low | maintainability | `miniprogram/packages/result/components/palette-panel/index.ts:3-3` | PALETTE_PREVIEW_LIMIT is a business-related hardcoded constant. Per the | 待定 |  |
| 214 | low | other | `miniprogram/packages/result/index.json:2-3` | JSON keys 'disableScroll' and 'usingComponents' are spelled correctly. No json-key | 待定 |  |
| 215 | low | maintainability | `miniprogram/packages/result/index.ts:366-376` | Duplicate code: `handleCancelDownload` and `handleCloseDownloadSheet` are | 待定 |  |
| 216 | low | maintainability | `miniprogram/packages/result/services/pattern-render-service.ts:101-114` | Inconsistent canvas querying: `drawThumbnail` and `drawChartHdCanvas` inline | 待定 |  |
| 217 | low | bug | `miniprogram/packages/result/services/pattern-render-service.ts:342-343` | `height` is taken from the caller with no validation. If `height` is 0, NaN, or | 待定 |  |
| 218 | low | maintainability | `miniprogram/packages/result/services/pattern-render-service.ts:54-55` | TypeScript `any` is used for `ComponentContext` but there is only an | 待定 |  |
| 219 | low | performance | `miniprogram/packages/result/services/pattern-render-service.ts:98-99` | `wx.getWindowInfo()` is invoked twice here (windowWidth then pixelRatio). | 待定 |  |
| 220 | low | maintainability | `miniprogram/packages/result/services/result-download-service.ts:53-55` | Layout coordinates/sizes are hardcoded across both drawing functions (row | 待定 |  |
| 221 | low | bug | `miniprogram/packages/result/utils.ts:80-82` | getTextColor validates only that the (stripped) hex string length === 6, but does not | 待定 |  |
| 222 | low | other | `miniprogram/pages/home/index.ts:0-0` | `currentUploadRequestId` is a module-level mutable shared by all Page instances and is | 待定 |  |
| 223 | low | maintainability | `miniprogram/pages/home/index.ts:140-143` | `AI_MODE_ENABLED` is hardcoded to `true`, so the `!AI_MODE_ENABLED` branch | 待定 |  |
| 224 | low | maintainability | `miniprogram/pages/profile/index.ts:128-128` | `loginMessageTone` is hardcoded to 'error' in `applyAuthState` regardless of | 待定 |  |
| 225 | low | maintainability | `miniprogram/pages/profile/index.ts:130-135` | Duplicate logic: the block that initializes profile draft fields | 待定 |  |
| 226 | low | maintainability | `miniprogram/pages/profile/index.ts:162-182` | Focus Area 4: Multiple `wx.navigateTo`/`wx.switchTab` calls use hardcoded | 待定 |  |
| 227 | low | maintainability | `miniprogram/pages/projects/index.ts:461-463` | formatDateTime builds the date string with a .map index check that is harder | 待定 |  |
| 228 | low | bug | `miniprogram/pages/projects/index.ts:79-81` | onShow subscribes to aiTaskManager only if `!this._unsubscribeAiTask`. If subscribeAll | 待定 |  |
| 229 | low | bug | `miniprogram/services/ai-generation-flow.ts:205-207` | Inconsistent `processingSince` handling vs `transition()`. Here `applyTaskStatus` | 待定 |  |
| 230 | low | maintainability | `miniprogram/services/ai-generation-flow.ts:417-419` | Dead code: `resolvedFailure` is assigned via `failure ?? | 待定 |  |
| 231 | low | maintainability | `miniprogram/services/ai-generation-manager.ts:210-216` | Retry without a `jobId` sets status to `'created'`. This works because | 待定 |  |
| 232 | low | maintainability | `miniprogram/services/ai-generation-manager.ts:274-276` | `resolveTaskId` picks `active[active.length - 1]` as the latest active task, | 待定 |  |
| 233 | low | performance | `miniprogram/services/ai-generation-manager.ts:426-437` | `handleFlowChange` destroys a finished flow and calls `applyTaskToWorkItem` + | 待定 |  |
| 234 | low | maintainability | `miniprogram/services/ai-generation-parser.ts:20-20` | Compound-condition ternary on `generationMode` silently coerces invalid | 待定 |  |
| 235 | low | maintainability | `miniprogram/services/ai-generation-service.ts:431-431` | Single-source-of-truth violation: the same error code has two different user | 待定 |  |
| 236 | low | security | `miniprogram/services/auth-service.ts:78-78` | The token validity check requires token.length < 16 to throw, a hardcoded heuristic | 待定 |  |
| 237 | low | security | `miniprogram/services/content-security-service.ts:103-105` | logContentSecurityError logs error.details (and requestId) to console.error. On a | 待定 |  |
| 238 | low | maintainability | `miniprogram/services/download-service.ts:138-139` | These checks force `membershipType` and `membershipExpiresAt` to ALWAYS be | 待定 |  |
| 239 | low | maintainability | `miniprogram/services/http-client.ts:90-90` | Operator precedence subtlety: `options.method as | 待定 |  |
| 240 | low | security | `miniprogram/services/hunyuan-image-service.ts:108-111` | The raw cloud-storage error (`file?.errMsg` / `error.message`) is captured into | 待定 |  |
| 241 | low | maintainability | `miniprogram/services/hunyuan-image-service.ts:115-120` | `parseCloudFunctionResult` only asserts the result is a non-array object; it | 待定 |  |
| 242 | low | bug | `miniprogram/services/hunyuan-image-service.ts:50-53` | `String.length` counts UTF-16 code units, not user-perceived characters. Astral-plane | 待定 |  |
| 243 | low | maintainability | `miniprogram/services/hunyuan-image-service.ts:58-62` | `slow: true` is not a documented parameter of `wx.cloud.callFunction`. The | 待定 |  |
| 244 | low | performance | `miniprogram/services/pattern-generation/cell-sampler.ts:44-46` | srgbByteToLinear is called for every channel of every sample (including when | 待定 |  |
| 245 | low | bug | `miniprogram/services/pattern-generation/cell-sampler.ts:51-55` | When alphaSum > 0 but every sampled pixel has alpha exactly 0, the code cannot reach | 待定 |  |
| 246 | low | maintainability | `miniprogram/services/pattern-generation/color-space.ts:58-58` | This module exposes `linearToSrgbByte` (linear → sRGB byte) but provides no | 待定 |  |
| 247 | low | bug | `miniprogram/services/pattern-generation/median-cut.ts:102-103` | Empty-bucket NaN risk: `averageColor` divides each channel sum by `bucket.length`. | 待定 |  |
| 248 | low | bug | `miniprogram/services/pattern-generation/median-cut.ts:38-41` | There is no validation of `candidateLimit`. If `candidateLimit <= 0` (or a non-positive | 待定 |  |
| 249 | low | performance | `miniprogram/services/pattern-generation/oklab-matcher.ts:27-27` | Repeated pixel conversion: `rgbToOklab(pixel)` is recomputed on every call to | 待定 |  |
| 250 | low | bug | `miniprogram/services/pattern-generation/palette-selector.ts:115-115` | The early-stop check compares an absolute loss delta against Number.EPSILON (~2.22e-16), | 待定 |  |
| 251 | low | maintainability | `miniprogram/services/pattern-generation/palette-selector.ts:64-68` | When all candidate weights are 0 (all-zero-weight input), seedCandidateIndex | 待定 |  |
| 252 | low | maintainability | `miniprogram/services/pattern-generation/standard-generator.ts:64-64` | The custom Canvas2DContext interface is cast from the real wx 2d context | 待定 |  |
| 253 | low | bug | `miniprogram/services/payment-service.ts:156-158` | formatPrice uses regex /\.?0+$/ to strip trailing zeros. For priceFen values like 100 | 待定 |  |
| 254 | low | security | `miniprogram/services/token-storage.ts:34-34` | Token validation only checks that it is a string with length >= 16. There is no | 待定 |  |
| 255 | low | maintainability | `miniprogram/services/work-service.ts:329-330` | Consider extracting the duplicated list-shape validation | 待定 |  |
| 256 | low | maintainability | `miniprogram/services/work-service.ts:347-349` | Redundant/unreachable guard: parseWorkSummary(item) already throws when item | 待定 |  |
| 257 | low | maintainability | `miniprogram/services/work-service.ts:356-357` | Dead/redundant guard: parseWorkSummary(value) already throws via | 待定 |  |
| 258 | low | maintainability | `miniprogram/services/work-sync-service.ts:19-19` | The sync silently returns zero counts when `appStore.getActiveUserId() !== | 待定 |  |
| 259 | low | performance | `miniprogram/services/work-sync-service.ts:21-21` | Works are uploaded strictly one-by-one with fully awaited sequential steps | 待定 |  |
| 260 | low | other | `miniprogram/sitemap.json:2-2` | JSON key 'desc' is correctly spelled (valid WeChat sitemap.json key). No issue. | 待定 |  |
| 261 | low | other | `miniprogram/sitemap.json:3-3` | JSON keys 'rules', 'action', and 'page' are all correctly spelled (valid WeChat | 待定 |  |
| 262 | low | performance | `miniprogram/store/app-store.ts:223-224` | refreshDownloadQuota() is a getter-style method that mutates state (resets | 待定 |  |
| 263 | low | bug | `miniprogram/store/app-store.ts:255-258` | persist() returns the chained writeTask, and persistWithRecovery() deliberately rethrows | 待定 |  |
| 264 | low | maintainability | `miniprogram/store/auth-store.ts:171-173` | The `refreshQuota` and `refreshAiQuota` methods are near-identical (same | 待定 |  |
| 265 | low | bug | `miniprogram/store/auth-store.ts:250-255` | On a 401 during `saveProfile`, the code calls `loginWithWechat()` and retries | 待定 |  |
| 266 | low | bug | `miniprogram/tests/pattern-generation/wechat-canvas-baseline.ts:126-127` | FNV-1a hash operates on octets, but `value.charCodeAt(index)` returns a UTF-16 code unit | 待定 |  |
| 267 | low | performance | `miniprogram/tests/pattern-generation/wechat-canvas-baseline.ts:47-51` | CASES are fully independent (no case depends on another's result), yet they are | 待定 |  |
| 268 | low | maintainability | `miniprogram/tests/pattern-generation/wechat-canvas-phase-3.ts:6-6` | The callback parameter sourcePath is passed straight to | 待定 |  |
| 269 | low | maintainability | `miniprogram/tests/pattern-generation/wechat-canvas-phase-5.ts:4-6` | This file is a thin wrapper that only forwards a constant argument (5) to | 待定 |  |
