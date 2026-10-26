# Kotori（ことり）v0.1.0 全量功能测试与视觉验收报告

> **测试结论：PASS（全量通过）**
> - **单元与集成测试**：**84 个测试套件 / 777 项测试用例 100% 通过**（`@kotori/core` 244 项、`@kotori/host-node` 187 项、`@kotori/host-android` 86 项、`@kotori/ui` 260 项）。
> - **零原生二进制门禁（Santa 兼容）**：`pnpm check:native` 扫描 `node_modules/` 与构建产物通过，确认 **0 个 `.node` / `.so` / `.dylib` C++ 原生扩展**，完全使用 Node.js 22 内置 `node:sqlite` 与纯 TypeScript BitTorrent / ZIP 解压实现。
> - **真实 LLM / VLM 端到端实测**：连接 Google Cloud Vertex AI（`location: global`, 模型 `gemini-3.8-flash`）完成整句意群拆解、流式多轮追问（SSE）、漫画生肉 VLM 整页陪读与气泡框选 OCR 实测。

---

## 1. 测试环境与架构概览

| 维度 | 配置详情 |
| :--- | :--- |
| **宿主环境** | Linux (x86_64) · Node.js `v22.22.1` (`node:sqlite` 内置引擎) · `ffmpeg` / `ffprobe` `7.1.3` |
| **前端与渲染验证** | React 19 + Vite 6 + Material Design 3 (`#8ab49a` 鼠尾草绿种子色动态色板) · Headless Chrome (`1440×900 @ 2x` 桌面端 & `412×915 @ 2x` 移动端) |
| **AI / VLM 引擎** | Google Cloud Vertex AI (`gemini-3.8-flash`, ADC 认证, `global`) |
| **代码仓库** | [README.md](./README.md) · [DESIGN.md](./DESIGN.md) · [ARCHITECTURE.md](./ARCHITECTURE.md) |

### 1.1 自动化测试套件汇总

| 子包 | 测试套件数 | 测试用例数 | 核心覆盖模块 | 状态 |
| :--- | :---: | :---: | :--- | :---: |
| `@kotori/core` | 30 | 244 | SRT/VTT/ASS 解析、Fushi 逐字卡拉 OK 合并、双层 UTF-16 Span 对齐、Ruby 振假名分词、`.mokuro` / `.cbz` 解析、Nyaa / Jimaku / `mokuro.moe` 抓取、Gemini / Vertex AI 客户端与 Prompt 构建 | ✅ PASS |
| `@kotori/host-node` | 22 | 187 | `node:sqlite` 持久化仓储、HTTP 206 Range 视频流、FFmpeg MKV 内封字幕提取、纯 TS BitTorrent 引擎（DHT / Tracker / Peer Wire / MSE-PE 加密）、下载任务队列与自动入库 | ✅ PASS |
| `@kotori/host-android` | 11 | 86 | Capacitor SQLite 适配、原生 SAF 文件流、流式分块下载、Android WebView `PlatformHost` 实现 | ✅ PASS |
| `@kotori/ui` | 21 | 260 | Material Design 3 组件库、动漫播放器与字幕时间轴、Span-Aware AI 拆解面板、漫画双页右开阅读器与 VLM 气泡框选、下载中心、设置页 | ✅ PASS |
| **合计** | **84** | **777** | **全量 TypeScript Monorepo 零原生扩展验证** | ✅ **100% PASS** |

---

## 2. 端到端功能实测结果

1. **动漫媒体库与播放器（P1）**：
   - 自动扫描导入本地番剧目录、提取 MKV 内封 ASS 字幕轨、支持 HTTP 206 分段视频流播放。
   - ASS 逐字卡拉 OK 字幕自动合并为完整句子（7 帧合并为 1 句，`<1ms`）。
   - 支持单句循环精听（`R`）、盲听高斯模糊模式（`B`）、字幕时间轴实时过滤与多行字幕合并解析。
2. **Span-Aware 整句 AI 拆解与多轮流式追问（P1 增强）**：
   - 点击字幕或气泡中任意字符，弹出整句解析并自动高亮点击字符所在的语义意群（Chunk），同时展示口语缩略还原链（如 `言われたって` → `言われても`、`じゃん` → `じゃないか`、`すっごく` → `すごく`）。
   - 同一句内点击其他字符在客户端 **0ms（零网络请求）** 完成重聚焦；本地 SQLite 缓存命中仅需 **5ms**。
   - 支持针对当前句子的 SSE 多轮流式追问并持久化对话历史。
3. **漫画阅读器与云端 VLM 生肉陪读（P1 增强）**：
   - 支持 `.mokuro` 预置 OCR 气泡绿框叠加、日式双页右开（`spread-rtl`）与纵排字符级联动高亮。
   - 支持无 OCR 生肉漫画（`.cbz`）的一键 **✨ 陪读本页**（VLM 自动标注气泡阅读顺序 `1..4`、生成场景概要与逐句翻译/语法注释）及 **框选气泡识别**（`ocr-bubble`）。
4. **一站式资源下载中心（P2）**：
   - 集成 Nyaa 动画搜索、Jimaku 日语字幕匹配、`mokuro.moe` 漫画目录浏览与纯 TypeScript BitTorrent 下载器，支持任务暂停、继续、取消与完成后自动入库。
5. **Material Design 3 主题与跨端响应式适配**：
   - 支持浅色/深色模式、8 组莫兰迪预设种子色与自定义 HEX 色值、实时字号缩放预览，以及桌面端 `NavRail + SideSheet` 与移动端 `NavigationBar + BottomSheet` 自适应布局。
