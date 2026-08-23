// Package websearch provides a built-in, key-free web search MCP server
// (backed by Bing, which is reachable directly in CN networks). It lets a
// model call a `web_search` tool without needing Brave/Tavily API keys.
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
	"net/http"
	"net/url"
	"os"
	"regexp"
	"strings"
	"time"
)

// Result is one search hit.
type Result struct {
	Title   string `json:"title"`
	URL     string `json:"url"`
	Snippet string `json:"snippet"`
}

var (
	reAlgo  = regexp.MustCompile(`<li class="b_algo"`)
	reH2    = regexp.MustCompile(`(?s)<h2[^>]*>\s*<a[^>]*href="([^"]+)"[^>]*>(.*?)</a>`)
	reP     = regexp.MustCompile(`(?s)<p[^>]*>(.*?)</p>`)
	reTag   = regexp.MustCompile(`<[^>]+>`)
	reSpace = regexp.MustCompile(`\s+`)
)

const defaultUA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36"

// Search performs a Bing web search (no API key required) and returns up to
// `count` results with title/url/snippet.
func Search(ctx context.Context, query string, count int) ([]Result, error) {
	if count <= 0 || count > 20 {
		count = 6
	}
	u := "https://www.bing.com/search?q=" + url.QueryEscape(query) + "&count=" + itoa(count)
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, u, nil)
	if err != nil {
		return nil, err
	}
	req.Header.Set("User-Agent", defaultUA)
	req.Header.Set("Accept-Language", "zh-CN,zh;q=0.9,en;q=0.8")
	client := &http.Client{Timeout: 15 * time.Second}
	resp, err := client.Do(req)
	if err != nil {
		return nil, err
	}
	defer resp.Body.Close()
	body, err := io.ReadAll(io.LimitReader(resp.Body, 2<<20))
	if err != nil {
		return nil, err
	}
	return parseResults(string(body), count), nil
}

func parseResults(html string, count int) []Result {
	starts := reAlgo.FindAllStringIndex(html, -1)
	out := make([]Result, 0, len(starts))
	for i, m := range starts {
		if len(out) >= count {
			break
		}
		end := len(html)
		if i+1 < len(starts) {
			end = starts[i+1][0]
		} else if idx := strings.Index(html[m[1]:], "</ol>"); idx >= 0 {
			end = m[1] + idx
		}
		block := html[m[1]:end]
		hm := reH2.FindStringSubmatch(block)
		if hm == nil {
			continue
		}
		href := hm[1]
		if !strings.HasPrefix(href, "http") {
			continue
		}
		title := clean(hm[2])
		if title == "" {
			continue
		}
		snippet := ""
		if pm := reP.FindStringSubmatch(block); pm != nil {
			snippet = clean(pm[1])
		}
		out = append(out, Result{Title: title, URL: href, Snippet: snippet})
	}
	return out
}

func clean(s string) string {
	s = reTag.ReplaceAllString(s, "")
	s = reSpace.ReplaceAllString(s, " ")
	return strings.TrimSpace(s)
}

func itoa(n int) string {
	return fmt.Sprintf("%d", n)
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
			"serverInfo":      map[string]any{"name": "llama-launcher-websearch", "version": "1.0.0"},
		}}
	case "ping":
		return map[string]any{"result": map[string]any{}}
	case "tools/list":
		return map[string]any{"result": map[string]any{"tools": []map[string]any{
			{
				"name":        "web_search",
				"description": "免费的联网搜索（Bing，无需 API Key）。实时返回网页标题、链接和摘要，用于获取最新信息。",
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
	ctx, cancel := context.WithTimeout(context.Background(), 20*time.Second)
	defer cancel()
	results, err := Search(ctx, query, count)
	if err != nil {
		return toolError("搜索失败: " + err.Error())
	}
	if len(results) == 0 {
		return toolError("没有搜到结果，换个关键词试试")
	}
	var b strings.Builder
	fmt.Fprintf(&b, "「%s」的搜索结果（%d 条）：\n\n", query, len(results))
	for i, r := range results {
		fmt.Fprintf(&b, "%d. %s\n   %s\n   %s\n\n", i+1, r.Title, r.URL, r.Snippet)
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
