# 模块 07：`internal/downloader/` — HuggingFace 下载

## 功能概述

实现支持断点续传（HTTP Range）的模型下载，支持镜像（`HF_ENDPOINT` 环境变量），采用与 llama.cpp 兼容的仓库式缓存布局。

## 核心职责

1. 浏览 HF 仓库文件树
2. 断点续传下载（HTTP Range）
3. 仓库式缓存布局
4. 镜像支持

## 关键数据结构

### `RepoFile`
```go
type RepoFile struct {
    Name string `json:"name"`
    Size int64  `json:"size"`
}
```

### `Endpoint` 优先级
```
运行时覆盖 (SetEndpoint) > HF_ENDPOINT 环境变量 > https://huggingface.co
```

## 核心实现细节

### 1. 端点解析（`Endpoint()`）

```go
func Endpoint() string {
    if endpointOverride != "" { return override }
    if e := os.Getenv("HF_ENDPOINT"); e != "" { return e }
    return "https://huggingface.co"
}
```

### 2. 文件树浏览（`ListFiles()`）

```go
URL: /api/models/{repo}/tree/{revision}?recursive=true&expand=true
    ↓
1. 过滤 type=file 且以 .gguf 结尾
2. 按文件大小排序
```

### 3. 断点续传下载（`Download()`）

```go
func Download(ctx, repo, filename, revision, root, progress) (string, error)
    ↓
1. 校验 repo/filename 非空
2. 计算目标路径：root/models--org--name/snapshots/<rev>/<file>
3. 检查 .part 文件 → 获取已下载字节数 (from)
4. 请求头带 Range: bytes=from-
5. 流式写入 .part 文件
6. 原子重命名 .part → 目标文件
```

**关键细节**：
- **断点续传**：存在 `.part` 文件则从已下载位置续传
- **原子性**：Windows 上 `os.Rename` 若目标已存在会失败，需先删除旧文件
- **进度回调**：`progress(done, total)` 供 UI 显示进度
- **缓存布局**：`<root>/models--org--name/snapshots/<revision>/<file>`

## 设计亮点

- **断点续传**：网络中断可恢复
- **原子落盘**：避免部分下载损坏模型
- **兼容布局**：与 llama.cpp 缓存目录一致
- **镜像支持**：支持 HF_ENDPOINT 国内镜像

## 相关调用方

- `cmd/server/main.go`：`/api/hf/download`
- `bundle/`：下载后自动入库
