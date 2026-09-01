# 模块 04：`internal/llama/` — 进程管理

## 功能概述

管理 llama-server 子进程的生命周期、Windows Job Object 绑定 + 健康/指标轮询。

## 核心职责

1. 启动/停止/重启 llama-server 进程
2. Windows Job Object 绑定（防孤儿进程）
3. 健康检查（`/health` 每 2s）
4. 指标轮询（`/metrics` 每 5s）
5. 崩溃检测

## 关键数据结构

### `Options`
```go
type Options struct {
    BinaryPath string   // llama-server(.exe) 路径
    Args       []string // CLI 参数（已注入安全）
    Env        []string // 额外环境变量
    WorkDir    string
    Stdout     io.Writer // 日志收集器
    Stderr     io.Writer
}
```

### `Runner`
```go
type Runner struct {
    opts   Options
    cmd    *exec.Cmd
    job    *jobObject  // Windows Job Object
    mu     sync.Mutex
    exited chan struct{}
}
```

### `Metrics`
```go
type Metrics struct {
    TPromptProcessing      float64  // 提示处理速率
    TEval                  float64  // 评估速率
    NPromptTokensProcessed int64
    NPredicted             int64
    NPromptTokensTotal     int64
    NPredictedTokensTotal  int64
    KVCacheUsageRatio      float64  // KV 缓存使用率
    KVCacheTokensCount     int64
    SlotsIdle              int
    SlotsProcessing        int
    PromptPerSecond        float64
    PredictedPerSecond     float64
}
```

## 核心实现细节

### 1. 进程生命周期（`runner.go`）

**`New(opts)`** — 创建 Runner（不启动进程）：
- 尝试创建 Job Object（best-effort，失败返回 nil）

**`Start()`** — 启动进程：
```go
cmd := exec.Command(bin, args...)
cmd.Dir = WorkDir
cmd.Env = append(os.Environ(), env...)
// 绑定 Job Object（使用子进程 PID）
go func() { cmd.Wait(); close(exited) }()
```

**`Stop(timeout)`** — 终止进程：
- llama-server 是常驻 HTTP 服务器，无优雅退出端点
- Windows 上 `Process.Kill` = `TerminateProcess`，即时生效
- 等待 watcher goroutine 回收进程

**`Kill()`** — 强制终止

**`Wait(ctx)`** — 阻塞等待退出

**`Close()`** — 释放 Job Object 句柄

### 2. 健康检查（`health.go`）

**`HealthChecker`**：
```go
type HealthChecker struct {
    BaseURL string
    Client  *http.Client
    APIKey  string  // 实例启用 --api-key 时鉴权
}
```

**三阶段健康融合**：
1. **启动阶段**：stdout 日志收集（由日志收集器处理）
2. **运行时存活**：`GET /health` 每 2s
3. **深度监控**：`GET /metrics` 每 5s

**`Health()`** — 探测 `/health`，200 表示就绪

**`Metrics()`** — 兼容两种格式：
- **旧版**：JSON（`t_prompt_processing`、`n_predicted_tokens_total`）
- **新版**（b10520）：Prometheus 文本（`llamacpp:*`）
- 通过 `Content-Type` 嗅探，自动选择解析方式

**`parsePrometheus()`** — 解析 Prometheus 文本：
```
llamacpp:<name> <value>
# HELP/TYPE 注释行
```

### 3. Windows Job Object（`job_windows.go`）

- 使用 `KILL_ON_JOB_CLOSE` 标志
- 管理器退出时自动清理所有子进程
- 防止孤儿进程残留

## 设计亮点

- **防孤儿进程**：Job Object 确保进程随管理器一起清理
- **双格式兼容**：兼容新旧 llama.cpp 的 metrics 格式
- **显存感知**：API Key 鉴权支持
- **崩溃检测**：自动检测进程异常退出

## 相关调用方

- `cmd/server/main.go`：启动/停止/监控实例
- `config/auto.go`：`HardwareInfo` 硬件检测
