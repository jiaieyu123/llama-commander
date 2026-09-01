# 模块 09：`internal/websearch/` — 内置网页搜索引擎

## 功能概述

为 agent 工具提供内置网页搜索能力。支持多提供商：Bing HTML 抓取（默认，免密钥，国内可用）、Brave Search API、Tavily API。

处理流水线：提供商搜索 → 低质量过滤 → 去重 → 新鲜度排序 → 内容抓取 → 相关性重排。

可作为 MCP stdio 服务器独立运行（`llama-launcher websearch-mcp`）。

## 核心职责

1. 多提供商搜索（Bing/Brave/Tavily）
2. 完整质量处理流水线
3. MCP stdio 服务器

## 关键数据结构

### `Result`
```go
type Result struct {
    Title   string  // 网页标题
    URL     string  // 链接
    Snippet string  // 摘要
    Content string  // 抓取并抽取的正文章段
    Date    string  // 推断发布日期（YYYY-MM-DD）
    Score   float64 // 重排分数（内部用）
}
```

### `Provider` 接口
```go
type Provider interface {
    Name() string
    Search(ctx, query, count) ([]Result, error)
}
```

## 核心实现细节

### 1. 提供商选择（`DefaultProvider()`）

优先级：Tavily > Brave > Bing（免密钥）
```go
func DefaultProvider() Provider {
    if tavilyKey != "" { return &TavilyProvider{APIKey: tavilyKey} }
    if braveKey != "" { return &BraveProvider{APIKey: braveKey} }
    return &BingProvider{}
}
```

### 2. MCP stdio 服务器（`RunMCP()`）

- 读取 newline-delimited 或 Content-Length framed JSON-RPC
- 响应 `initialize` / `tools/list` / `tools/call`
- 实现 `web_search` 工具（2025-06-18 协议版本）

**`handle()`** — 方法分发：
```go
case "initialize":  → 返回协议版本、capabilities、serverInfo
case "ping":        → 返回空 result
case "tools/list":  → 返回 web_search 工具定义
case "tools/call":  → 执行搜索
```

### 3. 处理流水线（`PostProcess()`）

**步骤 1：过滤**
- 硬过滤：域名黑名单（必删）
- 软过滤：关键词（日历/字典/黄历等，结果充足时才删）
- 结果不足时回退：先用软过滤，再不行用硬过滤

**步骤 2：去重**
- 按归一化域名 + 标题去重

**步骤 3：时效排序**
- 有近期日期的排前（`dateWeight`）

**步骤 4：抓正文**
- 最多取前 count 个
- 带 12s 超时保护
- Tavily 已带正文则跳过

**步骤 5：相关性重排**
- query 词频 + 时效加权（`relevanceScore`）

### 4. 低质量过滤（`postprocess.go`）

**`lowQualityDomainSuffixes`** — 域名黑名单：
- 日历/字典/百科/天气等（`baike.baidu.com`、`huangli`、`tianqi.com` 等）

**`lowQualityKeywords`** — 关键词黑名单：
- 农历/黄历/成语/词典/天气预报等（中文）

**`lowQualityURLPatterns`** — URL 模式黑名单：
- 搜索结果页/登录页等（`bing.com/search`、`login`、`signin` 等）

## 设计亮点

- **多提供商**：自动选择最佳提供商
- **完整流水线**：过滤→去重→时效→内容→重排
- **质量优先**：内置低质量内容过滤
- **MCP 兼容**：可作为独立 MCP 工具

## 相关调用方

- `cmd/server/main.go`：`/api/agent/chat`
- agent 工具：网页搜索
