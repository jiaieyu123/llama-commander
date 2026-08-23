// Package websearch provides a built-in web search engine for the agent
// tool. It supports multiple providers:
//
//   - Bing HTML scraping (default, key-free, works in CN networks)
//   - Brave Search API (if BRAVE_API_KEY is set)
//   - Tavily API (if TAVILY_API_KEY is set)
//
// The pipeline is: provider search → low-quality filtering → dedupe →
// freshness sort → content fetch (readability) → relevance re-rank.
//
// Run as a standalone MCP stdio server:
//
//	llama-launcher websearch-mcp
//
// then register it in the MCP config with command=<path to llama-launcher.exe>
// and args=["websearch-mcp"].
package websearch

import (
	"bufio"
	"context"
	"encoding/json"
	"fmt"
	"io"
	"os"
	"strings"
	"time"
)

// Result is one search hit after the full pipeline.
type Result struct {
	Title   string  `json:"title"`
	URL     string  `json:"url"`
	Snippet string  `json:"snippet"`
	Content string  `json:"content,omitempty"` // 抓取并抽取的正文章段（可能为空）
	Date    string  `json:"date,omitempty"`    // 推断的发布日期（YYYY-MM-DD 或空）
	Score   float64 `json:"-"`                 // 重排分数（内部用）
}

// Provider is a search backend.
type Provider interface {
	Name() string
	Search(ctx context.Context, query string, count int) ([]Result, error)
}

// Search performs a web search through the best available provider and runs
// the full pipeline (filter → dedupe → freshness → content → rerank).
func Search(ctx context.Context, query string, count int) ([]Result, error) {
	if count <= 0 || count > 20 {
		count = 6
	}
	p := DefaultProvider()
	results, err := p.Search(ctx, query, count*2) // 多召回一些供过滤
	if err != nil {
		return nil, err
	}
	results = PostProcess(ctx, results, query, count)
	return results, nil
}

// package-level API keys (set from the launcher config at startup).
var (
	cfgBraveKey  string
	cfgTavilyKey string
)

// SetAPIKeys configures API keys programmatically (higher precedence than env).
func SetAPIKeys(brave, tavily string) {
	cfgBraveKey = strings.TrimSpace(brave)
	cfgTavilyKey = strings.TrimSpace(tavily)
}

// APIKeyConfigured reports whether an API-backed provider is configured.
func APIKeyConfigured() bool {
	return cfgTavilyKey != "" || cfgBraveKey != "" ||
		strings.TrimSpace(os.Getenv("TAVILY_API_KEY")) != "" ||
		strings.TrimSpace(os.Getenv("BRAVE_API_KEY")) != ""
}

// DefaultProvider picks the best provider based on available API keys.
// Precedence: Tavily > Brave > Bing (key-free).
func DefaultProvider() Provider {
	if k := cfgTavilyKey; k != "" {
		return &TavilyProvider{APIKey: k}
	}
	if v := os.Getenv("TAVILY_API_KEY"); strings.TrimSpace(v) != "" {
		return &TavilyProvider{APIKey: strings.TrimSpace(v)}
	}
	if k := cfgBraveKey; k != "" {
		return &BraveProvider{APIKey: k}
	}
	if v := os.Getenv("BRAVE_API_KEY"); strings.TrimSpace(v) != "" {
		return &BraveProvider{APIKey: strings.TrimSpace(v)}
	}
	return &BingProvider{}
}

// ---- MCP stdio server (newline-delimited JSON, 2025-06-18 spec) ----

// RunMCP starts the MCP stdio server. It reads newline-delimited or
// Content-Length framed JSON-RPC from stdin and answers initialize /
// tools/list / tools/call for the built-in `web_search` tool.
func RunMCP() error {
	br := bufio.NewReader(os.Stdin)
	for {
		msg, err := readMessage(br)
		if err != nil {
			if err == io.EOF {
				return nil
			}
			// 非致命：继续读
			continue
		}
		if msg["id"] == nil {
			continue // notification
		}
		resp := handle(msg)
		resp["jsonrpc"] = "2.0"
		resp["id"] = msg["id"]
		if err := writeMessage(os.Stdout, resp); err != nil {
			return err
		}
	}
}

func handle(msg map[string]any) map[string]any {
	method, _ := msg["method"].(string)
	switch method {
	case "initialize":
		return map[string]any{"result": map[string]any{
			"protocolVersion": "2025-06-18",
			"capabilities":    map[string]any{"tools": map[string]any{"listChanged": false}},
			"serverInfo":      map[string]any{"name": "llama-launcher-websearch", "version": "1.1.0"},
		}}
	case "ping":
		return map[string]any{"result": map[string]any{}}
	case "tools/list":
		return map[string]any{"result": map[string]any{"tools": []map[string]any{
			{
				"name":        "web_search",
				"description": "联网搜索（默认 Bing 免 Key；若配置了 BRAVE_API_KEY/TAVILY_API_KEY 则用对应 API）。返回网页标题、链接、摘要与正文片段，并按时效与相关性排序，用于获取最新信息。",
				"inputSchema": map[string]any{
					"type": "object",
					"properties": map[string]any{
						"query": map[string]any{"type": "string", "description": "搜索关键词"},
						"count": map[string]any{"type": "number", "description": "返回结果数（默认 6，最多 20）"},
					},
					"required": []string{"query"},
				},
			},
		}}}
	case "tools/call":
		return callTool(msg)
	default:
		return map[string]any{"error": map[string]any{"code": -32601, "message": "unknown method: " + method}}
	}
}

func callTool(msg map[string]any) map[string]any {
	params, _ := msg["params"].(map[string]any)
	args, _ := params["arguments"].(map[string]any)
	query, _ := args["query"].(string)
	query = strings.TrimSpace(query)
	if query == "" {
		return toolError("缺少搜索关键词 query")
	}
	count := 6
	if c, ok := args["count"].(float64); ok && c > 0 {
		count = int(c)
	}
	ctx, cancel := context.WithTimeout(context.Background(), 30*time.Second)
	defer cancel()
	results, err := Search(ctx, query, count)
	if err != nil {
		return toolError("搜索失败: " + err.Error())
	}
	if len(results) == 0 {
		return toolError("没有搜到结果，换个关键词试试")
	}
	var b strings.Builder
	provider := DefaultProvider().Name()
	fmt.Fprintf(&b, "「%s」的搜索结果（%d 条，来源 %s）：\n\n", query, len(results), provider)
	for i, r := range results {
		fmt.Fprintf(&b, "%d. %s\n   %s\n", i+1, r.Title, r.URL)
		if r.Date != "" {
			fmt.Fprintf(&b, "   日期: %s\n", r.Date)
		}
		if r.Snippet != "" {
			fmt.Fprintf(&b, "   摘要: %s\n", r.Snippet)
		}
		if r.Content != "" {
			fmt.Fprintf(&b, "   正文: %s\n", truncate(r.Content, 500))
		}
		fmt.Fprintln(&b)
	}
	return map[string]any{"result": map[string]any{"content": []map[string]any{
		{"type": "text", "text": b.String()},
	}}}
}

func toolError(msg string) map[string]any {
	return map[string]any{"result": map[string]any{"content": []map[string]any{
		{"type": "text", "text": msg},
	}, "isError": true}}
}

func truncate(s string, n int) string {
	r := []rune(s)
	if len(r) <= n {
		return s
	}
	return string(r[:n]) + "…"
}

// readMessage reads one JSON-RPC message, auto-detecting newline-delimited
// JSON (first byte '{') vs Content-Length framing (LSP style).
func readMessage(br *bufio.Reader) (map[string]any, error) {
	first, err := br.Peek(1)
	if err != nil {
		return nil, err
	}
	if first[0] == '{' {
		line, err := br.ReadString('\n')
		if err != nil {
			return nil, err
		}
		var msg map[string]any
		if err := json.Unmarshal([]byte(strings.TrimSpace(line)), &msg); err != nil {
			return nil, err
		}
		return msg, nil
	}
	// Content-Length framing
	length := -1
	for {
		line, err := br.ReadString('\n')
		if err != nil {
			return nil, err
		}
		line = strings.TrimSpace(line)
		if line == "" {
			break
		}
		if strings.HasPrefix(strings.ToLower(line), "content-length:") {
			fmt.Sscanf(strings.TrimSpace(line[len("content-length:"):]), "%d", &length)
		}
	}
	if length < 0 {
		return nil, fmt.Errorf("missing Content-Length")
	}
	body := make([]byte, length)
	if _, err := io.ReadFull(br, body); err != nil {
		return nil, err
	}
	var msg map[string]any
	if err := json.Unmarshal(body, &msg); err != nil {
		return nil, err
	}
	return msg, nil
}

func writeMessage(w io.Writer, msg map[string]any) error {
	body, err := json.Marshal(msg)
	if err != nil {
		return err
	}
	_, err = w.Write(append(body, '\n'))
	return err
}
