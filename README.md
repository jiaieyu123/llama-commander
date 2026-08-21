# 🚀 Llama Commander

llama.cpp 智能启动管理器 — 基于 Web 的图形化管理工具，让你像使用软件一样管理 AI 模型。

> 当前状态：**v0.1 项目骨架**（可编译、可运行、核心模块已定义）
> 完整方案见方案文档（v4.0），共 11 个 Phase。

## ✨ 核心能力（规划全景）

| 模块 | 状态 |
|------|------|
| 模型库管理（Bundle：主模型 + mmproj + 草稿 + LoRA） | 🟢 手动添加/扫描/智能捆绑/分片 + 内置 📂 文件浏览器 |
| 智能参数配置（~100 项 2026 参数矩阵 + 三级继承链） | 🟢 参数矩阵 + 继承链 + 实时命令预览 |
| 自动配置引擎（硬件检测 / VRAM 估算 / 一键优化） | 🟢 一键优化已接入后端真实计算 |
| 服务器控制（启动/停止/重启/多实例/Job Object） | 🟢 多实例并发 + 重启 + 停止全部 + 防孤儿 |
| 日志监控（WebSocket 实时流 + 颜色/过滤/搜索） | 🟢 实时流 + 会话级过滤 + 会话标签 + 崩溃检测 |
| 性能监控（/metrics + ECharts） | 🟢 真实 /metrics 轮询 → WS → 实时图表 |
| 预设方案（6 内置 + 自定义） | 🟢 内置预设 |
| 缓存管理（~/.cache/llama.cpp） | 🟢 浏览/删除/导入模型库 + 官方缓存布局 |
| 模型下载（HF 仓库浏览/量化选择/断点续传/自动入库） | 🟢 下载进度条 + 镜像 HF_ENDPOINT |
| API 调试（Chat/Completions/Embeddings + 流式 + 统计 + 历史） | 🟢 通用代理 + 打字机效果 + 重放 |
| 使用洞察（Token 统计/模型热度/吞吐基准/成功率） | 🟢 ECharts 仪表盘 + 指标持久化 |
| MCP 管理（注册/删除 + 启动参数绑定） | 🟢 前端管理弹窗 + --mcp 参数 |
| 全局设置（API Key 加密/二进制/HF 镜像/日志保留） | 🟢 AES-256-GCM 加密存储 |
| Docker 源 / 多版本二进制管理 | ⬜ 未开始 |

## 🚀 快速开始

```bash
# 1. 启动服务（默认 http://127.0.0.1:8080）
go run cmd/server/main.go

# 2. 单独测试 GGUF 解析
go run cmd/server/main.go parse H:\models\my-model.gguf

# 3. 编译为单二进制
go build -o llama-commander.exe cmd/server/main.go
```

浏览器访问 `http://127.0.0.1:8080`。

## 🏗 目录结构

```
├── cmd/server/main.go          # 主入口（HTTP + WS + 子进程管理）
├── internal/
│   ├── gguf/                   # GGUF 头解析（v3，含单元测试）
│   ├── llama/                  # 进程管理（Windows Job Object）+ 健康检测
│   ├── config/                 # 参数矩阵 / 三级继承链 / 自动配置 / 健康审计
│   ├── bundle/                 # 模型组合包 CRUD / 缓存管理 / 分片检测
│   ├── session/                # 多实例会话管理
│   ├── mcp/                    # MCP 服务器管理
│   └── webui/                  # 内嵌前端（go:embed）
├── web/dist/                   # 前端镜像副本（勿直接编辑，用脚本同步）
├── data/                       # 运行时 JSON（bundles/presets/config/mcp/sessions）
├── logs/                       # 会话日志（按日期分目录）
├── binaries/                   # 多版本 llama-server
└── scripts/sync-web.ps1        # 前端镜像同步脚本
```

## 🔧 常用命令

| 命令 | 用途 |
|------|------|
| `go run cmd/server/main.go` | 启动管理器 |
| `go run cmd/server/main.go parse <模型>` | 测试 GGUF 解析 |
| `go build -o llama-commander.exe cmd/server/main.go` | 编译 EXE |
| `go test ./...` | 运行全部测试 |
| `powershell -File scripts/sync-web.ps1` | 同步前端镜像 |
| `powershell -File scripts/build-all.ps1` | 跨平台打包（Win/Linux/macOS → dist/） |

## 🌐 HTTP API 一览

| 方法 | 路径 | 说明 |
|------|------|------|
| GET | `/api/health` | 服务健康/版本 |
| GET | `/api/system` | 硬件信息 |
| GET/POST | `/api/bundles` | 模型库列表 / 新增 |
| PUT/DELETE | `/api/bundles/{id}` | 更新 / 删除 |
| POST | `/api/parse` | 解析 GGUF |
| GET | `/api/cache` | 缓存条目 |
| POST | `/api/cache/delete` | 删除缓存条目 |
| POST | `/api/cache/import` | 本地 GGUF 注册到缓存 |
| POST | `/api/cache/export` | 导出缓存条目 |
| POST | `/api/hf/list` | 列出 HF 仓库 GGUF 文件 |
| POST | `/api/hf/download` | 异步断点续传下载 + 自动入库 |
| POST | `/api/debug/proxy` | 向运行实例转发 OpenAI 兼容请求（含 SSE 流式） |
| GET | `/api/sessions` | 会话列表 |
| GET | `/api/mcp` | MCP 服务器列表 |
| POST | `/api/mcp` | 注册 MCP 服务器 |
| DELETE | `/api/mcp/{id}` | 删除 MCP 服务器 |
| GET | `/api/fs/list` | 目录浏览（驱动器/子目录/.gguf 文件） |
| GET | `/api/config` | 读取全局设置（密钥仅返回布尔） |
| PUT | `/api/config` | 保存设置（API Key 加密存储） |
| GET | `/api/insights` | 使用洞察聚合（token/模型/日期/成功率） |
| POST | `/api/sessions/start` | 启动模型 |
| POST | `/api/sessions/{id}/stop` | 停止模型 |
| POST | `/api/sessions/{id}/restart` | 重启模型 |
| POST | `/api/preview` | 命令预览 |
| GET | `/api/ws` | WebSocket 日志流 + 指标推送 |

## 🧪 开发测试工具

`scratch/fakeserver/` 是一个模拟 llama-server（监听端口并响应 `/health` 与
`/metrics`），用于端到端测试启动/停止/重启与指标面板，无需真实模型：

```bash
go build -o scratch/fakeserver.exe ./scratch/fakeserver
./llama-commander.exe -binary "h:\llama Qdgl\scratch\fakeserver.exe"
```

## 🗺 开发路线图

| Phase | 版本 | 内容 |
|-------|------|------|
| 0 | 架构验证 | ✅ 本项目骨架 |
| 1 | v0.1 | REST API + 前端框架 + 手动添加 Bundle |
| 2 | v0.2 | 子进程 + Job Object + 日志流 |
| 3 | v0.3 | 完整参数矩阵 + 三级继承 + VRAM 估算 |
| 4 | v0.4 | 模型库 + GGUF 入库 + 分片 |
| 5 | v0.5 | 预设系统 + 命令行生成器 |
| 6 | v0.6 | 多实例 + Router 监控 + 崩溃恢复 |
| 7 | v0.7 | /metrics 面板 + ECharts |
| 8 | v0.8 | 缓存管理器 + 多源下载 |
| 9 | v0.9 | 自动配置引擎 + 健康审计 |
| 10 | v0.95 | MCP + 内置 WebUI |
| 11 | v1.0 | 洞察面板 + API 调试 + 跨平台 |
