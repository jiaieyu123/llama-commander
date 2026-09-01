# 模块 13：测试 / 参数扫描 / 历史引擎详解

> 文件：`cmd/server/main.go`（约 2280–4400 行）
> 数据文件：`data/test_history.json`、`data/test_cache.json`

本模块负责**多模型批量测试**、**单模型参数扫描（穷举 + 智能寻优）**以及**测试历史持久化**。
核心编排对象是 `App`，所有测试逻辑都通过 WebSocket 广播进度给前端。

---

## 一、整体架构

```
┌─────────────────────────────────────────────────────────┐
│  App (cmd/server/main.go)                                 │
│                                                          │
│  ┌──────────────┐  ┌──────────────┐  ┌──────────────┐    │
│  │ 批量测试引擎  │  │ 参数扫描引擎  │  │ 历史/缓存层  │    │
│  │ handleTestBatch│ │ handleTestSweep│ │ testCache / │    │
│  │ runOneTestCore │ │ planSweep /    │ │ testHistory │    │
│  │ parallelGroups │ │ runGreedySweep │ └──────────────┘    │
│  └──────────────┘  └──────────────┘                        │
│         │                    │                              │
│         ▼                    ▼                              │
│  ┌──────────────┐  ┌──────────────┐                        │
│  │ launch()     │  │ testChatTiming│  ← 真实推理测量        │
│  │ (启动 llama- │  │ (发送 chat    │                        │
│  │  server)     │  │  completion) │                        │
│  └──────────────┘  └──────────────┘                        │
└─────────────────────────────────────────────────────────┘
```

### 关键数据结构

| 结构 | 位置 | 作用 |
|------|------|------|
| `testRequest` | L2300 | 批量测试请求体（bundle_ids / prompt / max_tokens / params / repeats / warmup / ctx） |
| `sweepRequest` | L3070 | 参数扫描请求体（model_id / params[] / mode / max_combos） |
| `testResult` | L2320 | 单个模型的测试结果（status / load_ms / tps / tokens / audit / vram_gb） |
| `sweepResult` | L3090 | 单个参数组合的测试结果（含 step / fixed / cached / is_best） |
| `TestHistoryRecord` | L2339 | 历史记录（id / time / type / mode / model / items） |
| `TestHistoryItem` | L2329 | 历史条目（name / status / load_ms / tps / tokens / error） |
| `testCacheEntry` | L2352 | L2 磁盘缓存条目（key / tps / tokens / load_ms / prompt_ps / eval_ms） |
| `testRunOpts` | L2710 | 单次测试运行选项（repeats / warmup / ctx / on_stage） |
| `sweepPlan` | L3110 | 扫描计划（combos / labels / total / sampled） |
| `sweepDim` | L3610 | 单个扫描维度（key / lbl / vals / strs） |

---

## 二、多模型批量测试（Multi-Model Test）

### 2.1 入口：`handleTestBatch`（L2380）

```
POST /api/test/batch
```

**运行流程：**

1. **解析请求体** `testRequest`，校验 `bundle_ids` 非空（否则 400）。
2. **默认值填充**：prompt 为空 → `"你好，用一句话介绍你自己"`；max_tokens 越界 → 16。
3. **生成 job_id**：`test_<unixnano>`，立即返回给前端（异步执行）。
4. **后台 goroutine 执行**：
   - 注册取消信号 `testCancel[jobID] = true`（兼容旧机制）。
   - 定义 `isCancelled()` 回调：优先检查 context，其次检查 `testCancel` 标记。
   - 调用 `parallelGroups()` 按显存预算切分模型组。
   - 对每组内的模型**并发**执行 `runOneTest`。
   - 每个模型测完后通过 WebSocket 广播 `test_progress`。
   - 汇总结果（跳过因取消未测的），调用 `recordBatchHistory`。
   - 广播 `test_done`。

### 2.2 显存感知并行：`parallelGroups`（L2530）

**核心逻辑：**

1. **实时刷新硬件信息**：调用 `config.DetectHardware()` 获取当前空闲显存（约 50ms）。
   - 保留 GPU 型号等静态信息，仅更新动态的 `FreeVRAMMB`。
2. **计算预算**：`budget = FreeVRAMMB / 1024 * 0.85`（使用 85% 可用显存）。
3. **估算每个模型的显存**：`modelVRAMGB(id, opts)`。
4. **贪心装箱（Bin Packing）**：
   - 遍历模型，若 `curSum + it.v > budget` 则把当前组关闭，新开一组。
   - 无法估算显存 → 保守：单个一组（串行）。
   - 返回分组结果，同组内模型并发测试。

### 2.3 单次测试核心：`runOneTestCore`（L3030）

**6 阶段状态机**：`validating → auditing → warming_up → benchmarking → cleaning`

```
阶段1: validating
  - 分配端口：findFreePort(9300)
  - 构建基础参数（ctx_size=1024 / predict=max_tokens / temperature=0.1 / n_gpu_layers / flash_attn=on / load_mode=mmap / threads=0 / cache_type_k=v=f16）
  - 应用 overrides（扫描参数覆盖）
  - 启动 llama-server：a.launch(bundleID, port, params, true)

阶段2: auditing（参数审计）
  - 参数审计：对比请求参数 vs 命令行实际生效参数（auditParams）
  - 估算显存：paramsVRAMGB

阶段3: 等待健康（health check）
  - 轮询 /health，最多 240s
  - 检测 OOM 熔断（testOOMHit）
  - 检测进程崩溃（!isRunning）
  - 成功后 healthy=true

阶段4: 预热（可选）
  - warmup=true 时先发一次小请求（你好, 4 tokens）

阶段5: benchmarking（正式测量）
  - repeats 次测量取平均（repeats=1 单次；>1 取平均更稳）
  - 每次调用 testChatTiming

阶段6: cleaning
  - stopRunner 回收进程
  - 返回最终结果
```

**详细逻辑：**

```go
func (a *App) runOneTestCore(...) testResult {
    res := testResult{BundleID: bundleID}
    b, ok := a.bundles.Get(bundleID)
    if !ok {
        res.Status = "fail"; res.Error = "模型不存在"; return res
    }
    res.Name = b.Name

    // 6 阶段状态机
    stage := func(s string) { if opts != nil && opts.OnStage != nil { opts.OnStage(s) } }
    stage("validating")

    port := a.findFreePort(9300)
    baseCtx := 1024
    if opts != nil && opts.Ctx > 0 { baseCtx = opts.Ctx }

    params := map[string]any{
        "ctx_size":     baseCtx,
        "predict":      maxTokens,
        "temperature":  0.1,
        "n_gpu_layers": b.DefaultParams.NGPULayers,
        "flash_attn":   "on",
        "load_mode":    "mmap",
        "threads":      0,
        "cache_type_k": "f16",
        "cache_type_v": "f16",
    }
    for k, v := range overrides {
        if v == nil { continue }
        params[k] = v
    }

    // 启动
    sess, err := a.launch(bundleID, port, params, true)
    if err != nil {
        res.Status = "fail"; res.Error = err.Error(); return res
    }

    // 资源兜底：无论成功/失败/取消，最终都确保回收进程
    defer func() {
        a.stopRunner(sess.ID)
        delete(a.testPorts, port)
        delete(a.testOOM, sess.ID)
    }()

    stage("auditing")
    res.VRAMGB = a.paramsVRAMGB(bundleID, params)
    res.Audit = a.auditParams(params, sess.CmdlineArgs)

    // 等待健康
    start := time.Now(); healthy := false
    for {
        if isCancelled != nil && isCancelled() {
            res.Status = "fail"; res.Error = "测试已取消"; return res
        }
        if a.testOOMHit(sess.ID) {
            res.Status = "fail"; res.Error = "显存不足（CUDA out of memory）"; return res
        }
        if !a.isRunning(sess.ID) { break }
        resp, err := http.Get(fmt.Sprintf("http://127.0.0.1:%d/health", port))
        if err == nil {
            resp.Body.Close()
            if resp.StatusCode == http.StatusOK { healthy = true; break }
        }
        if time.Since(start) > 240*time.Second { break }
        time.Sleep(2 * time.Second)
    }
    res.LoadMS = time.Since(start).Milliseconds()
    if !healthy {
        a.stopRunner(sess.ID)
        res.Status = "fail"
        res.Error = "加载超时或进程退出（当前机器可能无法运行该模型）"
        if tail := a.sessionLogTail(sess.ID, 8); len(tail) > 0 {
            res.Error += "。最近日志：\n" + strings.Join(tail, "\n")
        }
        return res
    }

    // 预热（可选）
    if opts != nil && opts.Warmup {
        stage("warming_up")
        _, _ = a.testChatTiming(port, "你好", 4)
    }

    // 正式测量
    stage("benchmarking")
    repeats := 1
    if opts != nil && opts.Repeats > 1 { repeats = opts.Repeats }

    var sumTPS, sumPPS, sumPMS, sumEMS float64
    var lastTokens int; okCount := 0; var lastErr error
    for i := 0; i < repeats; i++ {
        ct, terr := a.testChatTiming(port, prompt, maxTokens)
        if terr != nil { lastErr = terr; continue }
        sumTPS += ct.TPS; sumPPS += ct.PromptPS
        sumPMS += ct.PromptMS; sumEMS += ct.EvalMS; lastTokens = ct.Tokens; okCount++
    }
    stage("cleaning")
    a.stopRunner(sess.ID)

    if okCount == 0 {
        if lastErr == nil { lastErr = fmt.Errorf("测量失败") }
        res.Status = "fail"; res.Error = lastErr.Error(); return res
    }

    res.Status = "ok"
    res.TPS = sumTPS / float64(okCount)
    res.Tokens = lastTokens
    res.Repeats = okCount
    res.PromptPS = sumPPS / float64(okCount)
    res.PromptMS = sumPMS / float64(okCount)
    res.EvalMS = sumEMS / float64(okCount)
    return res
}
```

### 2.4 推理测量：`testChatTiming`（L4090）

```
POST /v1/chat/completions
{
  "model": "test",
  "messages": [{"role": "user", "content": "<prompt>"}],
  "max_tokens": <maxTokens>,
  "stream": false
}
```

**返回解析：**
```go
var out struct {
    Usage struct { CompletionTokens int `json:"completion_tokens"` } `json:"usage"`
    Timings struct {
        PredictedPerSecond float64 `json:"predicted_per_second"`  // TPS
        PromptPerSecond    float64 `json:"prompt_per_second"`    // PromptPS
        PromptMS           float64 `json:"prompt_ms"`            // 首 token（prompt eval）耗时
        EvalMS             float64 `json:"eval_ms"`              // eval 总耗时
    } `json:"timings"`
}
```

**看门狗**：单次测量超时 90s，防止死锁。

### 2.5 显存估算：`paramsVRAMGB` / `modelVRAMGB` / `comboVRAMGB`

调用 `config.EstimateVRAMEx()`，考虑：
- `n_gpu_layers`（GPU 层数）
- `ctx_size`（上下文长度）
- `cache_type_k` / `cache_type_v`（KV 缓存量化类型）
- `no_mmproj_offload`（mmproj 是否 CPU 卸载）
- 模型规格（block_count / context_length / head_count_kv / embedding_length / architecture / num_experts / is_moe）

---

## 三、参数扫描（Parameter Sweep）

### 3.1 入口：`handleTestSweep`（L3200）

```
POST /api/test/sweep
```

**两种模式：**

#### A. 穷举模式（exhaustive）

1. 解析请求体，校验 `model_id` 非空。
2. 生成 job_id：`sweep_<unixnano>`。
3. 计算笛卡尔积：`combos, labels, err := a.sweepCombos(req.Params)`。
4. 计算扫描计划：`plan, _ := a.planSweep(req.Params)`。
   - 若 `len(combos) > req.MaxCombos` → 截断到 MaxCombos。
5. 立即返回 `job_id` + `total` + `sampled` + `original_total`。
6. **后台 goroutine 执行**：
   - 对每个组合：
     - **L2 缓存命中**：`testCacheGet` → 直接复用结果（不启动模型）。
     - **否则**：`runOneTestCore` 真实测试 → `testCachePut` 写入缓存。
     - 跟踪最佳 TPS。
     - 每个组合测完后广播 `sweep_progress`。
   - 汇总结果，记录历史 `recordSweepHistory`。
   - 广播 `sweep_done`（含 best 索引 + best_params）。

#### B. 智能寻优模式（greedy）

调用 `runGreedySweepAsync`（L3664），见下节。

### 3.2 扫描计划：`planSweep`（L3160）

**核心逻辑：**

1. **解析每个参数维度**：
   - 通过 `registry.Get(key)` 获取参数定义（判断 Kind）。
   - `castSweepValue(pd, raw)` 将字符串转为类型化值（int/float/bool/string）。
   - 空值跳过。
2. **计算笛卡尔积总数**：`total = ∏ len(d.vals)`。
3. **分支判断**：
   - `total <= sweepCap(512)` → 完整笛卡尔积（`enumerateDims`）。
   - `total > sweepCap` → **分层覆盖采样**（LHS 拉丁超立方体抽样），抽取 512 个组合。

**`castSweepValue` 类型转换：**
```go
switch pd.Kind {
case KindInt, KindRange:  // 整数
    n, err := strconv.Atoi(raw)
case KindFloat:           // 浮点数
    f, err := strconv.ParseFloat(raw, 64)
case KindBool:            // 布尔（on/off/true/false/1/0/yes/no/开/关）
    // ...
default:                  // 字符串
    return strings.TrimSpace(raw)
}
```

### 3.3 笛卡尔积枚举：`enumerateDims`（L3380）

```go
func enumerateDims(dims []sweepDim) ([]map[string]any, []string) {
    total := 1
    for _, d := range dims { total *= len(d.vals) }
    combos := make([]map[string]any, 0, total)
    labels := make([]string, 0, total)
    idx := make([]int, len(dims))
    for {
        ov := make(map[string]any, len(dims))
        for i, d := range dims {
            ov[d.key] = d.vals[idx[i]]
        }
        combos = append(combos, ov)
        labels = append(labels, dimsLabel(ov, dims))
        // 进位逻辑（类似数字递增）
        k := len(dims) - 1
        for k >= 0 {
            idx[k]++
            if idx[k] < len(dims[k].vals) { break }
            idx[k] = 0
            k--
        }
        if k < 0 { break }
    }
    return combos, labels
}
```

### 3.4 分层覆盖采样：`lhsSample`（L3140）

**拉丁超立方体抽样（Latin Hypercube Sampling）：**

1. 为每个维度生成随机排列的索引矩阵。
2. 采样数取 `min(n, maxLen)`（保证每个维度至少覆盖一次）。
3. 逐行取索引生成组合。
4. 去重（seen 集合）。
5. 若结果不足，随机补齐。

**优点**：高维参数空间下，保证每个维度的每个值至少被覆盖一次，且整体分布均匀。

### 3.5 智能寻优：`runGreedySweepAsync`（L3664）

**贪心算法（坐标下降 + 改进阈值）：**

```
const (
    exploreN      = 20    // 全局探索采样数
    refineTopK    = 2     // 精调保留的前 K 个起点
    refineRounds  = 2     // 每起点精调轮数
    improveThresh = 0.05  // 改进阈值（相对）
)
```

**Phase 1：全局探索（分层随机采样）**
```go
// 若 totalCombos <= explore：完整枚举
// 否则：每个维度固定一个值，其余维度随机采样；再随机补齐到 exploreN
for _, ov := range sampled {
    res, _ := runOne(ov, "🌐 全局探索")
    if res.Status == "ok" { explored = append(explored, cand{params: ov, tps: res.TPS}) }
}
```

**Phase 2：多起点局部精调（坐标下降）**
```go
// 保留前 refineTopK 个最优起点
sort.Slice(explored, func(i, j int) bool { return explored[i].tps > explored[j].tps })
explored = explored[:refineTopK]

for si, st := range explored {
    cur := clone(st.params); curTPS := st.tps
    for round := 1; round <= refineRounds; round++ {
        improved := false
        for _, d := range dims {  // 逐个维度
            bestInDim := curTPS; var winVal any
            for i, v := range d.vals {  // 该维度所有值
                ov := clone(cur); ov[d.key] = v
                res, _ := runOne(ov, "🔍 精调起点%d · 第%d轮", si+1, round)
                if res.Status == "ok" && res.TPS > bestInDim {
                    bestInDim = res.TPS; winVal = v
                }
            }
            // 动态改进阈值：绝对阈值 0.5 tok/s 与相对阈值 2% 取较大值
            threshold := math.Max(0.5, curTPS * 0.02)
            if winVal != nil && bestInDim > curTPS + threshold {
                cur[d.key] = winVal; curTPS = bestInDim; improved = true
            }
        }
        if !improved { break }  // 该起点收敛
    }
    if curTPS > bestGlobalTPS { bestGlobalTPS = curTPS; bestGlobal = cur }
}
```

**Phase 3：最终确认**
```go
// 对全局最优配置做一次干净测量
if bestGlobal == nil {
    bestGlobal = cloneBase()
    for _, d := range dims { bestGlobal[d.key] = d.vals[0] }
}
fres, _ := runOne(bestGlobal, "🏁 最终配置")
```

**改进阈值逻辑：**
```go
const minAbsImprove = 0.5
relImprove := curTPS * 0.02
threshold := math.Max(minAbsImprove, relImprove)
if winVal != nil && bestInDim > curTPS + threshold {
    // 采纳改进
}
```

---

## 四、测试历史（Test History）

### 4.1 数据结构

```go
type TestHistoryRecord struct {
    ID        string            `json:"id"`
    Time      string            `json:"time"`
    Type      string            `json:"type"`  // batch | sweep
    Mode      string            `json:"mode,omitempty"`
    Model     string            `json:"model,omitempty"`
    Prompt    string            `json:"prompt"`
    MaxTokens int               `json:"max_tokens"`
    Summary   string            `json:"summary"`
    Items     []TestHistoryItem `json:"items"`
}

type TestHistoryItem struct {
    Name   string  `json:"name"`
    Label  string  `json:"label,omitempty"`
    Status string  `json:"status"`
    LoadMS int64   `json:"load_ms"`
    TPS    float64 `json:"tps"`
    Tokens int     `json:"tokens"`
    Error  string  `json:"error,omitempty"`
}
```

### 4.2 历史操作

| 函数 | 位置 | 作用 |
|------|------|------|
| `loadTestHistory` | L2448 | 从 `data/test_history.json` 加载 |
| `saveTestHistory` | L2459 | 持久化历史 |
| `appendTestHistory` | L2466 | 追加历史（上限 50 条，最新在前） |
| `recordBatchHistory` | L2490 | 记录批量测试结果 |
| `recordSweepHistory` | L2510 | 记录扫描结果 |
| `handleTestHistory` | L2600 | GET 返回历史 |
| `handleTestHistoryClear` | L2610 | DELETE 清空历史 |

**`recordBatchHistory` 汇总逻辑：**
```go
func (a *App) recordBatchHistory(req testRequest, results []testResult) {
    items := make([]TestHistoryItem, 0, len(results))
    bestTPS, bestName, okCount := 0.0, "", 0
    for _, r := range results {
        items = append(items, TestHistoryItem{Name: r.Name, Status: r.Status, ...})
        if r.Status == "ok" && r.TPS > bestTPS { bestTPS, bestName = r.TPS, r.Name }
        if r.Status == "ok" { okCount++ }
    }
    summary := fmt.Sprintf("%d 个模型 · ✅ %d 通过", len(results), okCount)
    if bestName != "" { summary += fmt.Sprintf(" · 最快 %s %.1f tok/s", bestName, bestTPS) }
    a.appendTestHistory(TestHistoryRecord{
        ID: "h" + strconv.FormatInt(time.Now().UnixNano(), 36),
        Time: time.Now().Format("2006-01-02 15:04:05"),
        Type: "batch", Prompt: req.Prompt, MaxTokens: req.MaxTokens,
        Summary: summary, Items: items,
    })
}
```

---

## 五、L2 磁盘缓存（Test Cache）

### 5.1 数据结构

```go
type testCacheEntry struct {
    Key      string  `json:"key"`
    TPS      float64 `json:"tps"`
    Tokens   int     `json:"tokens"`
    LoadMS   int64   `json:"load_ms"`
    PromptPS float64 `json:"prompt_ps"`
    PromptMS float64 `json:"prompt_ms"`
    EvalMS   float64 `json:"eval_ms"`
    Time     string  `json:"time"`
}
```

### 5.2 缓存键生成：`testCacheKey`（L2406）

```go
func (a *App) testCacheKey(bundleID, fp string, baseCtx int, ov map[string]any) string {
    parts := []string{bundleID, fp, "ctx=" + strconv.Itoa(baseCtx)}
    var ks []string
    for k := range ov { ks = append(ks, k) }
    sort.Strings(ks)  // 排序保证稳定
    for _, k := range ks {
        parts = append(parts, k+"="+fmt.Sprintf("%v", ov[k]))
    }
    return strings.Join(parts, "|")
}
```

**键组成**：`bundleID | fileFingerprint | ctx=N | param1=v1 | param2=v2 | ...`

### 5.3 缓存操作

| 函数 | 位置 | 作用 |
|------|------|------|
| `loadTestCache` | L2365 | 从 `data/test_cache.json` 加载 |
| `saveTestCache` | L2376 | 持久化缓存 |
| `testCacheGet` | L2419 | 获取缓存结果（返回 sweepResult） |
| `testCachePut` | L2433 | 写入缓存（仅 ok 状态） |
| `fileFingerprint` | L2348 | 模型文件指纹（SHA256 / size+mtime / bundleID） |

**`fileFingerprint` 优先级：**
1. bundle 中 `BaseModel.SHA256`（优先）。
2. fallback：`size-mtime`（如 `15825298752-1786824192`）。
3. 最终 fallback：bundleID 自身。

**注意**：`testCachePut` 仅缓存 `status == "ok"` 的结果（失败的组合不缓存）。

---

## 六、参数审计（Param Audit）

### 6.1 作用

对比**请求参数** vs **命令行实际生效参数**，验证扫描是否真的生效（如 `--ctx-size` / `--n-gpu-layers` 是否被 honor）。

### 6.2 实现：`auditParams`（L2960）

```go
func (a *App) auditParams(req map[string]any, args []string) []paramAudit {
    flagKeys := a.flagKeyIndex()  // CLI flag → registry key 映射
    eff := parseEffectiveArgs(args, flagKeys, a.registry)  // 解析实际生效参数

    // 跳过与测量无关的固定项
    skip := map[string]bool{"model": true, "port": true, "host": true, "metrics": true, "mmproj": true, "api_key": true}

    // 对每个请求参数：
    pa := paramAudit{
        Key: k,
        Requested: fmtParamVal(req[k]),
        Effective: fmtParamVal(eff[k]),  // 可能为空（未生效）
        Same: ok && effStr == rq,
    }
    if !ok { pa.Note = "未在命令行中生效（被忽略或模型默认覆盖）" }
    else if pa.Same { pa.Note = "已生效" }
    else { pa.Note = "实际值被调整（自动合并）" }
    return out
}
```

**`parseEffectiveArgs`**：解析真实 CLI args，识别 `--flag` / `-flag` / `--flag=value` 形式，映射回 registry key。

---

## 七、端口分配（Port Allocation）

### 7.1 `findFreePort`（L4150）

```go
func (a *App) findFreePort(from int) int {
    a.testPortMu.Lock()
    defer a.testPortMu.Unlock()
    if a.testPorts == nil { a.testPorts = map[int]bool{} }
    for p := from; p < from+500; p++ {
        if a.testPorts[p] { continue }  // 已分配
        if _, used := a.sessions.PortInUse(p); !used {
            a.testPorts[p] = true
            return p
        }
    }
    return from
}
```

**并发保护**：`testPortMu` 互斥锁 + `testPorts` 已分配集合，避免并行测试时端口冲突。

---

## 八、OOM 熔断（CUDA Out of Memory）

### 8.1 检测机制

在 `handleServerLine`（L540）中检测显存不足日志：
```go
if strings.Contains(low, "out of memory") ||
   strings.Contains(low, "cudamalloc") ||
   strings.Contains(low, "cuda error") ||
   strings.Contains(low, "cuda_error_out_of_memory") ||
   strings.Contains(low, "hip out of memory") ||  // ROCm 兼容
   strings.Contains(low, "cudamalloc failed") {
    a.mu.Lock()
    a.testOOM[sid] = true
    a.mu.Unlock()
}
```

### 8.2 熔断效果

- `runOneTestCore` 中 `testOOMHit()` 检测到 → 立即中止，返回 `"显存不足（CUDA out of memory）"`。
- `testOOM` 标记在 `defer` 中清除（`delete(a.testOOM, sess.ID)`）。

---

## 九、取消机制（Cancellation）

### 9.1 入口：`handleTestCancel`（L2560）

```
POST /api/test/cancel
{ "job_id": "test_123" }
```

设置 `testCancel[jobID] = true`。

### 9.2 检查机制

`isCancelled()` 回调：
```go
isCancelled := func() bool {
    select {
    case <-ctx.Done():
        return true
    default:
        return a.testJobCancelled(jobID)
    }
}
```

**检查点**：
- 批量测试：每组开始前。
- 扫描测试：每个组合开始前。
- `runOneTestCore`：健康等待循环、测量循环。

### 9.3 清理机制

```go
defer func() {
    a.mu.Lock()
    delete(a.testCancel, jobID)
    a.mu.Unlock()
}()
```

---

## 十、运行流程图

### 10.1 批量测试流程

```
handleTestBatch
  │
  ├─ 解析请求 → 校验 → 生成 job_id → 立即返回
  │
  └─ 后台 goroutine
       │
       ├─ 注册取消信号
       │
       ├─ parallelGroups() → 显存感知分组
       │
       ├─ for each group (并发)
       │     │
       │     └─ for each model (并发)
       │           │
       │           └─ runOneTestCore()
       │                 │
       │                 ├─ validating: 启动 llama-server
       │                 ├─ auditing: 参数审计 + 显存估算
       │                 ├─ health check: 轮询 /health (≤240s)
       │                 ├─ warming_up: 预热 (可选)
       │                 ├─ benchmarking: repeats 次测量
       │                 └─ cleaning: 停止进程
       │
       ├─ 汇总结果 → recordBatchHistory()
       └─ 广播 test_done
```

### 10.2 参数扫描流程（穷举）

```
handleTestSweep (exhaustive)
  │
  ├─ 解析请求 → 校验 → 生成 job_id → 立即返回 total/sampled
  │
  └─ 后台 goroutine
       │
       ├─ planSweep() → 计算组合（笛卡尔积或 LHS 采样）
       │
       ├─ for each combo
       │     │
       │     ├─ testCacheGet() → 命中则复用（不启动模型）
       │     │
       │     └─ 否则 runOneTestCore() → testCachePut()
       │           │
       │           └─ 跟踪最佳 TPS
       │
       ├─ recordSweepHistory()
       └─ 广播 sweep_done (含 best)
```

### 10.3 参数扫描流程（智能寻优）

```
handleTestSweep (greedy)
  │
  └─ runGreedySweepAsync()
       │
       ├─ Phase 1: 全局探索（分层随机采样 exploreN=20）
       │     └─ for each sampled → runOne("🌐 全局探索")
       │
       ├─ Phase 2: 多起点局部精调（坐标下降）
       │     ├─ 保留前 refineTopK=2 个最优起点
       │     └─ for each start (refineRounds=2)
       │           └─ for each dim → 逐个维度坐标下降
       │                 └─ 动态改进阈值：max(0.5, curTPS*0.02)
       │
       ├─ Phase 3: 最终确认
       │     └─ runOne(bestGlobal, "🏁 最终配置")
       │
       ├─ recordSweepHistory(mode="greedy")
       └─ 广播 sweep_done (含 best_params)
```

---

## 十一、关键参数设置汇总

### 11.1 测试基础参数（runOneTestCore）

| 参数 | 默认值 | 说明 |
|------|--------|------|
| `ctx_size` | 1024（或 req.Ctx） | 测试基础上下文 |
| `predict` | max_tokens（≤512） | 生成 token 数 |
| `temperature` | 0.1 | 低温度保证确定性 |
| `n_gpu_layers` | bundle 默认 | GPU 层数 |
| `flash_attn` | on | 注意力优化 |
| `load_mode` | mmap | 内存映射加载 |
| `threads` | 0 | 0=自动 |
| `cache_type_k/v` | f16 | KV 缓存类型 |

### 11.2 批量测试选项（testRequest）

| 字段 | 类型 | 默认 | 说明 |
|------|------|------|------|
| `bundle_ids` | []string | - | 待测模型 |
| `prompt` | string | "你好..." | 测试 prompt |
| `max_tokens` | int | 16 | 生成 token 数 |
| `params` | map[string]any | - | 参数覆盖 |
| `repeats` | int | 1 | 测量次数（0/1=单次） |
| `warmup` | bool | false | 测量前预热 |
| `ctx` | int | 0 | 测试基础 ctx（0=默认 1024） |

### 11.3 参数扫描选项（sweepRequest）

| 字段 | 类型 | 默认 | 说明 |
|------|------|------|------|
| `model_id` | string | - | 目标模型 |
| `prompt` | string | "你好..." | 测试 prompt |
| `max_tokens` | int | 16 | 生成 token 数 |
| `mode` | string | - | exhaustive \| greedy |
| `params` | []sweepParamReq | - | 扫描参数（key + values） |
| `repeats` | int | 1 | 测量次数 |
| `warmup` | bool | false | 测量前预热 |
| `ctx` | int | 0 | 测试基础 ctx |
| `max_combos` | int | 0 | 最大测试组合数（0=不限制） |

### 11.4 扫描维度标签（sweepShort）

| Key | Label |
|-----|-------|
| `n_gpu_layers` | GPU层 |
| `main_gpu` | 主GPU |
| `split_mode` | 拆分 |
| `ctx_size` | ctx |
| `threads` | 线程 |
| `threads_batch` | 批线程 |
| `batch_size` | batch |
| `ubatch_size` | ubatch |
| `cache_type_k` | K缓存 |
| `cache_type_v` | V缓存 |
| `rope_scaling` | rope |
| `flash_attn` | FA |
| `parallel` | 槽位 |
| `tensor_split` | tsplit |
| `load_mode` | 加载 |
| `numa` | NUMA |
| `kv_unified` | 统一KV |
| `cpu_moe` | MoE-CPU |
| `cache_ram` | 缓存RAM |
| `ctx_checkpoints` | 检查点 |
| `checkpoint_min_step` | 检查点间隔 |

---

## 十二、相关文件

| 文件 | 作用 |
|------|------|
| `cmd/server/main.go` | 测试/扫描引擎核心（L2280–4400） |
| `internal/llama/runner.go` | llama-server 子进程管理 |
| `internal/config/registry.go` | 参数注册表（flag/key/Kind） |
| `internal/config/estimate.go` | 显存估算（EstimateVRAMEx） |
| `data/test_history.json` | 测试历史（最近 50 条） |
| `data/test_cache.json` | L2 磁盘缓存 |
| `docs/module-docs/11-main.md` | 主入口模块文档 |
