package websearch

import (
	"context"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"regexp"
	"strings"
	"time"

	"golang.org/x/net/html"
)

var (
	reAlgo  = regexp.MustCompile(`<li class="b_algo"`)
	reH2    = regexp.MustCompile(`(?s)<h2[^>]*>\s*<a[^>]*href="([^"]+)"[^>]*>(.*?)</a>`)
	reP     = regexp.MustCompile(`(?s)<p[^>]*>(.*?)</p>`)
	reTag   = regexp.MustCompile(`<[^>]+>`)
	reSpace = regexp.MustCompile(`\s+`)
)

const defaultUA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36"

// BingProvider scrapes Bing HTML (key-free, works in CN networks).
type BingProvider struct{}

func (p *BingProvider) Name() string { return "Bing" }

func (p *BingProvider) Search(ctx context.Context, query string, count int) ([]Result, error) {
	if count <= 0 || count > 40 {
		count = 12
	}
	u := "https://www.bing.com/search?q=" + url.QueryEscape(query) + "&count=" + itoa(count) + "&mkt=zh-CN"
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

func parseResults(htmlStr string, count int) []Result {
	starts := reAlgo.FindAllStringIndex(htmlStr, -1)
	out := make([]Result, 0, len(starts))
	for i, m := range starts {
		if len(out) >= count {
			break
		}
		end := len(htmlStr)
		if i+1 < len(starts) {
			end = starts[i+1][0]
		} else if idx := strings.Index(htmlStr[m[1]:], "</ol>"); idx >= 0 {
			end = m[1] + idx
		}
		block := htmlStr[m[1]:end]
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

// ---- 正文抓取与抽取（方案 B）----

// fetchContent downloads a page and extracts a clean readable text excerpt.
// It only follows http(s); non-http or failures return "".
func fetchContent(ctx context.Context, rawURL string, maxLen int) string {
	if !strings.HasPrefix(rawURL, "http://") && !strings.HasPrefix(rawURL, "https://") {
		return ""
	}
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, rawURL, nil)
	if err != nil {
		return ""
	}
	req.Header.Set("User-Agent", defaultUA)
	req.Header.Set("Accept-Language", "zh-CN,zh;q=0.9,en;q=0.8")
	client := &http.Client{Timeout: 10 * time.Second}
	resp, err := client.Do(req)
	if err != nil {
		return ""
	}
	defer resp.Body.Close()
	// 限制读取量：正文一般在前 1MB
	body, err := io.ReadAll(io.LimitReader(resp.Body, 1<<20))
	if err != nil {
		return ""
	}
	return extractReadable(string(body), maxLen)
}

// extractReadable does a lightweight readability-style extraction: walk the
// DOM, prefer <article>/<main>, and collect text from <p> blocks, then trim
// to maxLen runes. Returns "" if nothing meaningful is found.
func extractReadable(doc string, maxLen int) string {
	root, err := html.Parse(strings.NewReader(doc))
	if err != nil {
		return ""
	}
	text := walkText(root)
	if text == "" {
		return ""
	}
	// 噪音检测：若正文几乎全是数字/符号/短行（如天气预报表格、日期列表），丢弃
	runes := []rune(text)
	digit := 0
	for _, r := range runes {
		if (r >= '0' && r <= '9') || r == '℃' || r == '°' {
			digit++
		}
	}
	if len(runes) > 0 && float64(digit)/float64(len(runes)) > 0.35 {
		return ""
	}
	if len(runes) > maxLen {
		return string(runes[:maxLen])
	}
	return text
}

// walkText collects <p> text (and heading text) inside a node. It returns ""
// if the block looks like navigation/chrome (too few paragraphs, or very
// short lines) rather than article prose.
func walkText(n *html.Node) string {
	var sb strings.Builder
	paras := 0
	totalLen := 0
	var walk func(n *html.Node)
	walk = func(n *html.Node) {
		if n.Type == html.ElementNode {
			switch strings.ToLower(n.Data) {
			case "script", "style", "noscript", "nav", "header", "footer", "aside", "iframe", "form", "button", "svg", "figure":
				return
			case "p", "h1", "h2", "h3", "h4", "blockquote", "li":
				text := nodeText(n)
				if text != "" {
					sb.WriteString(text)
					sb.WriteString("\n")
					paras++
					totalLen += len([]rune(text))
				}
				return
			}
		}
		for c := n.FirstChild; c != nil; c = c.NextSibling {
			walk(c)
		}
	}
	walk(n)
	out := clean(sb.String())
	// 段落太少或总长太短 → 判定为导航/骨架，非正文
	if paras < 2 || totalLen < 60 {
		return ""
	}
	return out
}

// nodeText extracts the text content of a node (excluding child blocks).
func nodeText(n *html.Node) string {
	var sb strings.Builder
	var walk func(n *html.Node)
	walk = func(n *html.Node) {
		if n.Type == html.TextNode {
			sb.WriteString(n.Data)
			return
		}
		if n.Type == html.ElementNode {
			switch strings.ToLower(n.Data) {
			case "script", "style", "noscript", "nav", "header", "footer", "aside", "iframe", "svg", "figure":
				return
			}
		}
		for c := n.FirstChild; c != nil; c = c.NextSibling {
			walk(c)
		}
	}
	walk(n)
	return clean(sb.String())
}
