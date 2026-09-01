# 模块 11：`cmd/server/main.go` — 主入口与测试/扫描引擎

## 功能概述

主入口：HTTP REST API + WebSocket 日志流 + 内嵌静态前端 + 子进程生命周期管理。此外还包含批量测试与参数扫描引擎（穷举扫描 + 智能寻优）。

## 版本

`Version = "0.2.5"`

## 核心职责

1. 初始化所有子系统（`NewApp`）
2. 启动指标轮询器（`startMetricsPoller`，每 5s）
3. HTTP 路由注册（`routes`，40+ 端点）
4. 子进程生命周期管理
5. 批量测试与参数扫描引擎

## 关键数据结构

### `GlobalConfig`（Level-1 全局配置）
```go
type GlobalConfig struct {
    DataDir          string
    BinaryPath       string
    DefaultParams    map[string]any
    LogRetentionDays int
    HFEndpoint       string  // HF 镜像覆盖
    CacheDir         string  // llama.cpp 缓存目录
    ServerAPIKeyEnc  string  // AES 加密
    BraveAPIKeyEnc   string  // AES 加密
    TavilyAPIKeyEnc  string  // AES 加密
}
```

### `App`（核心编排对象）
```go
type App struct {
    cfg      *GlobalConfig
    registry *config.Registry
    bundles  *bundle.Manager
    sessions *session.Manager
    mcp      *mcp.Manager
    cache    *bundle.CacheManager
    hw       *config.HardwareInfo
    upgrader websocket.Upgrader
    hub      *Hub

    // 运行时状态
    mu            sync.Mutex
    runners       map[string]*activeRun
    liveMetrics   map[string]*llama.Metrics
    reqCur        map[string]*RequestRecord
    reqHistory    map[string][]RequestRecord

    // 测试状态
    testCancel  map[string]bool
    testHistory []TestHistoryRecord
    testOOM     map[string]bool
    testPortMu  sync.Mutex
    testPorts   map[int]bool
    testCache   map[string]testCacheEntry
    logTail     map[string][]string
}
```

### `Hub`（WebSocket 广播中心）
```go
type Hub struct {
    mu      sync.Mutex
    clients map[*wsClient]bool
}
```

**`PublishLog()`** — 发布日志事件（type/level/session_id/ts）
**`Broadcast()`** — 向所有客户端推送 JSON 消息（慢客户端丢弃避免阻塞）

## 核心实现细节

### 1. 指标轮询（`startMetricsPoller`）

```go
func (a *App) startMetricsPoller(ctx) {
    ticker := 5s
    for {
        a.collectMetrics()  // 每 5s 轮询所有运行中实例的 /metrics
    }
}
```

**`collectMetrics()`**：
- 每 5s 轮询每个运行中实例的 `/metrics`
- 更新会话统计（TotalTokensGenerated、PeakTPS）
- 每 ~30s 持久化一次会话
- 通过 WebSocket 广播给 UI（`type: metrics`）

### 2. 批量测试与参数扫描引擎

**`sweepInt()`** — 整数参数扫描
**`testChatTiming()`** — 测试聊天时序
**`testCacheEntry`** — L2 磁盘缓存（历史测过的组合）
**`TestHistoryRecord`** — 测试历史（最近 50 条）

**测试流程**：
1. 多模型并行跑真实推理
2. 汇总 TPS / 加载时长
3. 穷举扫描：多参数笛卡尔积寻优（带上限保护）
4. 智能寻优：坐标下降逐参数优化
5. 最优配置保存 / 一键套用

**OOM 熔断**：
- 检测 CUDA OOM（`testOOM`）
- 熔断标记，避免重复触发

**端口分配**：
- 显存感知并行
- 端口分配互斥（`testPortMu`）

### 3. 日志解析（`handleServerLine`）

解析 llama-server 日志行：
- 崩溃检测
- 请求记录（`RequestRecord`）
- 日志尾部缓存（`logTail`，每会话最近 60 行）

## 设计亮点

- **编排层**：串联所有子系统
- **实时监控**：指标轮询 + WebSocket 广播
- **智能寻优**：坐标下降 + 缓存加速
- **健壮性**：OOM 熔断、端口互斥

## HTTP API 路由（节选）

| 方法 | 路径 | 说明 |
|------|------|------|
| GET | `/api/health` | 服务健康 |
| GET | `/api/system` | 硬件信息 |
| GET | `/api/monitor` | 实时监控 |
| GET | `/api/params` | 参数定义 |
| POST | `/api/bundles/scan` | 扫描目录 |
| POST | `/api/recommend` | 一键优化 |
| GET/POST | `/api/test/sweep` | 参数扫描/寻优 |
| GET | `/api/sessions` | 实例列表 |
| POST | `/api/sessions/start` | 启动 |
| POST | `/api/sessions/{id}/stop` | 停止 |
| POST | `/api/debug/proxy` | OpenAI 兼容代理 |
| GET/POST | `/api/hf/list` | HF 仓库浏览 |
| GET | `/api/insights` | 使用洞察 |
| GET/POST | `/api/mcp` | MCP 管理 |
| GET | `/api/ws` | WebSocket 日志流 |
