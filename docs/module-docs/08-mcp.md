# 模块 08：`internal/mcp/` — MCP 服务器管理

## 功能概述

管理 MCP（Model Context Protocol）服务器，模型可带起这些服务器。当前为骨架实现：注册 + 状态；工具级监控将在后续阶段加入。

## 核心职责

1. MCP 服务器注册/删除
2. 持久化存储（`data/mcp.json`）
3. 运行时状态快照

## 关键数据结构

### `Server`
```go
type Server struct {
    ID      string            // 唯一 ID
    Name    string            // 显示名称
    Command string            // 启动命令
    Args    []string          // 参数
    Env     map[string]string // 环境变量
    Enabled bool              // 启用状态
    Notes   string            // 备注
}
```

### `Status`（运行时状态）
```go
type Status struct {
    ServerID string `json:"server_id"`
    Running  bool   `json:"running"`
    PID      int    `json:"pid,omitempty"`
    Tools    int    `json:"tools,omitempty"`
    Updated  string `json:"updated"`
}
```

### `Manager`
```go
type Manager struct {
    path    string
    mu      sync.RWMutex
    servers map[string]*Server
}
```

## 核心实现细节

### 1. 注册表管理（`manager.go`）

**`NewManager(path)`** — 加载 `mcp.json`：
- 文件不存在 → 返回空管理器
- 解析为 `[]*Server`
- 确保每个 Server 有 Env 字段

**`Add(s)`** — 注册新服务器：
- 生成唯一 ID（`mcp_<timestamp>_<seq>`）
- 确保 Env 非空
- 持久化保存

**`Remove(id)`** — 注销服务器

**`GetByName(name)`** — 按显示名称查找

**`mcpSeq`** — 原子计数器：
- 保证同一时间戳内生成的 ID 也唯一
- Windows 上 `time.Now` 精度约 1ms，纯纳秒时间戳会碰撞

### 2. 持久化

- JSON 序列化到 `data/mcp.json`
- 读写时加锁保护

## 设计亮点

- **原子 ID 生成**：避免 Windows 时间精度导致的 ID 碰撞
- **并发安全**：RWMutex 保护
- **兼容格式**：兼容 llama.cpp / Cursor 的 MCP 定义格式

## 相关调用方

- `cmd/server/main.go`：`/api/mcp`、`/api/mcp/status`
- `bundle/`：绑定 MCP 到启动参数
