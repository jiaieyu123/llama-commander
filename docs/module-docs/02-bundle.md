# 模块 02：`internal/bundle/` — 模型组合包管理

## 功能概述

管理"模型捆绑包"（Model Bundle）—— 主模型 + 可选的配套组件（视觉编码器 mmproj、草稿模型、LoRA 适配器）及其默认参数集。持久化于 `data/bundles.json`。

## 核心职责

1. 模型组合包的 CRUD 操作
2. 智能捆绑检测（mmproj / draft / LoRA / 分片）
3. 分片模型检测与分组
4. 使用统计追踪
5. 测试配置保存与复用

## 关键数据结构

### `Bundle`
```go
type Bundle struct {
    Name       string
    SourceType SourceType  // local/huggingface/url/docker/cache
    BaseModel  ModelFile   // 主模型文件
    MMProj     ModelFile   // 视觉投影器
    DraftModel DraftModel  // 草稿模型
    LORAList   []LoRA      // LoRA 适配器列表
    Tags       []string    // 标签（vision/mtp 等）
    DefaultParams DefaultParams
    ShardInfo  ShardInfo
    UsageStats UsageStats
}
```

### `ModelFile`
```go
type ModelFile struct {
    Path       string
    FileSizeMB float64
    SHA256     string
    Exists     bool
    Metadata   *gguf.ModelInfo
}
```

### `DraftModel`（投机解码草稿模型）
```go
type DraftModel struct {
    Path     string
    Enabled  bool
    SpecType string   // 如 "draft-simple"
    SpecParams map[string]any  // n_max, n_min, p_split, p_min
}
```

### `ShardInfo`（分片信息）
```go
type ShardInfo struct {
    IsSharded        bool
    TotalShards      int
    ShardPattern     string
    AllShardsPresent bool
    ShardFiles       []string
}
```

## 核心实现细节

### 1. 智能捆绑检测（`scan.go`）

**`DetectCompanions()`** — 按文件名关键词分类：
```go
func classifyCompanion(name string) string {
    lower := strings.ToLower(name)
    switch {
    case contains(lower, "mmproj") || contains(lower, "mm_projector"): return "mmproj"
    case contains(lower, "draft"):                                     return "draft"
    case contains(lower, "lora") || contains(lower, "adapter"):        return "lora"
    }
    return ""
}
```

**`ScanDir()`** — 递归扫描目录：
- 跳过 companion 文件（它们依附于主模型）
- 分片集合只访问第一个分片
- 解析失败的文件不静默丢弃，返回路径和原因供 UI 说明

**`applyCompanions()`** — 将 companion 绑定到 bundle：
- mmproj → 添加 "vision" 标签，解析其元数据
- draft → 设置默认投机解码参数（n_max=3, n_min=0, p_split=0.10）
- lora → 添加到 LORAList（默认 scale=1.0）

### 2. 分片检测（`shard.go`）

**`ParseShardName()`** — 正则匹配 `model-00001-of-00002.gguf`：
```go
var shardPattern = regexp.MustCompile(`^(.+)-(\d{5})-of-(\d{5})\.gguf$`)
```

**`InspectDir()`** — 扫描目录，按 prefix 分组：
- 检测每个 prefix 的总片数
- 检查 1..total 是否全部存在（AllShardsPresent）
- 返回完整的分片文件列表

**`Primary()`** — 返回第一个分片路径（llama-server 加载的）

### 3. Bundle CRUD（`manager.go`）

- `NewManager(path)`：加载 `bundles.json`
- `Create/Get/List/Delete`：CRUD 操作
- `Save/Load`：JSON 持久化
- `AddConfigs/DeleteConfigs`：管理每个 bundle 的默认参数集

## 设计亮点

- **智能识别**：自动识别并绑定配套组件
- **分片感知**：正确处理大型分片模型
- **健壮扫描**：解析失败的文件给出明确反馈
- **使用追踪**：统计 Token 生成、崩溃次数等

## 相关调用方

- `cmd/server/main.go`：扫描/导入/启动模型
- `config/`：构建 ModelSpec 供参数优化
