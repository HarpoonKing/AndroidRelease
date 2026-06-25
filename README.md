# AndroidRelease 使用说明

AndroidRelease 是一个基于 Electron + React 的桌面工具，用于将 Android APK 自动上传到多个应用市场，并跟踪审核与发布状态。

## 1. 功能概览

- 多平台上传：华为、荣耀、小米、OPPO、Vivo、应用宝
- 多应用管理：可新增多个 App（名称、包名、图标）
- 多平台凭证管理：按 App 维度保存各平台凭证
- 自动读取 APK 元数据：可读取 versionName / versionCode
- 多平台并行任务：一次提交可生成多个平台任务
- 定时发布：审核通过后可按时间自动上架
- 任务看板与日志：查看任务状态、详细日志、重试和终止
- 凭证加密存储：使用系统安全能力加密保存

## 2. 运行环境

建议环境：

- Node.js（建议 LTS 版本）
- npm
- macOS / Windows

## 3. 安装与启动

在项目根目录执行：

```bash
npm install
npm run dev
```

说明：

- 首次安装后会自动执行 `postinstall`，重建 `better-sqlite3` 原生模块
- 启动后会打开桌面应用窗口，并初始化本地数据库与后台调度器

## 4. 打包发布

```bash
npm run build
```

仅构建不打包安装程序：

```bash
npm run build:unpack
```

## 5. 页面与操作流程

### 第一步：App 管理

在“App 管理”页面：

1. 新建 App（名称、包名、可选图标）
2. 可选：从已有 App 复制平台凭证
3. 点击“上传发布”进入上传页面

### 第二步：配置平台凭证

可在两处配置：

- “设置”页面统一配置
- “上传发布”页面在平台卡片内快速配置

建议先点击“验证”，通过后再保存。

### 第三步：创建上传任务

在“上传发布”页面：

1. 选择 App
2. 选择默认 APK（可自动填充版本号）
3. 勾选目标平台
4. 如有需要，为单个平台单独选择不同 APK
5. 填写更新说明
6. 可选：设置“定时上架时间”
7. 点击“开始上传”

提交后会为每个平台创建一个独立任务。

### 第四步：任务看板观察进度

在“任务看板”页面可进行：

- 实时查看任务状态
- 查看日志详情
- 失败任务重试
- 运行中任务终止
- 删除已结束任务

应用宝特殊说明：

- 应用宝不支持 API 自动轮询审核状态
- 审核通过后需在任务看板中手动点击“标记审核通过”继续发布

## 6. 支持平台与凭证字段

### 华为应用市场

- `clientId`
- `clientSecret`
- `appId`

### 荣耀应用市场

- `clientId`
- `clientSecret`
- `appId`

### 小米应用商店

- `username`
- `privateKey`
- `packageName`

### OPPO 应用商店

- `clientId`
- `clientSecret`
- `packageName`
- `iconUrl`（可选，覆盖后台图标；不填则自动从后台下载后重传到 OPPO CDN）
- `picUrl`（可选，覆盖后台截图，逗号分隔；不填则自动从后台下载后重传到 OPPO CDN）

### Vivo 应用商店

- `accessKey`
- `secretKey`
- `packageName`

### 腾讯应用宝

- `userId`
- `accessSecret`
- `appId`
- `pkgName`

## 7. 任务状态说明

- `uploading`：上传中
- `upload_failed`：上传失败
- `pending_review`：审核中
- `audit_failed`：审核拒绝
- `audit_passed`：审核通过
- `scheduled`：已审核通过，等待定时发布
- `publishing`：发布中
- `published`：已发布
- `publish_failed`：发布失败
- `canceled`：已终止

## 8. 数据存储与安全

- 本地数据库文件：Electron `userData` 目录下的 `autorelease.sqlite`
- 凭证存储方式：使用 Electron `safeStorage` 加密后保存
- 日志存储：每个任务会记录详细日志，便于排查上传/审核/发布问题

## 9. 常见问题

### 1) 保存凭证时报“系统加密服务不可用”

原因：当前系统环境不支持 `safeStorage`。

处理：

- 在本机图形化登录环境下运行应用
- 检查系统钥匙串/安全服务是否可用

### 2) 上传失败或审核失败

处理建议：

- 先查看“任务看板”日志中的 HTTP 状态码和平台返回信息
- 在平台开发者后台确认应用信息是否完整
- 检查凭证、包名、版本号、更新说明是否符合平台要求

### 3) 任务一直在审核中

处理建议：

- 各平台审核时间不同，通常需要数分钟到数小时
- 应用宝需手动确认审核通过

## 10. 开发命令

```bash
npm run dev          # 开发模式运行
npm run preview      # 预览构建结果
npm run typecheck    # TypeScript 类型检查
npm run db:generate  # 生成 drizzle 迁移
npm run db:migrate   # 执行 drizzle 迁移
```

---

如果你要把这份文档给非技术同学使用，建议再补一版“平台凭证获取路径”截图文档（各开发者后台入口差异较大）。
