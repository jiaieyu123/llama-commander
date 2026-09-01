# 模块 01：`internal/gguf/` — GGUF 文件解析器

## 功能概述

轻量级解析 GGUF（GPT-Generated Unified Format）文件头，提取模型元数据。
**零外部依赖**，仅使用 Go 标准库，是项目中最"纯粹"的模块之一。

## 核心职责

1. 解析 GGUF 文件头（magic、版本、张量数、KV 数）
2. 提取模型元数据（架构、块数、上下文长度、KV 头数、词表大小、MoE 专家数等）
3. 检测 MTP（多 token 预测）张量名称，用于投机解码判断
4. 支持超大元数据（150k+ tokens 词表）的流式读取

## 关键数据结构

### `ModelInfo`
解析后的模型元数据：
```go
type ModelInfo struct {
    Path            string         // 文件路径
    FileSizeMB      float64        // 文件大小（MB）
    Version         uint32         // GGUF 格式版本
    Architecture    string         // 架构（如 llama、qwen）
    ContextLength   uint64         // 上下文长度
    BlockCount      uint64         // 块数
    HeadCount       uint64         // 注意力头数
    HeadCountKV     uint64         // KV 头数
    EmbeddingLength uint64         // 嵌入长度
    VocabSize       uint64         // 词表大小
    NumExperts      uint64         // MoE 专家数
    FileType        uint32         // 量化类型
    FileTypeName    string         // 量化类型名称
    Moe             bool           // 是否为 MoE
    Metadata        map[string]any // 原始元数据
    RawKeys         []string       // 原始 key 列表
    TensorNames     []string       // 张量名称（MTP 检测用）
}
```

## 核心实现细节

### 1. 解析流程（`ParseReader`）

```
Parse(path) → ParseReader(f, size, path)
    ↓
1. 创建 ggufReader（buffered reader，1MB 缓冲区）
2. checkMagic() — 校验 "GGUF" magic
3. 读取 version (u32)
4. 读取 tensorCount (u64)
5. 读取 kvCount (u64) — 上限 1<<20 防损坏文件
6. 循环读取 kvCount 个 KV 条目：
   - key = g.str()
   - value = g.value()
   - info.Metadata[key] = val
7. 读取 tensorCount 个张量名称（跳过 dims/type/offset）
   - 张量名称用于检测 MTP（llama.cpp 命名为 "blk.<n>.nextn.*"）
8. extractKnownFields() — 映射已知字段
```

### 2. 低层读取器（`ggufReader`）

从磁盘按需读取，**不加载整个文件到内存**：
- `readN(n)`：读取 n 字节，受 `rem`（剩余字节）限制
- `u8/u16/u32/u64/i64/f32`：小端序读取各种类型
- `skip(n)`：跳过 n 字节

### 3. 已知字段映射（`extractKnownFields`）

使用 `findBySuffix` 按后缀匹配元数据 key：
```go
Architecture = Metadata["general.architecture"]
ContextLength = Metadata[".context_length"]
BlockCount    = Metadata[".block_count"]
HeadCountKV   = Metadata[".head_count_kv"]
NumExperts    = Metadata[".expert_count"]
Moe           = NumExperts > 0
```

## 设计亮点

- **内存友好**：只读文件头，不读张量数据
- **大词表支持**：流式读取元数据，处理超大 tokenizer
- **MTP 检测**：通过张量名称识别投机解码模型
- **健壮性**：对损坏文件返回明确错误（bad magic、implausible count）

## 相关调用方

- `bundle/scan.go`：扫描模型时调用 `gguf.Parse()`
- `bundle/manager.go`：构建 Bundle 时解析元数据
