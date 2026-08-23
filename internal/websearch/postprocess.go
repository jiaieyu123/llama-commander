package websearch

import (
	"context"
	"net/url"
	"regexp"
	"sort"
	"strings"
	"time"
)

// ---- 方案 A：低质过滤 + 去重 + 时效 ----

// lowQualityDomainSuffixes are domains that almost never contain timely news
// (calendars, dictionaries, encyclopedias, weather, etc.).
var lowQualityDomainSuffixes = []string{
	".rili.com.cn", "rili.", "huangli", "wannianli", "tthuangli",
	"baike.baidu.com", "dict.", "zidian", "hanyuguoxue", "hgcha.com",
	"chagushici", "gushici.net", "time.org.cn", "calendar-365",
	"chinacalendar", "zzhuangli", "talllkai", "thefreedictionary",
	"zhidao.baidu.com", "baijiahao", // 百家号质量参差，可保留注释掉
	"en.wikipedia.org", "baike.sogou.com",
	"tianqi.com", "time163.com", "histoday", "huangli.", "jintian",
	"lishi.yyxw.com", "moshuyuan.com", "shidianguji.com",
}

// lowQualityKeywords appear in titles of low-value pages (calendars, dictionaries).
var lowQualityKeywords = []string{
	"农历", "黄历", "老黄历", "宜忌", "万年历", "日历", "今日黄历",
	"笔画", "拼音", "组词", "部首", "成语", "词典", "新华字典",
	"康熙字典", "节气", "农历几月", "吉凶", "历史上的今天", "天气预报",
	"历史事件查询", "今天是什么日子", "吉凶宜忌", "时辰", "老历",
}

// lowQualityURLPatterns match junk URLs (search result pages, logins, etc.).
var lowQualityURLPatterns = []string{
	"bing.com/search", "baidu.com/s?", "google.com/search",
	"&amp;", "javascript:", "#", "login", "signin", "account/login",
}

var reYear = regexp.MustCompile(`(20\d{2})[-/年]?(\d{1,2})?[-/月]?(\d{1,2})?`)

// PostProcess runs the full quality pipeline:
// filter → dedupe → freshness sort → content fetch → relevance rerank.
func PostProcess(ctx context.Context, results []Result, query string, count int) []Result {
	if count <= 0 {
		count = 6
	}
	// 1) 硬过滤（域名黑名单，必删）+ 软过滤（关键词，结果充足时才删）
	hard := make([]Result, 0, len(results))
	soft := make([]Result, 0, len(results))
	for _, r := range results {
		if isHardLowQuality(r) {
			continue
		}
		hard = append(hard, r)
		if isSoftLowQuality(r) {
			continue
		}
		soft = append(soft, r)
	}
	// 结果不足时回退：先用软过滤结果，再不行用硬过滤结果
	filtered := soft
	if len(filtered) < min(count, 4) {
		filtered = hard
	}
	// 2) 去重（按归一化域名+标题）
	seen := map[string]bool{}
	dedup := make([]Result, 0, len(filtered))
	for _, r := range filtered {
		key := dedupKey(r)
		if seen[key] {
			continue
		}
		seen[key] = true
		dedup = append(dedup, r)
	}
	// 3) 时效排序（有近期日期的排前）
	sort.SliceStable(dedup, func(i, j int) bool {
		return dateWeight(dedup[i].Date) > dateWeight(dedup[j].Date)
	})
	// 4) 抓正文（最多取前 count 个，带超时保护）
	for i := range dedup {
		if i >= count {
			break
		}
		if dedup[i].Content != "" {
			continue // 提供者已带正文（Tavily）
		}
		ctx2, cancel := context.WithTimeout(ctx, 12*time.Second)
		content := fetchContent(ctx2, dedup[i].URL, 800)
		cancel()
		dedup[i].Content = content
	}
	// 5) 相关性重排（方案 D：query 词频 + 时效加权）
	sort.SliceStable(dedup, func(i, j int) bool {
		si := relevanceScore(query, dedup[i])
		sj := relevanceScore(query, dedup[j])
		dedup[i].Score = si
		dedup[j].Score = sj
		return si > sj
	})
	if len(dedup) > count {
		dedup = dedup[:count]
	}
	return dedup
}

func min(a, b int) int {
	if a < b {
		return a
	}
	return b
}

// isLowQuality is kept for tests: soft filter only (keyword based).
func isLowQuality(r Result) bool {
	return isHardLowQuality(r) || isSoftLowQuality(r)
}

// isHardLowQuality: junk by domain (calendars/dictionaries/encyclopedias).
func isHardLowQuality(r Result) bool {
	host := ""
	if u, err := url.Parse(r.URL); err == nil {
		host = strings.ToLower(u.Hostname())
	}
	for _, suf := range lowQualityDomainSuffixes {
		if strings.Contains(host, suf) {
			return true
		}
	}
	for _, pat := range lowQualityURLPatterns {
		if strings.Contains(r.URL, pat) {
			return true
		}
	}
	return false
}

// isSoftLowQuality: junk by title keyword (only dropped when enough results).
func isSoftLowQuality(r Result) bool {
	title := strings.ToLower(r.Title)
	for _, kw := range lowQualityKeywords {
		if strings.Contains(title, kw) {
			return true
		}
	}
	return false
}

// dedupKey normalizes a result to a stable key (host + first 20 title runes).
func dedupKey(r Result) string {
	host := ""
	if u, err := url.Parse(r.URL); err == nil {
		host = strings.TrimPrefix(strings.ToLower(u.Hostname()), "www.")
	}
	runes := []rune(strings.TrimSpace(r.Title))
	if len(runes) > 20 {
		runes = runes[:20]
	}
	return host + "|" + string(runes)
}

// dateWeight returns a score for how "fresh" a date is (YYYY-MM-DD or empty).
func dateWeight(date string) int {
	if date == "" {
		return 0
	}
	now := time.Now()
	// 解析 YYYY-MM-DD / YYYY/MM/DD
	var y, m, d int
	if _, err := fmtSscanf(date, &y, &m, &d); err != nil {
		return 1
	}
	dateTime := time.Date(y, time.Month(m), d, 0, 0, 0, 0, time.Local)
	days := int(now.Sub(dateTime).Hours() / 24)
	switch {
	case days < 0:
		return 100 // 未来（推测）
	case days <= 1:
		return 50
	case days <= 7:
		return 40
	case days <= 30:
		return 30
	case days <= 90:
		return 20
	default:
		return 5
	}
}

func fmtSscanf(date string, y, m, d *int) (int, error) {
	date = strings.ReplaceAll(date, "/", "-")
	parts := strings.SplitN(date, "-", 3)
	if len(parts) != 3 {
		return 0, fmtErrorf("bad date")
	}
	if _, err := fmtSscanInt(parts[0], y); err != nil {
		return 0, err
	}
	if _, err := fmtSscanInt(parts[1], m); err != nil {
		return 0, err
	}
	if _, err := fmtSscanInt(parts[2], d); err != nil {
		return 0, err
	}
	return 3, nil
}

// ---- 方案 D：相关性重排 ----

// relevanceScore ranks a result against the query using token overlap on
// title/snippet/content plus a freshness bonus.
func relevanceScore(query string, r Result) float64 {
	score := 0.0
	terms := tokenize(query)
	title := strings.ToLower(r.Title)
	snippet := strings.ToLower(r.Snippet)
	content := strings.ToLower(r.Content)
	text := title + " " + snippet + " " + content
	for _, t := range terms {
		if strings.Contains(title, t) {
			score += 3.0
		}
		if strings.Contains(snippet, t) {
			score += 1.5
		}
		if strings.Contains(content, t) {
			score += 1.0
		}
		// 词频加成
		score += float64(strings.Count(text, t)) * 0.2
	}
	// 时效加成
	score += float64(dateWeight(r.Date)) / 10.0
	// 提供者初始分（Tavily 自带相关分）
	score += r.Score
	return score
}

// tokenize splits a query into lowercase tokens: CJK bigrams + latin words.
func tokenize(query string) []string {
	query = strings.ToLower(query)
	var tokens []string
	runes := []rune(query)
	// 中文：取连续 CJK 串的双字组合
	var cjk []rune
	flushCJK := func() {
		if len(cjk) < 2 {
			cjk = nil
			return
		}
		// 双字滑窗
		for i := 0; i+1 < len(cjk); i++ {
			tokens = append(tokens, string(cjk[i:i+2]))
		}
		// 整串也加入
		tokens = append(tokens, string(cjk))
		cjk = nil
	}
	for _, r := range runes {
		if isCJK(r) {
			cjk = append(cjk, r)
		} else {
			flushCJK()
		}
	}
	flushCJK()
	// 拉丁词
	for _, w := range strings.FieldsFunc(query, func(r rune) bool {
		return !(r >= 'a' && r <= 'z') && !(r >= '0' && r <= '9')
	}) {
		if len(w) >= 2 {
			tokens = append(tokens, w)
		}
	}
	return tokens
}

func isCJK(r rune) bool {
	return (r >= 0x4E00 && r <= 0x9FFF) || (r >= 0x3400 && r <= 0x4DBF)
}

// ---- 小工具 ----

func fmtErrorf(s string) error {
	return &strError{s}
}

type strError struct{ s string }

func (e *strError) Error() string { return e.s }

func fmtSscanInt(s string, out *int) (int, error) {
	s = strings.TrimSpace(s)
	if s == "" {
		return 0, fmtErrorf("empty")
	}
	n := 0
	for _, r := range s {
		if r < '0' || r > '9' {
			return 0, fmtErrorf("not int")
		}
		n = n*10 + int(r-'0')
	}
	*out = n
	return n, nil
}
