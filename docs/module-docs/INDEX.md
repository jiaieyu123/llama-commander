# Llama Launcher 模块详解索引

本文档详细描述了 Llama Launcher 项目的每一个功能模块。项目是一个基于 Go 1.24+ 的 llama.cpp 智能启动管理器。

## 模块总览

| # | 模块 | 路径 | 职责 |
|---|------|------|------|
| 01 | GGUF 解析器 | `internal/gguf/` | 解析 GGUF 文件头，提取模型元数据 |
| 02 | 模型组合包 | `internal/bundle/` | 模型捆绑包管理（mmproj/draft/LoRA/分片） |
| 03 | 参数配置引擎 | `internal/config/` | 参数矩阵 + 三级继承链 + 硬件检测 + 审计 |
| 04 | 进程管理 | `internal/llama/` | 子进程生命周期 + Job Object + 健康/指标 |
| 05 | 会话管理 | `internal/session/` | 多实例会话 + 历史持久化 |
| 06 | 加密存储 | `internal/secure/` | AES-256-GCM 敏感值加密 |
| 07 | HF 下载 | `internal/downloader/` | 断点续传下载 + 镜像支持 |
| 08 | MCP 管理 | `internal/mcp/` | MCP 服务器注册/状态 |
| 09 | 网页搜索 | `internal/websearch/` | 多提供商搜索 + 质量流水线 |
| 10 | 文件浏览器 | `internal/fsbrowse/` | 目录/文件浏览 |
| 11 | 主入口 | `cmd/server/main.go` | HTTP API + WebSocket + 测试引擎 |
| 12 | 内嵌前端 | `internal/webui/` | Web 界面（ECharts 5.5） |

## 阅读顺序建议

1. **入门**：[01-gguf.md](01-gguf.md) → [02-bundle.md](02-bundle.md)（数据基础）
2. **核心**：[03-config.md](03-config.md) → [04-llama.md](04-llama.md)（参数与进程）
3. **支撑**：[05-session.md](05-session.md) → [06-secure.md](06-secure.md)（状态与安全）
4. **扩展**：[07-downloader.md](07-downloader.md) → [08-mcp.md](08-mcp.md) → [09-websearch.md](09-websearch.md)（能力扩展）
5. **基础**：[10-fsbrowse.md](10-fsbrowse.md) → [11-main.md](11-main.md) → [12-webui.md](12-webui.md)（入口与界面）

## 架构关系

```
cmd/server/main.go (编排层)
├── config.Registry      → 参数矩阵（~100 项）
├── config.Chain         → 三级继承链
├── config.HardwareInfo  → 硬件检测 + VRAM 估算
├── config.Audit         → 配置健康审计
│
├── bundle.Manager       → 模型组合包 CRUD
├── bundle.scan          → 智能捆绑检测
├── bundle.shard         → 分片检测
├── bundle.CacheManager  → 缓存管理
│
├── llama.Runner         → 子进程生命周期
├── llama.HealthChecker  → 健康/指标轮询
├── session.Manager      → 多实例会话
│
├── secure               → AES-256-GCM 加密
├── downloader           → HF 下载
├── mcp.Manager          → MCP 服务器
├── websearch            → 网页搜索
├── fsbrowse             → 文件浏览
│
└── gguf.ModelInfo       → GGUF 元数据解析
```

## 关键设计模式

- **单一数据源**：参数矩阵集中定义，UI/CLI/审计共用
- **三层架构**：数据层（gguf/bundle）→ 业务层（config/bundle/llama）→ 入口层（main）
- **平台抽象**：`auto_windows.go` / `auto_other.go` 平台特定实现
- **并发安全**：RWMutex 保护共享状态
- **健壮性**：明确错误处理、超时保护、熔断机制
