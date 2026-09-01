# 模块 10：`internal/fsbrowse/` — 内置文件浏览器

## 功能概述

为"添加模型"流程提供目录和 `.gguf` 文件浏览。

## 核心职责

1. 列出目录内容
2. 过滤 `.gguf` 文件
3. 支持驱动器根浏览（Windows）

## 关键数据结构

### `Entry`
```go
type Entry struct {
    Name  string `json:"name"`
    Path  string `json:"path"`
    Size  int64  `json:"size"`
    IsDir bool   `json:"is_dir"`
}
```

### `Result`
```go
type Result struct {
    Path   string  `json:"path"`
    Parent string  `json:"parent"` // "" 表示根
    IsRoot bool    `json:"is_root"`
    Dirs   []Entry `json:"dirs"`
    Files  []Entry `json:"files"` // 仅 *.gguf
}
```

## 核心实现细节

### `List(path)`

```go
func List(path string) (*Result, error) {
    // 1. 空路径 → 列出驱动器根（Windows）或 "/"（其他平台）
    // 2. 统计文件 → 若不是目录 → 取其父目录
    // 3. 遍历目录条目
    //    - 目录 → 加入 Dirs
    //    - .gguf 文件 → 加入 Files（带大小）
    //    - 其他文件 → 忽略
}
```

**特点**：
- 空路径特殊处理（列出根目录）
- 允许选择文件 → 显示其父目录
- 仅展示 `.gguf` 文件（过滤无关文件）

## 设计亮点

- **平台感知**：Windows 支持驱动器根浏览
- **文件过滤**：仅展示相关 `.gguf` 文件
- **简洁结构**：目录/文件分离

## 相关调用方

- `cmd/server/main.go`：添加模型流程
- `bundle/`：浏览后导入模型
