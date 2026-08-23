package websearch

import (
	"context"
	"strings"
	"testing"
)

func TestIsLowQualityFiltersCalendarAndDict(t *testing.T) {
	cases := []struct {
		name string
		r    Result
		want bool
	}{
		{"日历网", Result{Title: "日历网提供农历查询", URL: "https://www.rili.com.cn/"}, true},
		{"黄历", Result{Title: "今日黄历宜忌查询", URL: "https://m.tthuangli.com/jinrihuangli/"}, true},
		{"百度百科", Result{Title: "今天（1995年歌曲）_百度百科", URL: "https://baike.baidu.com/item/x"}, true},
		{"字典", Result{Title: "热的拼音_新华字典", URL: "https://zidian.gushici.net/x"}, true},
		{"正常新闻", Result{Title: "恒大集团案件一审宣判", URL: "https://news.cctv.com/x"}, false},
		{"政府网", Result{Title: "国务院办公厅关于2026年部分节假日安排的通知", URL: "https://www.gov.cn/x"}, false},
	}
	for _, c := range cases {
		if got := isLowQuality(c.r); got != c.want {
			t.Errorf("%s: isLowQuality=%v want %v", c.name, got, c.want)
		}
	}
}

func TestDedupKey(t *testing.T) {
	a := dedupKey(Result{Title: "泡泡玛特上半年营收171.7亿元", URL: "https://www.36kr.com/p/1"})
	b := dedupKey(Result{Title: "泡泡玛特上半年营收171.7亿元", URL: "https://www.36kr.com/p/2"})
	if a != b {
		t.Errorf("same title+host should dedupe: %q vs %q", a, b)
	}
}

func TestTokenizeChineseBigrams(t *testing.T) {
	toks := tokenize("今天热点新闻")
	joined := strings.Join(toks, ",")
	for _, want := range []string{"今天", "天热", "热点", "点新", "新闻"} {
		if !strings.Contains(joined, want) {
			t.Errorf("tokenize missing %q, got %q", want, joined)
		}
	}
}

func TestRelevanceScorePrefersTitleMatch(t *testing.T) {
	q := "恒大许家印案宣判"
	good := Result{Title: "恒大集团许家印案一审宣判", URL: "https://news.cctv.com/1", Snippet: "法院认定罪名多项", Date: "2026-08-20"}
	bad := Result{Title: "2026年日历表", URL: "https://x.com/2", Snippet: "农历节气放假安排"}
	if isLowQuality(bad) {
		t.Skip("bad result filtered earlier")
	}
	if relevanceScore(q, good) <= relevanceScore(q, bad) {
		t.Errorf("title-matching news should score higher: good=%v bad=%v",
			relevanceScore(q, good), relevanceScore(q, bad))
	}
}

func TestDateWeightFresh(t *testing.T) {
	if dateWeight("2026-08-22") <= dateWeight("2020-01-01") {
		t.Errorf("fresh date should outweigh old date")
	}
	if dateWeight("") != 0 {
		t.Errorf("empty date should be 0")
	}
}

func TestNormalizeDate(t *testing.T) {
	if got := normalizeDate("2026/08/23"); got != "2026-08-23" {
		t.Errorf("slash date: got %q", got)
	}
	if got := normalizeDate("2026-08-23"); got != "2026-08-23" {
		t.Errorf("dash date: got %q", got)
	}
	if got := normalizeDate("1h"); got != "" {
		t.Errorf("relative date should be empty, got %q", got)
	}
}

func TestPostProcessFiltersAndDedupes(t *testing.T) {
	results := []Result{
		{Title: "今日黄历宜忌查询", URL: "https://m.tthuangli.com/jinrihuangli/", Snippet: "黄历"},
		{Title: "恒大集团许家印案一审宣判", URL: "https://news.cctv.com/1", Snippet: "法院认定", Date: "2026-08-20"},
		{Title: "恒大集团许家印案一审宣判", URL: "https://news.cctv.com/2", Snippet: "重复"}, // 同 host+标题去重
		{Title: "2026世界杯赛程公布", URL: "https://worldcup.cctv.com/2026/schedule/index.shtml", Snippet: "小组赛赛程", Date: "2026-08-01"},
	}
	out := PostProcess(context.Background(), results, "恒大许家印案宣判", 6)
	if len(out) != 2 {
		t.Fatalf("expected 2 results after filter+dedupe, got %d: %+v", len(out), out)
	}
	// 时效+相关性：恒大（近日期且标题强匹配）应在最前
	if !strings.Contains(out[0].Title, "恒大") {
		t.Errorf("fresh & relevant result should rank first, got: %+v", out[0])
	}
}

func TestExtractReadable(t *testing.T) {
	doc := `<html><body><nav>菜单导航链接</nav><article><h1>标题</h1><p>第一段正文内容，这里有足够的文字来描述一个完整的新闻报道主体段落内容，超过六十字。今天上午，有关部门发布了最新的经济数据，引发市场关注。</p><p>第二段正文内容继续展开，分析人士认为这一数据将对未来几个季度的走势产生深远影响，各方正在密切关注后续进展。</p></article><footer>版权信息</footer></body></html>`
	got := extractReadable(doc, 200)
	if !strings.Contains(got, "第一段正文内容") {
		t.Errorf("readable should extract article text, got %q", got)
	}
	if strings.Contains(got, "菜单") {
		t.Errorf("nav text should be excluded, got %q", got)
	}
}

func TestExtractReadableRejectsNavOnly(t *testing.T) {
	doc := `<html><body><nav><a>首页</a><a>新闻</a><a>体育</a><a>娱乐</a></nav><div>loading...</div></body></html>`
	if got := extractReadable(doc, 200); got != "" {
		t.Errorf("nav-only page should yield empty, got %q", got)
	}
}

func TestDefaultProviderPicksAPIOverBing(t *testing.T) {
	t.Setenv("TAVILY_API_KEY", "")
	t.Setenv("BRAVE_API_KEY", "")
	if p := DefaultProvider(); p.Name() != "Bing" {
		t.Errorf("no keys → Bing, got %s", p.Name())
	}
	t.Setenv("BRAVE_API_KEY", "sk-test")
	if p := DefaultProvider(); p.Name() != "Brave API" {
		t.Errorf("brave key → Brave, got %s", p.Name())
	}
	t.Setenv("TAVILY_API_KEY", "tvly-test")
	if p := DefaultProvider(); p.Name() != "Tavily API" {
		t.Errorf("tavily key → Tavily (precedence), got %s", p.Name())
	}
}

func TestNormalizeDateFormats(t *testing.T) {
	if got := normalizeDate("2026/08/23"); got != "2026-08-23" {
		t.Errorf("slash: %q", got)
	}
	if got := normalizeDate("2026-08-23"); got != "2026-08-23" {
		t.Errorf("dash: %q", got)
	}
	if got := normalizeDate("1h"); got != "" {
		t.Errorf("relative: %q", got)
	}
	if got := normalizeDate(""); got != "" {
		t.Errorf("empty: %q", got)
	}
}

func TestTruncateRunesKeepsCJK(t *testing.T) {
	in := "这是一个超过十个字符的正文片段内容测试"
	got := truncate(in, 6)
	if len([]rune(got)) != 7 { // 6 + "…"
		t.Errorf("expected 7 runes (6+ellipsis), got %d: %q", len([]rune(got)), got)
	}
}
