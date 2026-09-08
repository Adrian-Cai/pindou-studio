> 审计时间：2026-08-26  
> 项目版本：0.3.0  
> 审计方式：纯代码阅读，不修改任何文件

---

## 1. 执行摘要

拼豆工作室是一款将图片转换为拼豆图纸的微信小程序前端已基本完成，**全部业务数据目前通过单个 `wx.Storage` key（`pindou-app-state-v1`）存储在客户端本地**，不存在任何真实后端请求

核心业务流：**上传图片 → 客户端量化像素 → 编辑 → 保存作品 → 查看结果 / 材料清单 / 施工图 → 下载（待实现）**

目前已明确留有接入边界的功能（代码中有 `待接入` toast）：

| 待接入能力 | 代码位置 |
|---------|---------|
| 账号登录 | `profile/index.ts` L79 |
| 历史作品详情 | `projects/index.ts` L103，`favorites/index.ts` L88 |
| 文件导出/下载 | `downloads/index.ts` L86 |
| 云同步 | `privacy/index.ts` L19 |
| 反馈提交 | `feedback/index.ts` L58 |
| 微信支付 | `profile/index.ts` L73，`recharge/index.ts` L22 |

---

## 2. 当前项目数据流概览

```
用户手机本地图片
    │
    ▼  wx.chooseMedia()
临时文件路径（tempFilePath）
    │
    ▼  image-service.ts → createDraft()  [完全在客户端运行]
PatternDraft
  - id: 'draft-' + Date.now()     ← 前端生成
  - sourceImagePath: tempFilePath  ← 临时路径，重启失效
  - cells: PatternCell[]           ← 客户端像素量化结果
  - settings: PatternSettings
    │
    ▼  appStore.setCurrentDraft()
内存状态（AppStore）
    │
    ▼  wx.setStorage('pindou-app-state-v1')
本地 Storage（所有持久化数据）
  - currentDraft
  - works: WorkItem[]              ← 作品列表
  - favoriteIds: string[]          ← 收藏 ID 列表
  - downloadQuota: 3               ← 硬编码初始值
  - downloadRecords: DownloadRecord[]
  - privacyPreferences
```

**没有任何网络请求发生**

---

## 3. 页面清单

| 页面 | 路径 | TabBar |
|-----|------|--------|
| 首页制作 | `pages/home/index` | ✅ Tab 0 |
| 图案编辑 | `pages/editor/index` | — |
| 作品结果 | `pages/result/index` | — |
| 我的作品 | `pages/projects/index` | ✅ Tab 1 |
| 我的 | `pages/profile/index` | ✅ Tab 2 |
| 我的收藏 | `pages/favorites/index` | — |
| 下载记录 | `pages/downloads/index` | — |
| 使用帮助 | `pages/help/index` | — |
| 意见反馈 | `pages/feedback/index` | — |
| 隐私设置 | `pages/privacy/index` | — |
| 关于我们 | `pages/about/index` | — |
| 下载次数 | `pages/recharge/index` | — |
| 支付成功 | `pages/payment-success/index` | — |

---

## 4. 页面交互审计

### 首页制作（`pages/home/index`）

**用户操作：**
- 点击上传图片（`wx.chooseMedia`）
- 选择尺寸（32/48/64/96/128）
- 选择颜色数量（16/32/64/96）
- 点击"开始制作"

**当前数据来源：**  
- 图片：来自用户相册/相机，**临时路径**
- 设置参数：页面 `data.settings`（含硬编码默认值）
- 量化处理：`image-service.ts` → `createDraft()`，**完全客户端计算**，使用 `wx.createOffscreenCanvas` + 中位切分色彩量化算法

**需要后端：**

| 操作 | 是否需要后端 | 原因 |
|-----|-----------|------|
| 图片量化生成 draft | ⚠️ 待定 | 目前客户端实现，大图/弱网可能体验差；未来是否迁移服务器未确认 |
| 跳转编辑页 | ❌ | 纯前端路由 + 内存状态传递 |

---

### 图案编辑（`pages/editor/index`）

**用户操作：**
- 查看拼豆预览（Canvas 绘制）
- 缩放画面
- 切换工具（撤销/重做/吸管/填充/橡皮擦）—— 注：工具 UI 存在，**填充/擦除/撤销实际业务逻辑尚未实现**
- 选择色板颜色
- 点击"保存并查看"

**当前数据来源：**  
- `appStore.getSnapshot().currentDraft`（内存）

**执行后操作：**  
`appStore.saveWork(WorkItem)` → 写入 Storage  
跳转 `pages/result/index`

**需要后端：**

| 操作 | 是否需要后端 | 原因 |
|-----|-----------|------|
| 工具操作（缩放/色板切换） | ❌ | 纯前端 UI 状态 |
| 保存作品 | ✅ | 当前写 Storage，需要云端持久化 |

---

### 作品结果（`pages/result/index`）

**用户操作：**
- 查看成品图（Tab：preview）
- 查看材料清单（Tab：materials）
- 查看施工图（Tab：chart）
- 查看色板参考（Tab：palette）
- 收藏/取消收藏
- 点击"下载成品图"→ 跳转下载记录页
- 点击"下载施工图"→ 跳转下载记录页
- 分享（`onShareAppMessage`）
- 查看下载方案
- 返回首页/作品列表

**当前数据来源：**  
`appStore.getSnapshot().currentDraft`（内存）+ `appStore.getSnapshot().works`  
材料清单 `summarizeMaterials(draft)` **客户端计算**

**需要后端：**

| 操作 | 是否需要后端 | 原因 |
|-----|-----------|------|
| 成品图/施工图/材料清单渲染 | ⚠️ 待定 | 客户端 Canvas 实现，是否需要云端生成未确认 |
| 收藏/取消收藏 | ✅ | 当前写 Storage，需要关联用户云端数据 |
| 下载成品图/施工图 | ✅ | `redownload()` toast "文件导出服务待接入"；需要云端文件生成+扣除额度 |
| Tab 切换 | ❌ | 纯前端 UI 状态 |
| 分享 | ❌→⚠️ | 当前分享固定跳首页；若未来支持分享他人作品则需要 API |

---

### 我的作品（`pages/projects/index`）

**用户操作：**
- 查看作品列表（Tab：全部/最近/草稿/已完成）
- 搜索作品（按标题）
- 筛选/排序
- 点击作品（仅当前 draft 可查看，历史作品 toast"待接入"）
- 菜单：收藏/下载/删除

**当前数据来源：**  
`appStore.getSnapshot().works`（Storage）

**需要后端：**

| 操作 | 是否需要后端 | 原因 |
|-----|-----------|------|
| 作品列表 | ✅ | 当前为 Storage，需要云端跨设备同步 |
| 搜索/筛选/排序 | ❌→⚠️ | 当前纯前端过滤，数据量小可继续前端过滤 |
| 打开历史作品详情 | ✅ | 明确 toast"历史作品详情服务待接入" |
| 收藏切换 | ✅ | 同上 |
| 删除作品 | ✅ | 需要云端同步删除 |

---

### 我的（`pages/profile/index`）

**用户操作：**
- 点击用户卡片登录（toast"账号登录能力待接入"）
- 查看今日下载额度
- 点击"获取更多次数"→ 弹出套餐 Sheet
- 选择套餐 → 点击支付（toast"支付能力尚未接入"）
- 导航到各子页面

**当前数据来源：**  
`appStore.getSnapshot()`（Storage）  
套餐数据：`DOWNLOAD_PACKAGES`（**硬编码**）

**需要后端：**

| 操作 | 是否需要后端 | 原因 |
|-----|-----------|------|
| 用户信息展示 | ✅ | 登录后需展示真实用户名/头像 |
| 下载额度显示 | ✅ | 当前从 Storage 读硬编码值 3 |
| 购买套餐/支付 | ✅ | 微信支付待接入 |
| 统计数字（作品/下载/收藏数） | ✅ | 需与云端数据同步 |
| 套餐列表 | ⚠️ | 当前硬编码，建议后端下发（便于调价） |

---

### 我的收藏（`pages/favorites/index`）

**用户操作：**
- 查看收藏列表（Tab：全部/最近收藏/灵感图/已完成作品）
- 搜索/排序
- 打开收藏作品（历史作品 toast"待接入"）
- 取消收藏

**需要后端：**

| 操作 | 是否需要后端 | 原因 |
|-----|-----------|------|
| 收藏列表 | ✅ | 当前 Storage，需云端同步 |
| 取消收藏 | ✅ | 同上 |
| 搜索排序 | ❌ | 纯前端过滤 |

---

### 下载记录（`pages/downloads/index`）

**用户操作：**
- 查看下载记录（Tab：全部/成品图/施工图/材料清单）
- 搜索/筛选/排序
- 点击"重新下载"（toast"文件导出服务待接入"）
- 跳转充值页

**当前数据来源：**  
`appStore.getSnapshot().downloadRecords`（Storage）  
`downloadQuota`：Storage 中的整数

**需要后端：**

| 操作 | 是否需要后端 | 原因 |
|-----|-----------|------|
| 下载记录列表 | ✅ | 云端持久化 |
| 重新下载 | ✅ | 文件导出服务 |
| 当前额度显示 | ✅ | 服务端维护额度 |

---

### 意见反馈（`pages/feedback/index`）

**用户操作：**
- 选择分类（功能建议/问题反馈/支付问题/体验吐槽）
- 填写内容（至少 5 字）
- 填写联系方式
- 选择截图（最多 5 张，`wx.chooseMedia`）
- 提交（toast"反馈接口尚未配置"）

**需要后端：**  
✅ 提交反馈 API + 截图上传

---

### 隐私设置（`pages/privacy/index`）

**用户操作：**
- 切换开关（本地存储/云同步/服务通知/个性化推荐）
- 查看用户协议/隐私政策（toast"内容待发布"）
- 注销账号（toast"尚未接入账号登录"）

**需要后端：**  
- 云同步开关：✅（toast"云同步服务待接入"）
- 本地存储、服务通知、个性化推荐开关：⚠️（可本地保存，也可云端同步）
- 注销账号：✅

---

### 下载次数（`pages/recharge/index`）

**用户操作：**
- 查看当前额度
- 选择套餐
- 点击"立即支付"（toast"支付能力尚未接入"）

**需要后端：** ✅ 微信支付 + 额度发放

---

### 支付成功（`pages/payment-success/index`）

**当前数据来源：**  
URL 参数：`packageLabel`、`amount`、`quota`（**前端直接传递，无验证**）

**需要后端：** ✅ 需要从服务端验证支付结果，而非前端参数决定

---

### 其他页面（无 API 需求）

| 页面 | 原因 |
|-----|------|
| 使用帮助（`help/index`） | 全静态内容，`HELP_QUESTIONS` 硬编码 |
| 关于我们（`about/index`） | 全静态内容 |

---

## 5. 当前 Mock / Storage / 静态数据分析

| 文件 | 当前实现 | 当前保存的数据 | 后续建议 |
|-----|---------|-------------|---------|
| `store/app-store.ts` | `wx.getStorageSync('pindou-app-state-v1')` 序列化全量状态 | `currentDraft`、`works[]`、`favoriteIds[]`、`downloadQuota`、`downloadRecords[]`、`privacyPreferences` | 登录后迁移到各对应云端 API；本地 Storage 只保留当前 draft 缓存 |
| `services/image-service.ts` | `id: 'draft-' + Date.now()` | draft ID | 后端负责生成真实 ID |
| `config/product.ts` | `DOWNLOAD_PACKAGES` 硬编码套餐 | 套餐价格/次数 | 建议后端下发，便于运营调价 |
| `pages/profile/index.wxml` | 硬编码显示 `/ 3 次` | 每日免费额度上限 | 后端下发当日额度 |
| `store/app-store.ts` L23 | `downloadQuota: 3` | 初始额度 | 改为登录后从服务端同步 |
| `pages/payment-success/index.ts` | 从 URL params 读取 `quota` | 支付后额度变更 | 必须从服务端验证，禁止前端自传 |

---

## 6. 业务实体

### User（用户）

> 目前代码中尚未存在真实 User 字段，但以下位置暗示用户体系的存在

**代码证据：**
- `profile/index.wxml` "登录后可同步作品与下载记录"
- `profile/index.ts` `showLoginNotice()` → toast"账号登录能力待接入"
- `privacy/index.ts` `cancelAccount()` → toast"尚未接入账号登录"

**推断字段：**

```
User:
  id                 // 服务端生成
  openid             // 微信 openid（不直接暴露给前端）
  avatarUrl          // 来自 profile/index.wxml <image src="avatarPath">
  nickname           // 暂时硬编码"拼豆用户"
  downloadQuota      // 来自 appStore.state.downloadQuota（Storage）
  createdAt
```

---

### Work（作品）

**代码来源：** `models/pattern.ts` `WorkItem`，`editor/index.ts` `saveWork()`，`appStore.saveWork()`

```
WorkItem（前端已有类型）:
  id: string           // 'draft-' + Date.now() → 需服务端生成
  title: string        // 硬编码'未命名作品'（editor/index.ts L183）
  coverPath: string    // draft.sourceImagePath（临时路径）→ 需改为云存储 URL
  updatedAt: number    // Date.now()（前端生成）
  beadCount: number    // 客户端计算
  colorCount: number   // draft.settings.colorLimit
  width?: number       // draft.settings.width
  height?: number      // draft.settings.height
  status?: 'draft' | 'completed'

额外需要补充的服务端字段:
  userId              // 作品归属
  createdAt           // 服务端生成（现在 draft.createdAt 是前端 Date.now()）
  previewImageUrl     // 云存储成品图 URL
  chartImageUrl       // 云存储施工图 URL
  brand               // draft.settings.brand（目前未写入 WorkItem）
```

---

### PatternDraft（图案草稿）

**代码来源：** `models/pattern.ts` `PatternDraft`，`image-service.ts` `createDraft()`

```
PatternDraft（前端已有类型）:
  id: string               // 'draft-' + Date.now()
  sourceImagePath: string  // 临时路径，进程结束即失效
  createdAt: number        // Date.now()
  settings: PatternSettings
    width: number          // 32/48/64/96/128
    height: number
    colorLimit: number     // 16/32/64/96
    brand: string          // 'MARD' / 'COCO' / '漫漫' / '盼盼'
  cells: PatternCell[]
    color: string          // hex，如'#f4d7bf'
    colorCode: string      // 如'C01'

判断：cells 数据量较大（最大 128×128=16384 个格子），需评估是否存数据库或对象存储
```

---

### DownloadRecord（下载记录）

**代码来源：** `models/pattern.ts` `DownloadRecord`，`downloads/index.ts`，`appStore.addDownloadRecord()`

```
DownloadRecord（前端已有类型）:
  id: string
  workId: string
  title: string
  coverPath: string    // 临时路径 → 需改为云存储 URL
  downloadedAt: number // Date.now()
  fileType: 'preview' | 'chart' | 'materials'
  width?: number
  height?: number
  colorCount: number

额外需要:
  userId              // 归属用户
  fileUrl             // 实际下载文件的云存储 URL
```

---

### Favorite（收藏）

**代码来源：** `appStore.state.favoriteIds`（string 数组），`appStore.toggleFavorite()`

```
目前存储形式：favoriteIds: string[]  // 仅存 workId

建议服务端关联表:
  userId
  workId
  favoritedAt
```

---

### UserQuota（下载额度）

**代码来源：** `appStore.state.downloadQuota`（硬编码初始值 3），`profile/index.wxml` "/ 3 次"，`config/profile.ts` `DOWNLOAD_PACKAGES`

```
当前：本地整数，无重置逻辑，无扣减逻辑

服务端需要:
  userId
  dailyFreeQuota      // 每日免费次数（配置值，固定为 3）
  usedTodayQuota      // 今日已用次数
  purchasedQuota      // 购买的额外次数
  quotaResetsAt       // 每日 00:00 重置时间点
  membershipType      // null | 'monthly_unlimited'
  membershipExpiresAt
```

---

### Feedback（用户反馈）

**代码来源：** `feedback/index.ts`，`config/profile.ts` `FEEDBACK_CATEGORIES`

```
Feedback:
  category: 'feature' | 'bug' | 'payment' | 'experience'
  content: string        // 至少 5 字
  contact?: string       // 手机号或邮箱
  images?: string[]      // 最多 5 张截图的 URL
  submittedAt
  userId?                // 若已登录则关联
```

---

## 7. API 需求矩阵

| 优先级 | Method | API | 用途 | 调用页面 | 请求参数 | 返回数据 | 需登录 |
|--------|--------|-----|-----|---------|---------|---------|--------|
| P0 | POST | `/api/auth/login` | 微信登录换取 session | profile | `{ code: string }` | `{ token, userId, nickname, avatarUrl, downloadQuota }` | — |
| P0 | GET | `/api/users/me` | 获取当前用户信息 | profile, result | — | `{ userId, nickname, avatarUrl, workCount, downloadQuota, ... }` | ✅ |
| P0 | POST | `/api/works` | 保存作品 | editor | WorkItem 数据 | `{ id, createdAt, status }` | ✅ |
| P0 | GET | `/api/works` | 获取当前用户作品列表 | projects | `{ status?, query?, page? }` | `WorkItem[]` | ✅ |
| P0 | GET | `/api/works/:id` | 获取作品详情 | projects, favorites, result | — | `WorkItem + cells + materials` | ✅ |
| P0 | DELETE | `/api/works/:id` | 删除作品 | projects | — | — | ✅ |
| P0 | POST | `/api/files/upload` | 上传图片/截图 | editor（封面图），feedback（截图） | 文件二进制 | `{ url: string }` | ✅ |
| P0 | GET | `/api/quota/me` | 获取当前用户下载额度 | result, downloads, profile, recharge | — | `{ daily, usedToday, purchased, membershipType }` | ✅ |
| P1 | PATCH | `/api/works/:id/favorite` | 收藏/取消收藏 | result, projects, favorites | `{ favorite: boolean }` | `{ isFavorite }` | ✅ |
| P1 | GET | `/api/favorites` | 获取收藏列表 | favorites | `{ query?, page? }` | `WorkItem[]` | ✅ |
| P1 | GET | `/api/downloads` | 获取下载记录 | downloads | `{ fileType?, query?, page? }` | `DownloadRecord[]` | ✅ |
| P1 | POST | `/api/downloads` | 新增下载记录 + 扣除额度 | result（下载按钮） | `{ workId, fileType }` | `{ downloadRecord, remainingQuota }` | ✅ |
| P1 | POST | `/api/payments/create` | 创建支付订单 | profile, recharge | `{ packageId }` | `{ prepayId, ... }` (微信支付参数) | ✅ |
| P1 | POST | `/api/payments/notify` | 微信支付回调 | 服务端回调 | 微信签名数据 | — | — |
| P1 | POST | `/api/feedbacks` | 提交意见反馈 | feedback | `{ category, content, contact?, imageUrls? }` | `{ id }` | ⚠️ 选填 |
| P2 | PATCH | `/api/works/:id` | 更新作品信息（如重命名） | projects（未来功能） | `{ title? }` | `WorkItem` | ✅ |
| P2 | GET | `/api/files/download/:workId/:type` | 获取可下载文件的临时 URL | downloads（重新下载） | — | `{ url: string, expiresAt }` | ✅ |
| P2 | GET | `/api/packages` | 获取套餐列表（后端下发） | profile, recharge | — | `Package[]` | — |
| P2 | PATCH | `/api/users/me/privacy` | 同步隐私偏好设置 | privacy | `PrivacyPreferences` | `PrivacyPreferences` | ✅ |
| P2 | DELETE | `/api/users/me` | 注销账号 | privacy | — | — | ✅ |

---

## 8. P0 API（核心 MVP，上线前必须）

### POST `/api/auth/login`

微信登录前端通过 `wx.login()` 获取临时 code，发送到服务端换取 session

```json
Request:
{
  "code": "wx-login-code"
}

Response:
{
  "token": "jwt-or-session-token",
  "userId": "usr_xxx",
  "nickname": "拼豆用户",
  "avatarUrl": null,
  "downloadQuota": {
    "dailyFree": 3,
    "usedToday": 0,
    "purchased": 0
  }
}
```

---

### GET `/api/users/me`

获取当前登录用户信息（包含额度摘要）

```json
Response:
{
  "userId": "usr_xxx",
  "nickname": "拼豆用户",
  "avatarUrl": null,
  "workCount": 5,
  "favoriteCount": 2,
  "downloadCount": 3,
  "downloadQuota": {
    "dailyFree": 3,
    "usedToday": 1,
    "purchased": 0,
    "membershipType": null
  }
}
```

---

### POST `/api/works`

保存作品cells 数据量较大（最大 16384 条），需评估是否存数据库或对象存储 JSON 文件

```json
Request:
{
  "title": "未命名作品",
  "coverUrl": "https://cdn.example.com/covers/xxx.png",
  "width": 64,
  "height": 64,
  "colorLimit": 32,
  "brand": "MARD",
  "beadCount": 3840,
  "colorCount": 12,
  "status": "completed",
  "cells": [
    { "color": "#f4d7bf", "colorCode": "C01" },
    ...
  ]
}

Response:
{
  "id": "work_xxx",
  "title": "未命名作品",
  "createdAt": "2026-08-26T11:00:00Z",
  "updatedAt": "2026-08-26T11:00:00Z",
  "status": "completed"
}
```

---

### GET `/api/works`

获取当前用户作品列表（通过登录态识别用户，**不接受任意 userId 参数**）

```json
Query params: ?status=completed&page=1&pageSize=20

Response:
{
  "total": 5,
  "items": [
    {
      "id": "work_xxx",
      "title": "未命名作品",
      "coverUrl": "https://cdn.example.com/covers/xxx.png",
      "width": 64,
      "height": 64,
      "beadCount": 3840,
      "colorCount": 12,
      "status": "completed",
      "isFavorite": false,
      "createdAt": "2026-08-26T11:00:00Z",
      "updatedAt": "2026-08-26T11:00:00Z"
    }
  ]
}
```

---

### GET `/api/works/:id`

获取作品详情（含 cells 和 materials，用于历史作品打开）

```json
Response:
{
  "id": "work_xxx",
  "title": "未命名作品",
  "coverUrl": "...",
  "width": 64,
  "height": 64,
  "beadCount": 3840,
  "colorCount": 12,
  "brand": "MARD",
  "status": "completed",
  "isFavorite": false,
  "cells": [...],
  "materials": [
    { "color": "#f4d7bf", "colorCode": "C01", "count": 120 }
  ],
  "createdAt": "...",
  "updatedAt": "..."
}
```

---

### DELETE `/api/works/:id`

删除当前用户指定作品（需鉴权确认归属）

```json
Response: 204 No Content
```

---

### POST `/api/files/upload`

上传文件可用于：
- 作品封面图（editor 保存时上传 sourceImagePath → 获取云端 URL）
- 反馈截图

```
Request: multipart/form-data
  file: binary
  type: 'cover' | 'feedback'

Response:
{
  "url": "https://cdn.example.com/files/xxx.png"
}
```

---

### GET `/api/quota/me`

获取当前用户下载额度（result 页显示"今日剩余免费下载次数"）

```json
Response:
{
  "dailyFree": 3,
  "usedToday": 1,
  "purchased": 0,
  "membershipType": null,
  "membershipExpiresAt": null,
  "resetsAt": "2026-08-27T00:00:00+08:00"
}
```

---

## 9. P1 API

### PATCH `/api/works/:id/favorite`

```json
Request: { "favorite": true }
Response: { "isFavorite": true }
```

### GET `/api/favorites`

```json
Query: ?query=&page=1
Response: { total, items: WorkItem[] }
```

### GET `/api/downloads`

```json
Query: ?fileType=preview&query=&page=1
Response: { total, quota, items: DownloadRecord[] }
```

### POST `/api/downloads`

创建下载记录并扣除额度

```json
Request:
{
  "workId": "work_xxx",
  "fileType": "preview"
}

Response:
{
  "downloadRecord": { "id": "dl_xxx", "fileUrl": "...", "downloadedAt": "..." },
  "remainingQuota": 2
}
```

若额度不足，返回 `402 Payment Required`，前端跳转充值页

### POST `/api/payments/create`

```json
Request: { "packageId": "starter" }
Response:
{
  "orderId": "order_xxx",
  "prepayId": "...",
  "timeStamp": "...",
  "nonceStr": "...",
  "package": "prepay_id=...",
  "signType": "RSA",
  "paySign": "..."
}
```

### POST `/api/feedbacks`

```json
Request:
{
  "category": "bug",
  "content": "反馈内容...",
  "contact": "user@example.com",
  "imageUrls": ["https://cdn.example.com/feedback/1.png"]
}
Response: { "id": "fb_xxx" }
```

---

## 10. P2 API

### PATCH `/api/works/:id`

更新作品标题等信息（当前作品名固定为"未命名作品"，需支持重命名）

### GET `/api/files/download/:workId/:type`

生成可下载文件的有效期临时 URL（成品图/施工图的实际下载）

### GET `/api/packages`

套餐列表后端下发（当前硬编码在 `config/profile.ts`）

### PATCH `/api/users/me/privacy`

同步隐私偏好（`cloudSync` 开关目前 toast"待接入"）

### DELETE `/api/users/me`

注销账号（`privacy/index.ts` `cancelAccount()` 当前 toast"尚未接入"）

---

## 11. 数据库持久化需求

### users 表

```
为什么需要：
- 微信登录关联 openid
- 下载额度、购买记录、隐私偏好均需绑定用户

对应 API：auth/login, users/me, payments/*

字段：
  id, openid (唯一), session_key (加密存储), nickname, avatar_url,
  daily_free_quota (默认 3), used_today_quota, purchased_quota,
  membership_type, membership_expires_at, privacy_local_only,
  privacy_cloud_sync, privacy_service_notices, privacy_personalized_rec,
  created_at, updated_at
```

---

### works 表

```
为什么需要：
- 作品列表跨设备持久化
- 历史作品详情服务（目前 toast"待接入"）
- 删除、收藏、下载关联

对应 API：works/*

字段：
  id, user_id (FK), title, cover_url, width, height, bead_count,
  color_count, brand, status ('draft'|'completed'), created_at, updated_at

注：cells（PatternCell[]）数据量大（最大 16384 条），建议：
- 存对象存储为 JSON 文件
- works 表只存 cells_url 字段
```

---

### favorites 表

```
为什么需要：
- favoriteIds 目前只存本地 Storage，无法跨设备

字段：user_id, work_id, created_at
```

---

### download_records 表

```
为什么需要：
- 下载记录持久化
- 额度扣减记录

字段：
  id, user_id (FK), work_id (FK), title (冗余), file_type,
  file_url, downloaded_at
```

---

### orders 表

```
为什么需要：
- 微信支付验证
- 额度发放记录

字段：
  id, user_id (FK), package_id, amount, status, wx_prepay_id,
  wx_transaction_id, paid_at, created_at
```

---

### feedbacks 表

```
为什么需要：
- 用户反馈持久化（当前完全丢失）

字段：
  id, user_id (可 null), category, content, contact, image_urls (JSON),
  submitted_at
```

---

## 12. 图片与文件存储需求

| 文件类型 | 当前方案 | 建议方案 |
|---------|---------|---------|
| 用户上传原图（sourceImagePath） | wx 临时路径，进程结束失效 | 上传对象存储，works 表存 `source_image_url` |
| 作品封面图（coverPath） | wx 临时路径 | 上传对象存储，works 表存 `cover_url` |
| 成品图（previewCanvas 导出） | `wx.canvasToTempFilePath` 临时文件 | 下载时生成/上传对象存储 |
| 施工图（chartCanvas 导出） | 同上 | 同上 |
| cells 数据（PatternCell[]） | 内存 + Storage JSON | 对象存储 JSON 文件，works 表存 `cells_url` |
| 反馈截图 | wx 临时路径，从不上传 | 提交时上传对象存储 |

**结论：**
- 数据库不直接存图片二进制
- 数据库只存云存储 URL
- 推荐使用腾讯云 COS（与微信云开发同生态）或阿里云 OSS

---

## 13. 登录与数据归属

**当前状态：** 代码中没有任何 `wx.login`、`openid`、`token` 调用，所有数据不区分用户

**需要绑定登录态的 API（不能接受任意 userId 参数，必须从 token 识别当前用户）：**

```
GET  /api/users/me          → 只返回当前用户
GET  /api/works             → 只返回当前用户的作品（不能传 userId 查他人）
POST /api/works             → 归属当前用户
DELETE /api/works/:id       → 只能删自己的作品（服务端校验归属）
PATCH /api/works/:id/favorite
GET  /api/favorites         → 只返回当前用户收藏
GET  /api/downloads         → 只返回当前用户记录
POST /api/downloads         → 扣当前用户额度
GET  /api/quota/me          → 当前用户额度
POST /api/payments/create   → 当前用户支付
```

**前端替换点（接入登录后需修改）：**

```
app.ts onLaunch() → 调用 wx.login() + POST /api/auth/login，将 token 存 Storage
profile/index.ts showLoginNotice() → 改为真实登录流程
appStore.hydrate() → 先读本地 token，再从服务端同步数据
```

---

## 14. 图片处理是否需要异步任务

**当前：** `image-service.ts` `createDraft()` 完全在客户端执行（中位切分色彩量化），同步完成后跳转编辑页

**评估：**

客户端量化属于 CPU 密集操作，小程序 JS 单线程下，128×128 大图量化可能导致 UI 卡顿

目前**不建议**立即引入服务端异步任务（YAGNI），但如果未来评估后迁移服务端，模式应为：

```
POST /api/generations          → 创建生成任务，返回 taskId
GET  /api/generations/:taskId  → 轮询任务状态和结果
```

**当前阶段：保持客户端量化，后续根据实测性能决定是否迁移**

---

## 15. 可以继续留在前端的状态

以下数据**不需要**进入数据库：

| 数据 | 位置 | 原因 |
|-----|------|------|
| `activeTab`（各页面） | 页面 data | 纯 UI 状态 |
| `showRecharge` | profile/index | 弹窗开关 |
| `zoom` / `zoomPercent` | editor/index | Canvas 编辑器缩放 |
| `activeTool` | editor/index | 工具栏选中状态 |
| `selectedColor` | editor/index | 色板选中颜色 |
| `query` / `choosing` / `generating` | 各页面 | 临时 UI 状态 |
| `previewWidth` / `previewHeight` | home/index | 临时布局计算 |
| `navigationBarHeight` / `topBarHeight` / `scrollAreaHeight` | result/index | 导航栏尺寸计算 |
| `thumbnailSrc` | result/index | 临时 Canvas 导出路径 |
| `canvasReady` / `renderError` | result/index | Canvas 渲染状态 |
| `openIndex` | help/index | 问答展开状态 |

---

## 16. 当前代码中的后端替换点

| 文件 | 当前伪后端实现 | 替换为 |
|-----|------------|-------|
| `app.ts` onLaunch | `appStore.hydrate()` 从 Storage 读全量数据 | 先读 token，再 `GET /api/users/me` 同步用户信息 |
| `store/app-store.ts` hydrate() | `wx.getStorageSync` | 登录成功后从 API 拉取各模块数据 |
| `store/app-store.ts` update() | `wx.setStorage` 持久化全量 | 各写操作改为对应 POST/PATCH/DELETE API |
| `store/app-store.ts` saveWork() | 写 Storage works[] | `POST /api/works` |
| `store/app-store.ts` toggleFavorite() | 写 Storage favoriteIds[] | `PATCH /api/works/:id/favorite` |
| `store/app-store.ts` deleteWork() | 写 Storage | `DELETE /api/works/:id` |
| `store/app-store.ts` addDownloadRecord() | 写 Storage downloadRecords[] | `POST /api/downloads` |
| `services/image-service.ts` createDraft() | `id: 'draft-' + Date.now()` | 保存时改用服务端返回 ID；上传 sourceImage 获取 URL |
| `editor/index.ts` saveAndView() | `appStore.saveWork()` | `POST /api/works` + 上传封面图 |
| `profile/index.ts` showLoginNotice() | toast | `wx.login()` → `POST /api/auth/login` |
| `profile/index.ts` purchase() | toast | `POST /api/payments/create` + 微信支付 |
| `recharge/index.ts` purchase() | toast | 同上 |
| `feedback/index.ts` submit() | 假成功弹窗 | `POST /api/feedbacks`（先上传截图） |
| `privacy/index.ts` changePreference('cloudSync') | toast | `PATCH /api/users/me/privacy` |
| `downloads/index.ts` redownload() | toast | `GET /api/files/download/:workId/:type` |
| `payment-success/index.ts` | URL params 决定额度 | 服务端支付回调验证后刷新 `GET /api/quota/me` |

---

## 17. 风险与待确认问题

1. **图片量化是否迁移服务端？**
   当前完全客户端实现（`image-service.ts` 中位切分），在大尺寸图 + 多颜色场景下性能未知需要实测后评估是否需要服务端计算（如果迁移，将新增异步任务 API）

2. **cells 数据的存储策略未确定**
   最大 128×128=16384 个格子的 JSON 数组，直接存数据库 TEXT 字段或存对象存储 JSON 文件均可，需结合历史作品"打开编辑"的频率决定读取方式

3. **历史作品是否支持再次编辑？**  
   代码中 `projects/index.ts` L98-100 仅支持当前 draft 重新进编辑器"历史作品详情服务待接入"的描述仅对应查看结果，还是也包含再次编辑？两者 cells 数据传输量差异较大

4. **下载的实际文件如何生成？**  
   `downloads/index.ts` `redownload()` toast"文件导出服务待接入"目前只有前端 Canvas 绘制逻辑，实际下载到相册需要调用 `wx.saveImageToPhotosAlbum`（代码中未实现），还是生成云端图片文件供用户下载？两种方案 API 设计不同

5. **作品分享是否支持他人查看？**  
   `result/index.ts` `onShareAppMessage` 固定分享链接为 `/pages/home/index`，未传递 workId未来若支持分享并让他人查看作品，需要新增公开作品详情 API（可能不需要登录）

6. **下载额度的"今日免费"重置逻辑**
   `profile/index.wxml` 显示"每日 00:00 自动恢复"，但当前没有重置逻辑（`downloadQuota: 3` 为初始值，不会自动恢复）服务端需要按北京时间每日 00:00 重置 `usedToday`

7. **作品名称修改功能是否纳入 MVP？**  
   当前保存时固定`title: '未命名作品'`（`editor/index.ts` L183），没有重命名入口如果产品要求支持改名，需要 `PATCH /api/works/:id` API

---

## 18. 推荐后端开发顺序

### 阶段 1：用户身份（解锁所有数据关联能力）

```
POST /api/auth/login       — wx.login code → session
GET  /api/users/me         — 获取当前用户信息 + 额度摘要
```

前端改动：`app.ts` 启动时调用登录，token 存 Storage，注入 HTTP 请求头

---

### 阶段 2：文件上传（作品保存的前提）

```
POST /api/files/upload     — 上传封面图/原图，返回云存储 URL
```

---

### 阶段 3：作品 CRUD（解锁历史作品详情 + 跨设备同步）

```
POST   /api/works          — 保存作品
GET    /api/works          — 作品列表
GET    /api/works/:id      — 作品详情（含 cells）
DELETE /api/works/:id      — 删除作品
```

前端改动：`editor/index.ts` saveAndView() 上传封面图 → 调用保存 API
`projects/index.ts` 从 API 读取列表，解锁"历史作品详情"功能

---

### 阶段 4：收藏 + 下载记录 + 额度

```
PATCH /api/works/:id/favorite   — 收藏/取消
GET   /api/favorites             — 收藏列表
GET   /api/quota/me              — 额度查询
POST  /api/downloads             — 下载记录 + 扣额度
GET   /api/downloads             — 下载记录列表
GET   /api/files/download/:workId/:type — 获取下载 URL
```

---

### 阶段 5：支付（解锁购买额度）

```
GET  /api/packages           — 套餐列表后端下发
POST /api/payments/create    — 创建支付订单
POST /api/payments/notify    — 微信支付回调（HTTPS 必须）
```

---

### 阶段 6：增强体验

```
POST   /api/feedbacks              — 提交反馈
PATCH  /api/users/me/privacy       — 云同步隐私偏好
PATCH  /api/works/:id              — 作品重命名
DELETE /api/users/me               — 账号注销
```
