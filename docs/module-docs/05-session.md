# 模块 05：`internal/session/` — 多实例会话管理

## 功能概述

管理运行中/已停止的 llama-server 实例，支持多实例并发 + 历史会话持久化。

## 核心职责

1. 跟踪所有会话实例
2. 多实例并发运行
3. 崩溃状态检测
4. 历史会话持久化（按日期分目录）
5. 会话重启（复用上次参数）

## 关键数据结构

### `Status`（生命周期状态）
```go
const (
    StatusStopped  Status = "stopped"
    StatusStarting Status = "starting"
    StatusRunning  Status = "running"
    StatusStopping Status = "stopping"
    StatusCrashed  Status = "crashed"
)
```

### `Session`
```go
type Session struct {
    ID                   string         // session_<timestamp>
    BundleID             string         // 关联的 bundle
    PresetID             string
    BinaryVersion        string
    PID                  int
    Port                 int
    CmdlineArgs          []string       // 启动参数
    Params               map[string]any // 原始表单参数（重启时复用）
    StartTime            string
    EndTime              *string
    Status               Status
    ExitCode             *int
    LogFile              string
    PeakVRAMGB           float64
    PeakTPS              float64
    TotalTokensGenerated int64
}
```

### `Manager`
```go
type Manager struct {
    dir      string
    mu       sync.RWMutex
    sessions map[string]*Session
}
```

## 核心实现细节

### 1. 会话管理（`manager.go`）

**`NewManager(dir)`** — 加载历史会话：
- 遍历 `data/sessions/<date>/session_*.json`
- 解析有效会话（ID 非空）

**`Create()`** — 注册新会话：
- 生成唯一 ID（`session_<unixnano>`）
- 初始状态 `StatusStarting`

**`Get/List`** — 查询会话

**`List()`** — 返回所有会话（最新优先）

### 2. 多实例支持

- 每个实例独立端口、独立进程
- 并发运行多个实例
- 崩溃自动检测（状态 → `StatusCrashed`）

### 3. 持久化

- JSON 序列化到 `data/sessions/`
- 按日期分目录存储
- 重启时复用上次参数（`Params` 字段）

## 设计亮点

- **多实例并发**：独立管理每个实例
- **崩溃检测**：自动标记崩溃状态
- **历史持久化**：完整记录运行历史
- **参数复用**：重启时自动恢复参数

## 相关调用方

- `cmd/server/main.go`：实例启动/停止/重启
- `bundle/`：关联 bundle 信息
