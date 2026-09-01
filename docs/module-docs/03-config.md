# 模块 03：`internal/config/` — 参数配置引擎

## 功能概述

管理 llama-server 的完整参数矩阵（~100 项 2026 参数）+ 三级继承链 + 硬件检测 + VRAM 估算 + 一键优化 + 配置健康审计。

## 子模块划分

| 文件 | 职责 |
|------|------|
| `registry.go` | 参数矩阵定义（单一数据源） |
| `chain.go` | 三级参数继承链 |
| `auto.go` | 硬件检测 + VRAM 估算 + 一键优化 |
| `audit.go` | 配置健康审计 |
| `windows.go` | Windows 物理内存检测 |
| `auto_other.go` | 非 Windows 平台占位 |

## 核心实现细节

### 1. 参数矩阵（`registry.go`）

**`ParamDef`** — 单个参数定义：
```go
type ParamDef struct {
    Key           string    // 规范 key，如 "n_gpu_layers"
    Flag          string    // 短标志，如 "-ngl"
    LongFlag      string    // 长标志，如 "--n-gpu-layers"
    Kind          ParamKind // 控件类型
    Group         ParamGroup // UI 分组
    Label         string    // 中文标签
    Default       any       // 默认值
    Enum          []string  // 枚举选项
    Min, Max      float64   // 数值边界
    RequiresValue bool      // false=布尔标志
    AlwaysEmit    bool      // true=默认也输出
}
```

**`ParamKind`**（9 种控件类型）：
- `int` / `float`：带边界的数值
- `bool`：纯标志，无值
- `string`：自由文本
- `enum`：下拉选择
- `multi`：多选
- `range`：lo-hi 风格字符串
- `secret`：密码框
- `file`：文件选择器

**`ParamGroup`**（10 个 UI 分组）：
- 📁 基础设置 / ⚡ 性能调优 / 🧠 内存与加载 / 🔧 CPU 与调度
- 🎨 生成控制 / 🧩 投机解码 / 📥 模型来源 / 🌐 网络与安全
- 🧩 模板与推理 / 📝 日志与调试

**`Registry`** — 参数注册表：
- `NewRegistry()`：构建完整参数矩阵
- `Get(key)` / `All()`：查询参数定义
- `Params()`：返回带 help 文本的可序列化定义

### 2. 三级继承链（`chain.go`）

**`SourceLevel`**（3 个层级）：
- Level 1 🌐 全局默认（`config.json` → `default_params`）
- Level 2 📦 模型专属（`bundles.json` → `bundle.default_params`）
- Level 3 ✏️ 会话级（用户表单）

**`Chain`** — 参数合并：
```go
func (c *Chain) Merge(global, model, session map[string]any)
    // 合并顺序：global < model < session，高层级覆盖低层级
```

**`ParamValue`** — 值与来源绑定：
```go
type ParamValue struct {
    Value  any
    Source SourceLevel  // 记录来源，UI 显示来源徽章
}
```

### 3. 硬件检测与 VRAM 估算（`auto.go`）

**`HardwareInfo`**：
```go
type HardwareInfo struct {
    GPUModels   []string
    TotalVRAMMB uint64
    FreeVRAMMB  uint64
    GPUCount    int
    CPUCores    int
    SystemRAMMB uint64
    CUDAMajor   int
    Backend     string  // cuda|vulkan|metal|cpu
}
```

**`DetectHardware()`**：
- Windows：`GlobalMemoryStatusEx` 获取物理内存
- NVIDIA：`nvidia-smi --query-gpu=name,memory.total,memory.free`
- 无 GPU：回退到 CPU-only 信息

**`Recommend()`** — 一键优化：
- 场景预设：`speed` / `context` / `lowvram` / `creative`
- 检测 MoE → 建议 `--cpu-moe`
- 检测 mmproj → speed/lowvram 场景建议走 CPU
- 估算 GPU 层数（`estimateLayers`）
- 计算估算 VRAM（`EstimateVRAMEx`）

**`estimateLayers()`** — 显存感知层数估算：
- 迭代候选层数，找最大能放入的
- 安全余量：普通 1.5GB，lowvram 2GB
- 考虑 KV 缓存类型和 mmproj 放置

**`EstimateVRAMEx()`** — VRAM 估算公式：
```
weightGB = fileSize * (ngl / blockCount)
+ mmprojSize (if not CPU)
+ kvGB = ctx * headCountKV * embedLen * (kvK_bytes + kvV_bytes) / 1024^3
+ overhead (0.5GB buffers)
```

**KV 缓存每元素字节数**：
```go
f32 → 4.0, bf16/f16 → 2.0, q8_0 → 1.0
q4_0/q4_1/iq4_nl → 0.5, q5_0/q5_1 → 0.625
```

### 4. 配置健康审计（`audit.go`）

**`AuditConfig()`** — 返回结构化告警：
- `AuditInfo`（💡 优化建议）/ `AuditWarn`（🟡 提示）/ `AuditError`（🔴 错误）

**审计规则**：
1. **VRAM 超限**：估算 > 可用显存 → Error；余量 < 0.5GB → Warn
2. **mmproj 走 CPU**：纯文本场景建议省显存 → Info
3. **采样器冲突**：Mirostat + top-k/top-p 同时启用 → Warn
4. **KV 量化 + FA 关闭**：性能可能下降 → Warn
5. **MoE 建议**：建议启用 `--cpu-moe` → Info
6. **上下文超限**：超过模型原生上下文 → Warn

## 设计亮点

- **单一数据源**：参数矩阵集中定义，UI/CLI/审计共用
- **显存感知**：估算精确到 KV 缓存量化类型
- **场景驱动**：一键优化适配不同使用场景
- **主动告警**：提前发现常见配置坑
