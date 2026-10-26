# Kotori（ことり）定制化日语学习工具 — 产品与架构设计文档 (PRD v1.0)

> **定位**：面向日语沉浸式学习的极简 AI 陪读与观影工具。参考 [Fushi](file:///usr/local/google/home/chii/Developer/Fushi/README.zh-CN.md) 的核心媒体体验，去除一切非核心模块，以 **Gemini Flash 智能语境拆解（整句解析 + 点击部位联动高亮）** 替代传统机械分词词典，并采用 **全栈 TypeScript 架构** 实现 **macOS（零新增编译二进制）、Linux、Android 三端独立运行**。

---

## 1. 已确认的产品边界（定稿清单）

| 模块 / 维度 | 最终拍板方案 | 明确不做（YAGNI） |
| :--- | :--- | :--- |
| **运行模式与平台** | **Android、Linux、macOS 三端各自独立运行（Standalone）**；全栈 **TypeScript**，macOS/Linux 走 Node.js 解释执行（0 新增编译二进制），Android 走 Capacitor 独立 APK | 不做多端云同步、不做局域网 P2P 互联（Interconnect） |
| **AI 拆解与交互 (核心)** | 点击字幕或漫画气泡中的某个词/位置时，**弹出整句完整拆解**，同时 **自动高亮并定位到被点击字符所在的拆解区块**；再次点击同句其他位置 0 延迟切换高亮 | 不做本地 C++ 分词词典、不做 Anki 制卡、不做生词本/错题本、不做学习时长统计 |
| **LLM 提供商** | **Gemini Flash**（支持配置 **Gemini API Key** 或 **Vertex AI** 端点与凭据） | 不做复杂的多厂商路由与回退配置 |
| **动漫观看 (P1)** | **仅支持本地视频（MP4/MKV）+ 本地外挂/内嵌字幕 + Jimaku 自动下载日语字幕**；具备句级跳转、单句复读、右侧时间轴联动与多句合并拆解 | 不做无字幕视频 ASR 语音转写、不做 Jellyfin/Plex、不做流媒体插件 |
| **漫画 AI 陪读 (P1)** | 支持 **`.mokuro` 预识别漫画包**（精准气泡点读）+ **纯图片生肉漫画的云端 Gemini VLM 即时识别与陪读**（手势框选气泡或整页导读） | 不做本地 450MB ONNX OCR 模型下载与 CPU 推理 |
| **资源下载 (P2)** | **动漫**：Nyaa BT 搜索 + **内置纯 JS BT 下载器** + **Jimaku** 日语字幕自动匹配；**漫画**：**`mokuro.moe`** 目录浏览与直链下载入库 | 不做 Mihon/Aniyomi/LNReader 扩展运行时、不依赖外部 qBittorrent 进程 |
| **UI 风格** | **Material Design 3 极简风**（深色沉浸画布 + 右侧/底部响应式抽屉） | 不做 Cupertino 双设计系统、不做电子书/有声书/Galgame |

---

## 2. 跨平台独立运行技术架构

通过一层极薄的 **`PlatformHost`（平台宿主抽象接口）**，让同一套核心业务代码在桌面端（macOS/Linux）和移动端（Android）各自独立运行：

- **100% 共享核心层 (`packages/core` & `packages/ui`)**：
  - **Kotori Core (`packages/core`)**：
    - Gemini Flash 客户端（同时支持 Google AI Studio `apiKey` 与 Vertex AI 模式）。
    - 整句智能拆解 Schema 与 **原句字符区间 (`charSpan: [start, end)`) 确定性对齐算法**。
    - 字幕引擎：SRT / VTT / ASS 解析器、ASS 标签清洗与逐字卡拉 OK 事件合并器（`mergePerCharacterCueGroups`）。
    - 漫画引擎：`.mokuro`（v0.2+ JSON）与 `manga.json` 归一器、ZIP/CBZ 解析器、RTL 双页跨页（Spread）与 Webtoon 布局模型。
    - 资源获取引擎：Nyaa RSS/HTML 搜索解析器、Jimaku API 搜索与字幕下载器、`mokuro.moe` 目录解析与下载器。
  - **Material Design 3 极简前端 (`packages/ui`)**：
    - React + TypeScript + Vite + Material Design 3 暗色/浅色 Tonal 主题系统。
    - 四大一级页签：`🎬 动漫 (Anime)`、`📖 漫画 (Manga)`、`⬇️ 下载 (Downloads)`、`⚙️ 设置 (Settings)`。
    - `AiBreakdownPanel`：支持整句 `汉字(假名)` `<ruby>` 振假名渲染、`📘 课本标准` vs `🔥 口语演变` 语义块卡片、点击原句任意字符自动高亮对应拆解块并平滑滚动、点击拆解块反向高亮原句、以及多轮 AI 陪读追问。
- **macOS & Linux 桌面独立宿主 (`packages/host-node`)**：
  - 纯 Node.js (`v24+`) 解释执行服务，**零新增编译二进制**（直接通过 `node` 内置 `node:sqlite` 存储数据与 AI 缓存，无需 `better-sqlite3` 等 C++ 原生插件）。
  - 本地视频 HTTP Range 流式传输、MKV 内嵌字幕流提取（调用系统 `ffmpeg`）、纯 JS 内置 BitTorrent 下载引擎、自动打开独立窗口或浏览器。
- **Android 独立应用宿主 (`packages/host-android`)**：
  - 基于 Capacitor 将 `packages/ui` 打包为独立运行的 Android APK（支持本地文件读取、内置存储与独立离线/在线运行）。
