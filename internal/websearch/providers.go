package websearch

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"strings"
	"time"
)

// ---- Brave Search API (https://brave.com/search/api/) ----

// BraveProvider uses the Brave Web Search API. Requires BRAVE_API_KEY env.
type BraveProvider struct {
	APIKey string
}

func (p *BraveProvider) Name() string { return "Brave API" }

func (p *BraveProvider) Search(ctx context.Context, query string, count int) ([]Result, error) {
	if count <= 0 || count > 20 {
		count = 6
	}
	u := fmt.Sprintf("https://api.search.brave.com/res/v1/web/search?q=%s&count=%d&search_lang=zh-hans&country=cn&freshness=no", url.QueryEscape(query), count)
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, u, nil)
	if err != nil {
		return nil, err
	}
	req.Header.Set("Accept", "application/json")
	req.Header.Set("X-Subscription-Token", p.APIKey)
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
	if resp.StatusCode != 200 {
		return nil, fmt.Errorf("Brave API %d: %s", resp.StatusCode, truncate(string(body), 200))
	}
	var data struct {
		Web struct {
			Results []struct {
				Title       string `json:"title"`
				URL         string `json:"url"`
				Description string `json:"description"`
				Age         string `json:"age"` // 如 "1h" / "2026-08-22"
			} `json:"results"`
		} `json:"web"`
	}
	if err := json.Unmarshal(body, &data); err != nil {
		return nil, err
	}
	out := make([]Result, 0, len(data.Web.Results))
	for _, r := range data.Web.Results {
		if r.URL == "" {
			continue
		}
		out = append(out, Result{Title: r.Title, URL: r.URL, Snippet: r.Description, Date: normalizeDate(r.Age)})
	}
	return out, nil
}

// ---- Tavily API (https://tavily.com/) ----

// TavilyProvider uses the Tavily Search API (returns content directly).
// Requires TAVILY_API_KEY env.
type TavilyProvider struct {
	APIKey string
}

func (p *TavilyProvider) Name() string { return "Tavily API" }

func (p *TavilyProvider) Search(ctx context.Context, query string, count int) ([]Result, error) {
	if count <= 0 || count > 20 {
		count = 6
	}
	payload, _ := json.Marshal(map[string]any{
		"api_key":        p.APIKey,
		"query":          query,
		"max_results":    count,
		"search_depth":   "basic",
		"include_answer": false,
	})
	req, err := http.NewRequestWithContext(ctx, http.MethodPost,
		"https://api.tavily.com/search", bytes.NewReader(payload))
	if err != nil {
		return nil, err
	}
	req.Header.Set("Content-Type", "application/json")
	client := &http.Client{Timeout: 20 * time.Second}
	resp, err := client.Do(req)
	if err != nil {
		return nil, err
	}
	defer resp.Body.Close()
	body, err := io.ReadAll(io.LimitReader(resp.Body, 4<<20))
	if err != nil {
		return nil, err
	}
	if resp.StatusCode != 200 {
		return nil, fmt.Errorf("Tavily API %d: %s", resp.StatusCode, truncate(string(body), 200))
	}
	var data struct {
		Results []struct {
			Title         string  `json:"title"`
			URL           string  `json:"url"`
			Content       string  `json:"content"`
			PublishedDate string  `json:"published_date"`
			Score         float64 `json:"score"`
		} `json:"results"`
	}
	if err := json.Unmarshal(body, &data); err != nil {
		return nil, err
	}
	out := make([]Result, 0, len(data.Results))
	for _, r := range data.Results {
		if r.URL == "" {
			continue
		}
		snippet := r.Content
		if len([]rune(snippet)) > 300 {
			snippet = truncate(snippet, 300)
		}
		out = append(out, Result{
			Title: r.Title, URL: r.URL, Snippet: snippet,
			Content: r.Content, Date: normalizeDate(r.PublishedDate),
			Score: r.Score,
		})
	}
	return out, nil
}

func urlQueryEscapePlaceholder() {}

// normalizeDate converts various date strings to YYYY-MM-DD (or keeps).
func normalizeDate(s string) string {
	s = strings.TrimSpace(s)
	if s == "" {
		return ""
	}
	// 已含 "2026-08-23" 或 "2026/08/23"
	if len(s) >= 10 {
		c := s[:10]
		if (c[4] == '-' || c[4] == '/') && (c[7] == '-' || c[7] == '/') {
			return strings.ReplaceAll(c, "/", "-")
		}
	}
	// "1h" / "2d" / "3w" 相对时间 -> 无具体日期，返回空
	if len(s) <= 3 && (strings.HasSuffix(s, "h") || strings.HasSuffix(s, "d") || strings.HasSuffix(s, "w")) {
		return ""
	}
	return s
}
