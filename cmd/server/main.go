// Llama Launcher — llama.cpp 智能启动管理器
//
// 主入口：HTTP REST API + WebSocket 日志流 + 内嵌静态前端 + 子进程生命周期管理。
// 用法:
//
//	llama-launcher                      启动 Web 服务
//	llama-launcher parse <model.gguf>   单独测试 GGUF 解析
package main

import (
	"bufio"
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"flag"
	"fmt"
	"io"
	"log"
	"math/rand/v2"
	"net/http"
	"os"
	"os/exec"
	"os/signal"
	"path/filepath"
	"regexp"
	"sort"
	"strconv"
	"strings"
	"sync"
	"syscall"
	"time"

	"github.com/gorilla/websocket"

	"llama-launcher/internal/bundle"
	"llama-launcher/internal/config"
	"llama-launcher/internal/downloader"
	"llama-launcher/internal/fsbrowse"
	"llama-launcher/internal/gguf"
	"llama-launcher/internal/llama"
	"llama-launcher/internal/mcp"
	"llama-launcher/internal/secure"
	"llama-launcher/internal/session"
	"llama-launcher/internal/websearch"
	"llama-launcher/internal/webui"
)

// Version of the manager itself.
const Version = "0.2.3"

// Launch error sentinels, mapped to HTTP statuses in the handlers.
var (
	errBundleNotFound = errors.New("bundle not found")
	errPortInUse      = errors.New("端口已被占用")
	errBundleRunning  = errors.New("模型已在运行")
)

// GlobalConfig is the Level-1 (global default) configuration persisted at
// data/config.json.
type GlobalConfig struct {
	DataDir          string         `json:"data_dir"`
	BinaryPath       string         `json:"binary_path"`
	DefaultParams    map[string]any `json:"default_params"`
	LogRetentionDays int            `json:"log_retention_days"`
	HFEndpoint       string         `json:"hf_endpoint,omitempty"`        // HF 镜像覆盖
	CacheDir         string         `json:"cache_dir,omitempty"`          // llama.cpp 模型下载缓存目录（空=默认 ~/.cache/llama.cpp）
	ServerAPIKeyEnc  string         `json:"server_api_key_enc,omitempty"` // AES-256-GCM 加密
}

// DefaultGlobalConfig returns sensible defaults.
func DefaultGlobalConfig() *GlobalConfig {
	return &GlobalConfig{
		DataDir:          "data",
		DefaultParams:    map[string]any{"ctx_size": 4096, "n_gpu_layers": 0, "flash_attn": "on"},
		LogRetentionDays: 30,
	}
}

// loadGlobalConfig reads data/config.json (if present), else defaults.
func loadGlobalConfig(dataDir string) *GlobalConfig {
	cfg := DefaultGlobalConfig()
	if dataDir != "" {
		cfg.DataDir = dataDir
	}
	if data, err := os.ReadFile(filepath.Join(cfg.DataDir, "config.json")); err == nil {
		var loaded GlobalConfig
		if json.Unmarshal(data, &loaded) == nil {
			loaded.DataDir = cfg.DataDir // 数据目录始终以启动参数为准
			cfg = &loaded
		}
	}
	return cfg
}

// App wires all subsystems together.
type App struct {
	cfg      *GlobalConfig
	registry *config.Registry
	bundles  *bundle.Manager
	sessions *session.Manager
	mcp      *mcp.Manager
	cache    *bundle.CacheManager
	hw       *config.HardwareInfo

	upgrader websocket.Upgrader
	hub      *Hub

	mu            sync.Mutex
	runners       map[string]*activeRun
	liveMetrics   map[string]*llama.Metrics // 最近一次 /metrics 快照（实时监控）
	reqCur        map[string]*RequestRecord
	reqHistory    map[string][]RequestRecord // 每实例最近请求记录（上限 50）
	metricsTick   int                        // throttles session persistence
	configPath    string
	secretKeyPath string

	testCancel  map[string]bool           // 测试 jobID → 取消请求
	testHistory []TestHistoryRecord       // 测试历史（最近 50 条，data/test_history.json）
	testOOM     map[string]bool           // 会话 → 检测到 CUDA OOM（熔断标记）
	testPortMu  sync.Mutex                // 测试端口分配互斥（显存感知并行用）
	testPorts   map[int]bool              // 测试已分配端口（并行时避免冲突）
	testCache   map[string]testCacheEntry // L2 磁盘缓存（历史测过的组合，data/test_cache.json）
	logTail     map[string][]string       // 会话 → 最近 N 行 llama-server 日志（失败诊断用）
}

// maxLogTailLines keeps only the most recent lines per session so a failed
// load/test can surface the real llama-server error instead of a generic one.
const maxLogTailLines = 60

// activeRun couples a session with its live process.
type activeRun struct {
	session *session.Session
	runner  *llama.Runner
}

// Hub fans log lines out to all connected WebSocket clients.
type Hub struct {
	mu      sync.Mutex
	clients map[*wsClient]bool
}

type wsClient struct {
	conn *websocket.Conn
	send chan []byte
}

func NewHub() *Hub { return &Hub{clients: make(map[*wsClient]bool)} }

func (h *Hub) register(c *wsClient) { h.mu.Lock(); h.clients[c] = true; h.mu.Unlock() }
func (h *Hub) unregister(c *wsClient) {
	h.mu.Lock()
	if _, ok := h.clients[c]; ok {
		delete(h.clients, c)
		close(c.send)
	}
	h.mu.Unlock()
}

// Broadcast pushes a JSON message to every client.
func (h *Hub) Broadcast(msg []byte) {
	h.mu.Lock()
	defer h.mu.Unlock()
	for c := range h.clients {
		select {
		case c.send <- msg:
		default: // slow client — drop to avoid blocking
		}
	}
}

// PublishLog emits a typed log event to the UI console.
func (h *Hub) PublishLog(sessionID, level, line string) {
	evt := map[string]any{
		"type":       "log",
		"session_id": sessionID,
		"level":      level,
		"line":       line,
		"ts":         time.Now().Format("15:04:05"),
	}
	data, _ := json.Marshal(evt)
	h.Broadcast(data)
}

// readPump drains messages from a client (used for ping/pong keepalive).
func (c *wsClient) readPump(h *Hub) {
	defer h.unregister(c)
	c.conn.SetReadLimit(4096)
	_ = c.conn.SetReadDeadline(time.Now().Add(90 * time.Second))
	c.conn.SetPongHandler(func(string) error {
		return c.conn.SetReadDeadline(time.Now().Add(90 * time.Second))
	})
	for {
		if _, _, err := c.conn.ReadMessage(); err != nil {
			return
		}
	}
}

// writePump delivers queued messages to a client.
func (c *wsClient) writePump() {
	ticker := time.NewTicker(30 * time.Second)
	defer ticker.Stop()
	for {
		select {
		case msg, ok := <-c.send:
			if !ok {
				_ = c.conn.WriteMessage(websocket.CloseMessage, []byte{})
				return
			}
			if err := c.conn.WriteMessage(websocket.TextMessage, msg); err != nil {
				return
			}
		case <-ticker.C:
			if err := c.conn.WriteMessage(websocket.PingMessage, nil); err != nil {
				return
			}
		}
	}
}

// ---- construction ----

func NewApp(cfg *GlobalConfig) (*App, error) {
	if cfg.DataDir == "" {
		cfg.DataDir = "data"
	}
	if err := os.MkdirAll(cfg.DataDir, 0o755); err != nil {
		return nil, err
	}
	bundlesMgr, err := bundle.NewManager(filepath.Join(cfg.DataDir, "bundles.json"))
	if err != nil {
		return nil, err
	}
	sessionsMgr, err := session.NewManager(filepath.Join(cfg.DataDir, "sessions"))
	if err != nil {
		return nil, err
	}
	mcpMgr, err := mcp.NewManager(filepath.Join(cfg.DataDir, "mcp.json"))
	if err != nil {
		return nil, err
	}
	hw, _ := config.DetectHardware(context.Background())

	a := &App{
		cfg:           cfg,
		registry:      config.NewRegistry(),
		bundles:       bundlesMgr,
		sessions:      sessionsMgr,
		mcp:           mcpMgr,
		cache:         bundle.NewCacheManager(cfg.CacheDir),
		hw:            hw,
		upgrader:      websocket.Upgrader{CheckOrigin: func(*http.Request) bool { return true }},
		hub:           NewHub(),
		runners:       make(map[string]*activeRun),
		liveMetrics:   make(map[string]*llama.Metrics),
		reqCur:        make(map[string]*RequestRecord),
		reqHistory:    make(map[string][]RequestRecord),
		testCancel:    make(map[string]bool),
		testOOM:       make(map[string]bool),
		testPorts:     map[int]bool{},
		testCache:     map[string]testCacheEntry{},
		logTail:       make(map[string][]string),
		configPath:    filepath.Join(cfg.DataDir, "config.json"),
		secretKeyPath: filepath.Join(cfg.DataDir, ".secret"),
	}
	a.loadTestHistory()
	a.loadTestCache()
	downloader.SetEndpoint(cfg.HFEndpoint)
	a.startMetricsPoller(context.Background())
	return a, nil
}

// saveConfig persists the global config to data/config.json.
func (a *App) saveConfig() error {
	data, err := json.MarshalIndent(a.cfg, "", "  ")
	if err != nil {
		return err
	}
	return os.WriteFile(a.configPath, data, 0o644)
}

// startMetricsPoller polls /metrics for every running session every 5s and
// fans the results out over WebSocket for the live charts.
func (a *App) startMetricsPoller(ctx context.Context) {
	go func() {
		ticker := time.NewTicker(5 * time.Second)
		defer ticker.Stop()
		for {
			select {
			case <-ctx.Done():
				return
			case <-ticker.C:
				a.collectMetrics()
			}
		}
	}()
}

func (a *App) collectMetrics() {
	a.mu.Lock()
	type item struct {
		id string
		hc *llama.HealthChecker
	}
	items := make([]item, 0, len(a.runners))
	for id, ar := range a.runners {
		if ar.session.Status != session.StatusRunning {
			continue
		}
		hc := llama.NewHealthChecker(fmt.Sprintf("http://127.0.0.1:%d", ar.session.Port))
		hc.APIKey = a.sessionAPIKey(ar.session)
		items = append(items, item{
			id: id,
			hc: hc,
		})
	}
	a.mu.Unlock()
	a.metricsTick++
	persist := a.metricsTick%6 == 0 // ~every 30s
	for _, it := range items {
		m, err := it.hc.Metrics(context.Background())
		if err != nil {
			continue // not ready / not speaking our protocol yet
		}
		// Update running session stats for the insights dashboard.
		a.mu.Lock()
		var sess *session.Session
		if ar, ok := a.runners[it.id]; ok {
			sess = ar.session
			if m.NPredictedTokensTotal > sess.TotalTokensGenerated {
				sess.TotalTokensGenerated = m.NPredictedTokensTotal
			}
			if m.PredictedPerSecond > sess.PeakTPS {
				sess.PeakTPS = m.PredictedPerSecond
			}
		}
		if a.liveMetrics == nil {
			a.liveMetrics = map[string]*llama.Metrics{}
		}
		a.liveMetrics[it.id] = m
		a.mu.Unlock()
		if persist && sess != nil {
			_ = a.sessions.Update(sess)
		}
		data, _ := json.Marshal(map[string]any{
			"type":       "metrics",
			"session_id": it.id,
			"metrics":    m,
		})
		a.hub.Broadcast(data)
	}
}

// ---- HTTP handlers ----

func (a *App) writeJSON(w http.ResponseWriter, code int, v any) {
	w.Header().Set("Content-Type", "application/json; charset=utf-8")
	w.WriteHeader(code)
	_ = json.NewEncoder(w).Encode(v)
}

func (a *App) handleHealth(w http.ResponseWriter, r *http.Request) {
	a.writeJSON(w, http.StatusOK, map[string]any{
		"name":    "llama-launcher",
		"version": Version,
		"status":  "ok",
		"running": a.sessions.RunningCount(),
		"uptime":  time.Since(startTime).String(),
	})
}

func (a *App) handleSystem(w http.ResponseWriter, r *http.Request) {
	hw := a.hw
	// 实时刷新系统资源：启动时只探测一次，这里每次请求都重新探测
	// （nvidia-smi 显存/内存是动态值），失败则回退到启动时的缓存。
	if live, err := config.DetectHardware(r.Context()); err == nil && live != nil {
		if live.GPUCount > 0 || a.hw == nil || a.hw.GPUCount == 0 {
			hw = live
		} else {
			// 保留启动时已知的静态信息，仅更新动态值（空闲显存/系统内存）
			cp := *a.hw
			if live.FreeVRAMMB > 0 {
				cp.FreeVRAMMB = live.FreeVRAMMB
			}
			if live.SystemRAMMB > 0 {
				cp.SystemRAMMB = live.SystemRAMMB
			}
			hw = &cp
		}
	}
	a.writeJSON(w, http.StatusOK, map[string]any{
		"hardware":      hw,
		"binary":        a.cfg.BinaryPath,
		"data_dir":      a.cfg.DataDir,
		"launcher_path": launcherExecutable(),
	})
}

// launcherExecutable returns the absolute path of the running llama-launcher
// executable (used by the built-in websearch-mcp MCP server template).
func launcherExecutable() string {
	if p, err := os.Executable(); err == nil {
		return p
	}
	return ""
}

// RequestRecord is a single inference request parsed from llama-server's
// "print_timing" log lines (per slot/task), so the monitor can show a per-request
// history (prompt/eval tokens, throughput, latency, draft acceptance).
type RequestRecord struct {
	Time          string  `json:"time"`
	PromptTokens  int     `json:"prompt_tokens"`
	EvalTokens    int     `json:"eval_tokens"`
	PromptPS      float64 `json:"prompt_ps"`
	EvalPS        float64 `json:"eval_ps"`
	TotalMS       float64 `json:"total_ms"`
	DraftAccepted int     `json:"draft_accepted,omitempty"`
	DraftTotal    int     `json:"draft_total,omitempty"`

	PromptMS float64 `json:"-"` // internal, used to compute PromptPS
	EvalMS   float64 `json:"-"`
}

var (
	reAnsi   = regexp.MustCompile(`\x1b\[[0-9;]*m`)
	rePrompt = regexp.MustCompile(`prompt eval time =\s+([\d.]+) ms /\s+(\d+) tokens`)
	reEval   = regexp.MustCompile(`eval time =\s+([\d.]+) ms /\s+(\d+) tokens`)
	reTotal  = regexp.MustCompile(`total time =\s+([\d.]+) ms /\s+(\d+) tokens`)
	reDraft  = regexp.MustCompile(`draft acceptance =\s+([\d.]+) \(\s*(\d+) accepted /\s*(\d+) generated\)`)
	reRel    = regexp.MustCompile(`slot\s+release:\s*id\s+(\d+)\s*\|\s*task\s+(\d+)\s*\|\s*stop processing:\s*n_tokens\s*=\s*(\d+)`)
)

// handleServerLine processes one llama-server stdout line: it keeps publishing
// the log line to the UI and parses print_timing fragments into per-request
// records for the monitor's request history.
func (a *App) handleServerLine(sid, line string) {
	a.hub.PublishLog(sid, "INFO", line)
	// 保留最近日志尾部，供测试/加载失败时诊断真实原因（OOM、文件缺失、非法参数等）。
	a.mu.Lock()
	tail := a.logTail[sid]
	if len(tail) >= maxLogTailLines {
		tail = append(tail[maxLogTailLines-1:], line)
	} else {
		tail = append(tail, line)
	}
	a.logTail[sid] = tail
	a.mu.Unlock()
	// OOM 熔断：检测 CUDA 显存不足日志，立即标记该会话（测试引擎据此中止并清理）
	low := strings.ToLower(line)
	if strings.Contains(low, "out of memory") || strings.Contains(low, "cudamalloc") || strings.Contains(low, "cuda error") {
		a.mu.Lock()
		a.testOOM[sid] = true
		a.mu.Unlock()
	}
	clean := reAnsi.ReplaceAllString(line, "")
	if m := rePrompt.FindStringSubmatch(clean); m != nil {
		rec := a.reqRec(sid)
		rec.PromptTokens, _ = strconv.Atoi(m[2])
		rec.PromptMS, _ = strconv.ParseFloat(m[1], 64)
		return
	}
	if m := reEval.FindStringSubmatch(clean); m != nil {
		rec := a.reqRec(sid)
		rec.EvalTokens, _ = strconv.Atoi(m[2])
		rec.EvalMS, _ = strconv.ParseFloat(m[1], 64)
		return
	}
	if m := reTotal.FindStringSubmatch(clean); m != nil {
		rec := a.reqRec(sid)
		rec.TotalMS, _ = strconv.ParseFloat(m[1], 64)
		return
	}
	if m := reDraft.FindStringSubmatch(clean); m != nil {
		rec := a.reqRec(sid)
		rec.DraftAccepted, _ = strconv.Atoi(m[2])
		rec.DraftTotal, _ = strconv.Atoi(m[3])
		return
	}
	if reRel.MatchString(clean) {
		a.commitRequest(sid)
	}
}

// testOOMHit reports whether a session has logged a CUDA out-of-memory error.
func (a *App) testOOMHit(sid string) bool {
	a.mu.Lock()
	defer a.mu.Unlock()
	return a.testOOM[sid]
}

// sessionLogTail returns the last few llama-server log lines for a session,
// trimmed of ANSI codes, so a failed load/test can report the real cause.
func (a *App) sessionLogTail(sid string, n int) []string {
	a.mu.Lock()
	tail := a.logTail[sid]
	a.mu.Unlock()
	if n <= 0 || n > len(tail) {
		n = len(tail)
	}
	out := make([]string, 0, n)
	for _, l := range tail[len(tail)-n:] {
		clean := reAnsi.ReplaceAllString(l, "")
		if strings.TrimSpace(clean) != "" {
			out = append(out, clean)
		}
	}
	return out
}

func (a *App) reqRec(sid string) *RequestRecord {
	a.mu.Lock()
	defer a.mu.Unlock()
	if a.reqCur[sid] == nil {
		a.reqCur[sid] = &RequestRecord{}
	}
	return a.reqCur[sid]
}

// commitRequest finalizes the current request (triggered by "slot release"),
// persists it to the per-session history and broadcasts it over WS.
func (a *App) commitRequest(sid string) {
	a.mu.Lock()
	defer a.mu.Unlock()
	rec := a.reqCur[sid]
	if rec == nil || (rec.PromptTokens == 0 && rec.EvalTokens == 0) {
		a.reqCur[sid] = nil
		return
	}
	rec.Time = time.Now().Format("15:04:05")
	if rec.EvalMS > 0 && rec.EvalTokens > 0 {
		rec.EvalPS = float64(rec.EvalTokens) / (rec.EvalMS / 1000.0)
	}
	if rec.PromptMS > 0 && rec.PromptTokens > 0 {
		rec.PromptPS = float64(rec.PromptTokens) / (rec.PromptMS / 1000.0)
	}
	a.reqHistory[sid] = append(a.reqHistory[sid], *rec)
	if len(a.reqHistory[sid]) > 50 {
		a.reqHistory[sid] = a.reqHistory[sid][len(a.reqHistory[sid])-50:]
	}
	a.reqCur[sid] = nil
	data, _ := json.Marshal(map[string]any{"type": "request", "session_id": sid, "req": *rec})
	a.hub.Broadcast(data)
}

// handleMonitor returns a live snapshot of every running instance (model, port,
// uptime + latest /metrics) for the real-time monitor panel. The metrics are
// llama-server GLOBAL counters, so external API-key callers are included too.
func (a *App) handleMonitor(w http.ResponseWriter, r *http.Request) {
	type monitorInstance struct {
		SessionID string          `json:"session_id"`
		Bundle    string          `json:"bundle"`
		Port      int             `json:"port"`
		Uptime    string          `json:"uptime,omitempty"`
		Status    string          `json:"status"`
		Metrics   *llama.Metrics  `json:"metrics,omitempty"`
		Requests  []RequestRecord `json:"requests,omitempty"`
	}
	a.mu.Lock()
	items := make([]monitorInstance, 0, len(a.runners))
	for id, ar := range a.runners {
		mi := monitorInstance{SessionID: id, Port: ar.session.Port, Status: string(ar.session.Status)}
		if b, ok := a.bundles.Get(ar.session.BundleID); ok {
			mi.Bundle = b.Name
		}
		if t, err := time.Parse(time.RFC3339, ar.session.StartTime); err == nil {
			mi.Uptime = time.Since(t).Round(time.Second).String()
		}
		if m, ok := a.liveMetrics[id]; ok {
			mi.Metrics = m
		}
		if hs, ok := a.reqHistory[id]; ok {
			mi.Requests = hs
		}
		items = append(items, mi)
	}
	a.mu.Unlock()
	a.writeJSON(w, http.StatusOK, map[string]any{"instances": items})
}

// handleParams exposes the full parameter matrix (incl. default values,
// choices and Chinese tuning guidance) for the web UI help panels.
func (a *App) handleParams(w http.ResponseWriter, r *http.Request) {
	a.writeJSON(w, http.StatusOK, map[string]any{
		"params": a.registry.Params(),
	})
}

// handleBundles supports GET (list) and POST (create) on /api/bundles.
func (a *App) handleBundles(w http.ResponseWriter, r *http.Request) {
	switch r.Method {
	case http.MethodGet:
		a.writeJSON(w, http.StatusOK, annotateMTP(a.bundles.List()))
	case http.MethodPost:
		var b bundle.Bundle
		if err := json.NewDecoder(r.Body).Decode(&b); err != nil {
			a.writeJSON(w, http.StatusBadRequest, map[string]string{"error": err.Error()})
			return
		}
		if err := a.bundles.Add(&b); err != nil {
			a.writeJSON(w, http.StatusInternalServerError, map[string]string{"error": err.Error()})
			return
		}
		a.writeJSON(w, http.StatusCreated, b)
	default:
		a.writeJSON(w, http.StatusMethodNotAllowed, nil)
	}
}

// handleBundleItem supports PUT/DELETE on /api/bundles/{id}.
func (a *App) handleBundleItem(w http.ResponseWriter, r *http.Request) {
	id := r.PathValue("id")
	switch r.Method {
	case http.MethodPut:
		var b bundle.Bundle
		if err := json.NewDecoder(r.Body).Decode(&b); err != nil {
			a.writeJSON(w, http.StatusBadRequest, map[string]string{"error": err.Error()})
			return
		}
		b.ID = id
		if err := a.bundles.Update(&b); err != nil {
			a.writeJSON(w, http.StatusNotFound, map[string]string{"error": err.Error()})
			return
		}
		a.writeJSON(w, http.StatusOK, b)
	case http.MethodDelete:
		if err := a.bundles.Delete(id); err != nil {
			a.writeJSON(w, http.StatusNotFound, map[string]string{"error": err.Error()})
			return
		}
		a.writeJSON(w, http.StatusNoContent, nil)
	default:
		a.writeJSON(w, http.StatusMethodNotAllowed, nil)
	}
}

// handleBundleMCPServers updates which MCP servers a bundle is bound to
// (PUT /api/bundles/{id}/mcpservers, body {servers: [...]}).
func (a *App) handleBundleMCPServers(w http.ResponseWriter, r *http.Request) {
	id := r.PathValue("id")
	var req struct {
		Servers []string `json:"servers"`
	}
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		a.writeJSON(w, http.StatusBadRequest, map[string]string{"error": err.Error()})
		return
	}
	b, ok := a.bundles.Get(id)
	if !ok {
		a.writeJSON(w, http.StatusNotFound, map[string]string{"error": "模型不存在"})
		return
	}
	b.MCPServers = req.Servers
	if err := a.bundles.Update(b); err != nil {
		a.writeJSON(w, http.StatusInternalServerError, map[string]string{"error": err.Error()})
		return
	}
	a.writeJSON(w, http.StatusOK, b.MCPServers)
}

// handleBundleConfigs saves a tested configuration to a model (POST
// /api/bundles/{id}/configs).
func (a *App) handleBundleConfigs(w http.ResponseWriter, r *http.Request) {
	id := r.PathValue("id")
	var req struct {
		Name   string                `json:"name"`
		Params map[string]any        `json:"params"`
		Meta   bundle.TestConfigMeta `json:"meta"`
	}
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		a.writeJSON(w, http.StatusBadRequest, map[string]string{"error": err.Error()})
		return
	}
	if len(req.Params) == 0 {
		a.writeJSON(w, http.StatusBadRequest, map[string]string{"error": "params 不能为空"})
		return
	}
	tc, err := a.bundles.AddTestConfig(id, bundle.TestConfig{Name: req.Name, Params: req.Params, Meta: req.Meta})
	if err != nil {
		a.writeJSON(w, http.StatusNotFound, map[string]string{"error": err.Error()})
		return
	}
	a.writeJSON(w, http.StatusOK, tc)
}

// handleBundleConfigItem supports DELETE /api/bundles/{id}/configs/{cfgId}.
func (a *App) handleBundleConfigItem(w http.ResponseWriter, r *http.Request) {
	id := r.PathValue("id")
	cfgID := r.PathValue("cfgId")
	switch r.Method {
	case http.MethodDelete:
		if err := a.bundles.RemoveTestConfig(id, cfgID); err != nil {
			a.writeJSON(w, http.StatusNotFound, map[string]string{"error": err.Error()})
			return
		}
		a.writeJSON(w, http.StatusNoContent, nil)
	default:
		a.writeJSON(w, http.StatusMethodNotAllowed, nil)
	}
}

// handleParseGGUF parses a GGUF file for the UI (POST /api/parse).
func (a *App) handleParseGGUF(w http.ResponseWriter, r *http.Request) {
	var req struct {
		Path string `json:"path"`
	}
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		a.writeJSON(w, http.StatusBadRequest, map[string]string{"error": err.Error()})
		return
	}
	info, err := gguf.Parse(req.Path)
	if err != nil {
		a.writeJSON(w, http.StatusBadRequest, map[string]string{"error": err.Error()})
		return
	}
	a.writeJSON(w, http.StatusOK, map[string]any{
		"path":             info.Path,
		"architecture":     info.Architecture,
		"context_length":   info.ContextLength,
		"block_count":      info.BlockCount,
		"head_count_kv":    info.HeadCountKV,
		"embedding_length": info.EmbeddingLength,
		"file_type":        gguf.FileTypeName(info.FileType),
		"file_size_mb":     info.FileSizeMB,
		"metadata":         info.Metadata,
	})
}

// analyzeRequest is the body of POST /api/bundles/analyze.
type analyzeRequest struct {
	Path string `json:"path"`
	Name string `json:"name"`
}

// handleAnalyze parses a GGUF file and returns metadata + companion hints
// so the manual-add form can preview before saving.
func (a *App) handleAnalyze(w http.ResponseWriter, r *http.Request) {
	var req analyzeRequest
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		a.writeJSON(w, http.StatusBadRequest, map[string]string{"error": err.Error()})
		return
	}
	b, err := bundle.NewFromGGUF(req.Path, req.Name, bundle.CompanionHints{})
	if err != nil {
		a.writeJSON(w, http.StatusBadRequest, map[string]string{"error": err.Error()})
		return
	}
	// Strip heavy metadata for the preview payload.
	meta := map[string]any{}
	if b.BaseModel.Metadata != nil && b.BaseModel.Metadata.Metadata != nil {
		meta = b.BaseModel.Metadata.Metadata
	}
	a.writeJSON(w, http.StatusOK, map[string]any{
		"name":             b.Name,
		"path":             req.Path,
		"exists":           b.BaseModel.Exists,
		"file_size_mb":     b.BaseModel.FileSizeMB,
		"architecture":     b.BaseModel.Metadata.Architecture,
		"context_length":   b.BaseModel.Metadata.ContextLength,
		"block_count":      b.BaseModel.Metadata.BlockCount,
		"head_count_kv":    b.BaseModel.Metadata.HeadCountKV,
		"embedding_length": b.BaseModel.Metadata.EmbeddingLength,
		"is_moe":           b.BaseModel.Metadata.IsMoE(),
		"file_type":        gguf.FileTypeName(b.BaseModel.Metadata.FileType),
		"shard_info":       b.ShardInfo,
		"mmproj":           b.MMProj.Path,
		"draft":            b.DraftModel.Path,
		"lora":             loraPaths(b.LORAList),
		"tags":             b.Tags,
		"metadata":         meta,
	})
}

// importRequest is the body of POST /api/bundles/import.
type importRequest struct {
	Path string `json:"path"`
	Name string `json:"name"`
}

// handleImport creates a bundle from a GGUF path (with smart bundling).
func (a *App) handleImport(w http.ResponseWriter, r *http.Request) {
	var req importRequest
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		a.writeJSON(w, http.StatusBadRequest, map[string]string{"error": err.Error()})
		return
	}
	// 防重复：同一模型路径已在库中则拒绝再次导入（扫描/手动添加都会走这里）。
	if dup, ok := a.bundles.FindByPath(req.Path); ok {
		a.writeJSON(w, http.StatusConflict, map[string]string{
			"error":     "该模型已在模型库中（" + dup.Name + "），无需重复导入",
			"bundle_id": dup.ID,
			"name":      dup.Name,
		})
		return
	}
	b, err := a.bundles.AddFromGGUF(req.Path, req.Name, true)
	if err != nil {
		a.writeJSON(w, http.StatusBadRequest, map[string]string{"error": err.Error()})
		return
	}
	a.writeJSON(w, http.StatusCreated, b)
}

// scanRequest is the body of POST /api/bundles/scan.
type scanRequest struct {
	Dir string `json:"dir"`
}

// handleScan scans a folder and returns import candidates.
func (a *App) handleScan(w http.ResponseWriter, r *http.Request) {
	var req scanRequest
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		a.writeJSON(w, http.StatusBadRequest, map[string]string{"error": err.Error()})
		return
	}
	candidates, skipped, err := bundle.ScanDir(req.Dir)
	if err != nil {
		a.writeJSON(w, http.StatusBadRequest, map[string]string{"error": err.Error()})
		return
	}
	a.writeJSON(w, http.StatusOK, map[string]any{
		"dir":        req.Dir,
		"candidates": candidates,
		"skipped":    skipped,
	})
}

// recommendRequest is the body of POST /api/recommend.
type recommendRequest struct {
	BundleID string         `json:"bundle_id"`
	Scene    string         `json:"scene"`  // speed | context | lowvram | creative | ""
	Params   map[string]any `json:"params"` // current form values for audit
}

// handleRecommend runs the auto-config engine for a bundle and audits the
// current parameters. Powers the "✨ 一键优化" button.
func (a *App) handleRecommend(w http.ResponseWriter, r *http.Request) {
	var req recommendRequest
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		a.writeJSON(w, http.StatusBadRequest, map[string]string{"error": err.Error()})
		return
	}
	b, ok := a.bundles.Get(req.BundleID)
	if !ok {
		a.writeJSON(w, http.StatusNotFound, map[string]string{"error": "bundle not found"})
		return
	}
	spec := modelSpecFromBundle(b)
	rec := a.hw.Recommend(spec, req.Scene)
	audit := config.AuditConfig(req.Params, spec, a.hw)
	a.writeJSON(w, http.StatusOK, map[string]any{
		"recommendation": rec,
		"audit":          audit,
		"model_spec": map[string]any{
			"file_size_mb":     spec.FileSizeMB,
			"block_count":      spec.BlockCount,
			"context_length":   spec.ContextLength,
			"head_count_kv":    spec.HeadCountKV,
			"embedding_length": spec.EmbeddingLength,
			"architecture":     spec.Architecture,
			"is_moe":           spec.IsMoE,
			"num_experts":      spec.NumExperts,
		},
	})
}

// modelSpecFromBundle converts a bundle into the config engine's ModelSpec.
func modelSpecFromBundle(b *bundle.Bundle) config.ModelSpec {
	spec := config.ModelSpec{
		FileSizeMB:   b.BaseModel.FileSizeMB,
		MMProjSizeMB: b.MMProj.FileSizeMB,
	}
	if m := b.BaseModel.Metadata; m != nil {
		spec.BlockCount = m.BlockCount
		spec.ContextLength = m.ContextLength
		spec.HeadCountKV = m.HeadCountKV
		spec.EmbeddingLength = m.EmbeddingLength
		spec.Architecture = m.Architecture
		spec.IsMoE = m.IsMoE()
		spec.NumExperts = m.ExpertCount()
	}
	return spec
}

func loraPaths(lora []bundle.LoRA) []string {
	out := make([]string, 0, len(lora))
	for _, l := range lora {
		out = append(out, l.Path)
	}
	return out
}

// handleCache lists cache entries (GET /api/cache).
func (a *App) handleCache(w http.ResponseWriter, r *http.Request) {
	entries, err := a.cache.List()
	if err != nil {
		a.writeJSON(w, http.StatusInternalServerError, map[string]string{"error": err.Error()})
		return
	}
	a.writeJSON(w, http.StatusOK, map[string]any{
		"root":    a.cache.Root(),
		"entries": entries,
	})
}

// cacheOpRequest is the body of cache mutation endpoints.
type cacheOpRequest struct {
	Path    string `json:"path"`
	RepoID  string `json:"repo_id"`
	DestDir string `json:"dest_dir"`
}

// handleCacheDelete removes a cached entry (POST /api/cache/delete).
func (a *App) handleCacheDelete(w http.ResponseWriter, r *http.Request) {
	var req cacheOpRequest
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		a.writeJSON(w, http.StatusBadRequest, map[string]string{"error": err.Error()})
		return
	}
	if err := a.cache.Delete(bundle.Entry{Path: req.Path}); err != nil {
		a.writeJSON(w, http.StatusBadRequest, map[string]string{"error": err.Error()})
		return
	}
	a.writeJSON(w, http.StatusOK, map[string]bool{"ok": true})
}

// handleCacheImport registers a local GGUF into the official cache
// (POST /api/cache/import).
func (a *App) handleCacheImport(w http.ResponseWriter, r *http.Request) {
	var req cacheOpRequest
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		a.writeJSON(w, http.StatusBadRequest, map[string]string{"error": err.Error()})
		return
	}
	entry, err := a.cache.Import(req.Path, req.RepoID)
	if err != nil {
		a.writeJSON(w, http.StatusBadRequest, map[string]string{"error": err.Error()})
		return
	}
	a.writeJSON(w, http.StatusOK, entry)
}

// handleCacheExport copies a cached entry to a target directory
// (POST /api/cache/export).
func (a *App) handleCacheExport(w http.ResponseWriter, r *http.Request) {
	var req cacheOpRequest
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		a.writeJSON(w, http.StatusBadRequest, map[string]string{"error": err.Error()})
		return
	}
	if err := a.cache.Export(bundle.Entry{Path: req.Path}, req.DestDir); err != nil {
		a.writeJSON(w, http.StatusBadRequest, map[string]string{"error": err.Error()})
		return
	}
	a.writeJSON(w, http.StatusOK, map[string]bool{"ok": true})
}

// hfListRequest is the body of POST /api/hf/list.
type hfListRequest struct {
	Repo     string `json:"repo"`
	Revision string `json:"revision"`
}

// handleHFList lists downloadable .gguf files of a HF repo
// (POST /api/hf/list).
func (a *App) handleHFList(w http.ResponseWriter, r *http.Request) {
	var req hfListRequest
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		a.writeJSON(w, http.StatusBadRequest, map[string]string{"error": err.Error()})
		return
	}
	ctx, cancel := context.WithTimeout(r.Context(), 30*time.Second)
	defer cancel()
	files, err := downloader.ListFiles(ctx, req.Repo, req.Revision)
	if err != nil {
		a.writeJSON(w, http.StatusBadRequest, map[string]string{"error": err.Error()})
		return
	}
	a.writeJSON(w, http.StatusOK, map[string]any{
		"repo":   req.Repo,
		"files":  files,
		"mirror": downloader.Endpoint(),
	})
}

// hfDownloadRequest is the body of POST /api/hf/download.
type hfDownloadRequest struct {
	Repo     string `json:"repo"`
	Filename string `json:"filename"`
	Revision string `json:"revision"`
}

// handleHFDownload starts an asynchronous, resumable download and auto-imports
// the finished model into the library (POST /api/hf/download).
func (a *App) handleHFDownload(w http.ResponseWriter, r *http.Request) {
	var req hfDownloadRequest
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		a.writeJSON(w, http.StatusBadRequest, map[string]string{"error": err.Error()})
		return
	}
	if req.Repo == "" || req.Filename == "" {
		a.writeJSON(w, http.StatusBadRequest, map[string]string{"error": "仓库名与文件名必填"})
		return
	}
	root := a.cache.Root()
	if root == "" {
		home, err := os.UserHomeDir()
		if err != nil {
			a.writeJSON(w, http.StatusInternalServerError, map[string]string{"error": err.Error()})
			return
		}
		root = filepath.Join(home, ".cache", "llama.cpp")
	}
	jobID := fmt.Sprintf("dl_%d", time.Now().UnixNano())
	a.hub.PublishLog(jobID, "INFO",
		fmt.Sprintf("⬇️ 开始下载 %s (%s) → %s", req.Filename, req.Repo, root))

	go func() {
		var last time.Time
		publishProgress := func(done, total int64) {
			if time.Since(last) < 300*time.Millisecond {
				return // throttle WS
			}
			last = time.Now()
			data, _ := json.Marshal(map[string]any{
				"type":     "progress",
				"job_id":   jobID,
				"filename": req.Filename,
				"done":     done,
				"total":    total,
			})
			a.hub.Broadcast(data)
		}
		// Use a background context: the HTTP request context is cancelled as
		// soon as the handler returns, which would abort the download.
		path, err := downloader.Download(context.Background(), req.Repo, req.Filename, req.Revision, root,
			publishProgress)
		if err != nil {
			a.hub.PublishLog(jobID, "ERROR", "下载失败: "+err.Error())
			a.broadcastDownloadEnd(jobID, req.Filename, 0, 0, false)
			return
		}
		a.hub.PublishLog(jobID, "INFO", fmt.Sprintf("✅ 下载完成: %s", path))
		a.broadcastDownloadEnd(jobID, req.Filename, 1, 1, true)
		// Auto-import into the model library (smart bundling included).
		b, err := a.bundles.AddFromGGUF(path, "", true)
		if err != nil {
			a.hub.PublishLog(jobID, "WARN", "入库失败: "+err.Error())
			return
		}
		a.hub.PublishLog(jobID, "INFO", fmt.Sprintf("📦 已导入模型库: %s", b.Name))
	}()
	a.writeJSON(w, http.StatusOK, map[string]any{
		"job_id":   jobID,
		"started":  true,
		"filename": req.Filename,
	})
}

// broadcastDownloadEnd marks a download task finished (done/total=1 or failed).
func (a *App) broadcastDownloadEnd(jobID, filename string, done, total int64, ok bool) {
	data, _ := json.Marshal(map[string]any{
		"type":     "progress",
		"job_id":   jobID,
		"filename": filename,
		"done":     done,
		"total":    total,
		"finished": true,
		"success":  ok,
	})
	a.hub.Broadcast(data)
}

// debugProxyRequest is the body of POST /api/debug/proxy.
type debugProxyRequest struct {
	SessionID string         `json:"session_id"`
	Path      string         `json:"path"` // e.g. /v1/chat/completions
	Body      map[string]any `json:"body"`
}

// handleDebugProxy forwards a request to a running instance's OpenAI-compatible
// API and relays the response verbatim (including SSE streams). Powers the
// built-in API debug panel.
func (a *App) handleDebugProxy(w http.ResponseWriter, r *http.Request) {
	var req debugProxyRequest
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		a.writeJSON(w, http.StatusBadRequest, map[string]string{"error": err.Error()})
		return
	}
	if req.SessionID == "" || req.Path == "" {
		a.writeJSON(w, http.StatusBadRequest, map[string]string{"error": "session_id 与 path 必填"})
		return
	}
	a.mu.Lock()
	ar, ok := a.runners[req.SessionID]
	a.mu.Unlock()
	if !ok {
		a.writeJSON(w, http.StatusNotFound, map[string]string{"error": "实例未在运行"})
		return
	}
	if !strings.HasPrefix(req.Path, "/") {
		req.Path = "/" + req.Path
	}
	url := fmt.Sprintf("http://127.0.0.1:%d%s", ar.session.Port, req.Path)
	raw, _ := json.Marshal(req.Body)
	upReq, err := http.NewRequestWithContext(r.Context(), http.MethodPost, url, bytes.NewReader(raw))
	if err != nil {
		a.writeJSON(w, http.StatusInternalServerError, map[string]string{"error": err.Error()})
		return
	}
	upReq.Header.Set("Content-Type", "application/json")
	upReq.Header.Set("Accept", "text/event-stream")
	// Attach the instance's API key so the debug panel can authenticate.
	key := ""
	if v, ok := ar.session.Params["api_key"].(string); ok && v != "" {
		key = v
	} else if a.cfg.ServerAPIKeyEnc != "" {
		if plain, err := secure.Decrypt(a.secretKeyPath, a.cfg.ServerAPIKeyEnc); err == nil && plain != "" {
			key = plain
		}
	}
	if key != "" {
		upReq.Header.Set("Authorization", "Bearer "+key)
	}
	resp, err := http.DefaultClient.Do(upReq)
	if err != nil {
		a.writeJSON(w, http.StatusBadGateway, map[string]string{"error": "无法连接实例: " + err.Error()})
		return
	}
	defer resp.Body.Close()

	ct := resp.Header.Get("Content-Type")
	if ct == "" {
		ct = "application/json"
	}
	w.Header().Set("Content-Type", ct)
	w.Header().Set("Cache-Control", "no-cache")
	w.WriteHeader(resp.StatusCode)
	if resp.StatusCode != http.StatusOK {
		_, _ = io.Copy(w, resp.Body)
		return
	}
	// Relay the body (SSE or JSON) with per-chunk flushing.
	flusher, _ := w.(http.Flusher)
	buf := make([]byte, 4096)
	for {
		n, rerr := resp.Body.Read(buf)
		if n > 0 {
			if _, werr := w.Write(buf[:n]); werr != nil {
				return
			}
			if flusher != nil {
				flusher.Flush()
			}
		}
		if rerr != nil {
			return
		}
	}
}

// handleSessions lists sessions (GET /api/sessions).
func (a *App) handleSessions(w http.ResponseWriter, r *http.Request) {
	a.writeJSON(w, http.StatusOK, a.sessions.List())
}

// modelStat aggregates usage for a single model.
type modelStat struct {
	Name     string  `json:"name"`
	Sessions int     `json:"sessions"`
	Tokens   int64   `json:"tokens"`
	AvgTPS   float64 `json:"avg_tps"`
	Crashes  int     `json:"crashes"`
}

// dayStat aggregates usage for a single day.
type dayStat struct {
	Date     string `json:"date"`
	Sessions int    `json:"sessions"`
	Tokens   int64  `json:"tokens"`
}

// handleInsights aggregates usage statistics from all sessions
// (GET /api/insights). Powers the 使用洞察 dashboard.
func (a *App) handleInsights(w http.ResponseWriter, r *http.Request) {
	sessions := a.sessions.List()
	byModel := make(map[string]*modelStat)
	byDay := make(map[string]*dayStat)

	var totalTokens, totalSessions, crashes int64
	today := time.Now().Format("2006-01-02")
	todaySessions := 0

	for _, s := range sessions {
		totalSessions++
		if s.StartTime[:10] == today {
			todaySessions++
		}
		if s.Status == session.StatusCrashed {
			crashes++
		}
		totalTokens += s.TotalTokensGenerated

		name := s.BundleID
		if b, ok := a.bundles.Get(s.BundleID); ok {
			name = b.Name
		}
		ms := byModel[name]
		if ms == nil {
			ms = &modelStat{Name: name}
			byModel[name] = ms
		}
		ms.Sessions++
		ms.Tokens += s.TotalTokensGenerated
		if s.Status == session.StatusCrashed {
			ms.Crashes++
		}
		if s.PeakTPS > 0 {
			ms.AvgTPS += s.PeakTPS
		}

		day := s.StartTime[:10]
		ds := byDay[day]
		if ds == nil {
			ds = &dayStat{Date: day}
			byDay[day] = ds
		}
		ds.Sessions++
		ds.Tokens += s.TotalTokensGenerated
	}

	models := make([]*modelStat, 0, len(byModel))
	var totalTPS float64
	for _, ms := range byModel {
		if ms.Sessions > 0 {
			ms.AvgTPS = ms.AvgTPS / float64(ms.Sessions)
		}
		if ms.Tokens > 0 {
			totalTPS += ms.AvgTPS
		}
		models = append(models, ms)
	}
	sortModels(models)

	// Last 14 days (fill gaps with zero).
	days := make([]*dayStat, 0, 14)
	for i := 13; i >= 0; i-- {
		d := time.Now().AddDate(0, 0, -i).Format("2006-01-02")
		if ds, ok := byDay[d]; ok {
			days = append(days, ds)
		} else {
			days = append(days, &dayStat{Date: d})
		}
	}

	successRate := 1.0
	if totalSessions > 0 {
		successRate = float64(totalSessions-crashes) / float64(totalSessions)
	}
	avgTPS := 0.0
	if len(models) > 0 {
		avgTPS = totalTPS / float64(len(models))
	}

	a.writeJSON(w, http.StatusOK, map[string]any{
		"total_tokens":   totalTokens,
		"total_sessions": totalSessions,
		"today_sessions": todaySessions,
		"crashes":        crashes,
		"success_rate":   successRate,
		"avg_tps":        avgTPS,
		"models":         models,
		"days":           days,
		"generated_at":   time.Now().Format(time.RFC3339),
	})
}

func sortModels(models []*modelStat) {
	sort.Slice(models, func(i, j int) bool {
		if models[i].Tokens != models[j].Tokens {
			return models[i].Tokens > models[j].Tokens
		}
		return models[i].Sessions > models[j].Sessions
	})
}

// handleMCPList lists registered MCP servers (GET /api/mcp).
func (a *App) handleMCPList(w http.ResponseWriter, r *http.Request) {
	a.writeJSON(w, http.StatusOK, a.mcp.List())
}

// handleMCPAdd registers a new MCP server (POST /api/mcp).
func (a *App) handleMCPAdd(w http.ResponseWriter, r *http.Request) {
	var s mcp.Server
	if err := json.NewDecoder(r.Body).Decode(&s); err != nil {
		a.writeJSON(w, http.StatusBadRequest, map[string]string{"error": err.Error()})
		return
	}
	if s.Name == "" || s.Command == "" {
		a.writeJSON(w, http.StatusBadRequest, map[string]string{"error": "名称与命令必填"})
		return
	}
	if err := a.mcp.Add(&s); err != nil {
		a.writeJSON(w, http.StatusInternalServerError, map[string]string{"error": err.Error()})
		return
	}
	a.writeJSON(w, http.StatusCreated, s)
}

// handleMCPDelete removes an MCP server (DELETE /api/mcp/{id}).
func (a *App) handleMCPDelete(w http.ResponseWriter, r *http.Request) {
	id := r.PathValue("id")
	if err := a.mcp.Remove(id); err != nil {
		a.writeJSON(w, http.StatusInternalServerError, map[string]string{"error": err.Error()})
		return
	}
	a.writeJSON(w, http.StatusNoContent, nil)
}

// mcpCursorJSON converts a bundle's bound MCP servers into a Cursor-format JSON
// string ready for --mcp-servers-json (empty when none are enabled).
func (a *App) mcpCursorJSON(b *bundle.Bundle) (string, error) {
	if len(b.MCPServers) == 0 || a.mcp == nil {
		return "", nil
	}
	cfg, err := a.mcp.ToCursorJSON(b.MCPServers)
	if err != nil {
		log.Printf("mcp: failed to build config for %s: %v", b.ID, err)
		return "", err
	}
	return cfg, nil
}

// handleMCPStatus reports per-server health (command resolvable on PATH).
func (a *App) handleMCPStatus(w http.ResponseWriter, r *http.Request) {
	servers := a.mcp.List()
	items := make([]map[string]any, 0, len(servers))
	for _, s := range servers {
		_, err := exec.LookPath(s.Command)
		items = append(items, map[string]any{
			"id": s.ID, "name": s.Name, "command": s.Command, "args": s.Args,
			"enabled": s.Enabled, "healthy": err == nil,
		})
	}
	a.writeJSON(w, http.StatusOK, items)
}

// handleMCPCheckEnv reports availability of common runtimes used by templates.
func (a *App) handleMCPCheckEnv(w http.ResponseWriter, r *http.Request) {
	result := map[string]bool{}
	for _, cmd := range []string{"node", "npx", "python", "docker", "git", "uvx"} {
		_, err := exec.LookPath(cmd)
		result[cmd] = err == nil
	}
	a.writeJSON(w, http.StatusOK, result)
}

// handleMCPTest performs a REAL MCP stdio handshake (initialize + tools/list)
// instead of just spawning the command, so a green test means the server's
// tools can actually be listed. Failure includes the concrete reason (package
// missing, missing env, server crash) plus the last stderr lines.
func (a *App) handleMCPTest(w http.ResponseWriter, r *http.Request) {
	var req struct {
		Command string            `json:"command"`
		Args    []string          `json:"args"`
		Env     map[string]string `json:"env"`
	}
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		a.writeJSON(w, http.StatusBadRequest, map[string]any{"ok": false, "message": err.Error()})
		return
	}
	res := mcpStdioProbe(req.Command, req.Args, req.Env, 60*time.Second)
	a.writeJSON(w, http.StatusOK, res)
}

// mcpProbeResult is the JSON shape returned by the MCP handshake probe.
type mcpProbeResult struct {
	OK      bool     `json:"ok"`
	Tools   []string `json:"tools,omitempty"`
	Count   int      `json:"count"`
	Message string   `json:"message"`
}

// mcpStdioProbe starts an MCP server over stdio and runs the JSON-RPC
// initialize → tools/list handshake. A non-nil error tells the user exactly why
// the server is unusable (missing package / missing env / crash), which the old
// spawn-and-kill test could not detect.
func mcpStdioProbe(command string, args []string, env map[string]string, timeout time.Duration) mcpProbeResult {
	ctx, cancel := context.WithTimeout(context.Background(), timeout)
	defer cancel()
	cmd := exec.CommandContext(ctx, command, args...)
	cmd.Env = os.Environ()
	for k, v := range env {
		cmd.Env = append(cmd.Env, k+"="+v)
	}
	stdin, err := cmd.StdinPipe()
	if err != nil {
		return mcpProbeResult{OK: false, Message: "无法建立 stdin 管道: " + err.Error()}
	}
	stdout, err := cmd.StdoutPipe()
	if err != nil {
		return mcpProbeResult{OK: false, Message: "无法建立 stdout 管道: " + err.Error()}
	}
	stderr, err := cmd.StderrPipe()
	if err != nil {
		return mcpProbeResult{OK: false, Message: "无法建立 stderr 管道: " + err.Error()}
	}
	if err := cmd.Start(); err != nil {
		low := strings.ToLower(err.Error())
		if strings.Contains(low, "executable file not found") || strings.Contains(low, "cannot find") || strings.Contains(low, "not recognized") {
			return mcpProbeResult{OK: false, Message: "命令无法启动（未安装或不在 PATH）：" + err.Error()}
		}
		return mcpProbeResult{OK: false, Message: "命令启动失败: " + err.Error()}
	}
	defer func() { _ = cmd.Process.Kill(); _ = cmd.Wait(); _ = stdin.Close() }()

	// 收集 stderr 尾部，失败时给出具体原因（npx 404、缺 env、崩溃等）
	var tailMu sync.Mutex
	var tailLines []string
	go func() {
		sc := bufio.NewScanner(stderr)
		sc.Buffer(make([]byte, 0, 64*1024), 512*1024)
		for sc.Scan() {
			l := strings.TrimSpace(sc.Text())
			if l == "" {
				continue
			}
			tailMu.Lock()
			tailLines = append(tailLines, l)
			if len(tailLines) > 20 {
				tailLines = tailLines[len(tailLines)-20:]
			}
			tailMu.Unlock()
		}
	}()
	tail := func() string {
		tailMu.Lock()
		defer tailMu.Unlock()
		if len(tailLines) == 0 {
			return ""
		}
		n := len(tailLines)
		if n > 5 {
			tailLines = tailLines[n-5:]
		}
		return strings.Join(tailLines, " | ")
	}

	// 写请求：优先新版 newline-delimited JSON（2025-06-18+ spec）；若 server 不响应
	// 再回退到旧版 Content-Length 帧（如已废弃的 brave-search 0.6.2）。
	writeMsg := func(id int, method string, params map[string]any, newline bool) error {
		msg := map[string]any{"jsonrpc": "2.0", "id": id, "method": method, "params": params}
		body, _ := json.Marshal(msg)
		var err error
		if newline {
			_, err = stdin.Write(append(body, '\n'))
		} else {
			if _, err = stdin.Write([]byte(fmt.Sprintf("Content-Length: %d\r\n\r\n", len(body)))); err == nil {
				_, err = stdin.Write(body)
			}
		}
		return err
	}

	// 单一 reader goroutine 串行读取所有消息；自动识别两种 stdio 格式：
	// 以 '{' 开头 = newline-delimited JSON；否则为 Content-Length 帧（LSP 风格）。
	br := bufio.NewReader(stdout)
	type frameMsg struct {
		msg map[string]any
		err error
	}
	frameCh := make(chan frameMsg, 16)
	go func() {
		defer close(frameCh)
		for {
			first, err := br.Peek(1)
			if err != nil {
				frameCh <- frameMsg{nil, fmt.Errorf("读取响应失败: %v", err)}
				return
			}
			if first[0] == '{' {
				// 新版：newline-delimited JSON
				line, err := br.ReadString('\n')
				if err != nil {
					frameCh <- frameMsg{nil, fmt.Errorf("读取响应行失败: %v", err)}
					return
				}
				var msg map[string]any
				if err := json.Unmarshal([]byte(strings.TrimSpace(line)), &msg); err != nil {
					continue // 非 JSON 行（日志）跳过
				}
				frameCh <- frameMsg{msg, nil}
				continue
			}
			// 旧版：Content-Length 帧
			length := -1
			for {
				line, err := br.ReadString('\n')
				if err != nil {
					frameCh <- frameMsg{nil, fmt.Errorf("读取响应头失败: %v", err)}
					return
				}
				line = strings.TrimSpace(line)
				if line == "" {
					break
				}
				if strings.HasPrefix(strings.ToLower(line), "content-length:") {
					length, _ = strconv.Atoi(strings.TrimSpace(line[len("content-length:"):]))
				}
			}
			if length < 0 {
				frameCh <- frameMsg{nil, fmt.Errorf("响应缺少 Content-Length")}
				return
			}
			body := make([]byte, length)
			if _, err := io.ReadFull(br, body); err != nil {
				frameCh <- frameMsg{nil, fmt.Errorf("读取响应体失败: %v", err)}
				return
			}
			var msg map[string]any
			if err := json.Unmarshal(body, &msg); err != nil {
				continue
			}
			frameCh <- frameMsg{msg, nil}
		}
	}()
	// 等待指定 id 的响应（跳过通知与其它 id），支持独立超时（用于协议回退）。
	readResp := func(id int, timeout time.Duration) (map[string]any, error) {
		timer := time.NewTimer(timeout)
		defer timer.Stop()
		for {
			select {
			case fm, ok := <-frameCh:
				if !ok {
					return nil, fmt.Errorf("服务已退出，未收到响应")
				}
				if fm.err != nil {
					return nil, fm.err
				}
				if fm.msg["id"] == nil {
					continue
				}
				if f, ok := fm.msg["id"].(float64); ok && int(f) == id {
					return fm.msg, nil
				}
			case <-timer.C:
				return nil, fmt.Errorf("等待响应超时（%v）", timeout)
			}
		}
	}
	// 先发一版请求，若超时则用另一种协议重试（newline 优先，Content-Length 回退）。
	tryHandshake := func(id int, method string, params map[string]any) (map[string]any, error) {
		for _, newline := range []bool{true, false} {
			if err := writeMsg(id, method, params, newline); err != nil {
				return nil, fmt.Errorf("发送 %s 失败: %v", method, err)
			}
			if resp, err := readResp(id, 12*time.Second); err == nil {
				return resp, nil
			}
		}
		return nil, fmt.Errorf("尝试两种 stdio 协议（newline/Content-Length）均未收到 %s 响应", method)
	}

	// 1) initialize
	resp, err := tryHandshake(1, "initialize", map[string]any{
		"protocolVersion": "2025-06-18",
		"capabilities":    map[string]any{},
		"clientInfo":      map[string]any{"name": "llama-launcher", "version": "0.2.3"},
	})
	if err != nil {
		return mcpProbeResult{OK: false, Message: err.Error() + "；命令可执行但 MCP 握手未完成（可能包不完整或环境变量缺失）" + (func() string {
			if t := tail(); t != "" {
				return "。服务输出: " + t
			}
			return ""
		})()}
	}
	if e, ok := resp["error"].(map[string]any); ok {
		return mcpProbeResult{OK: false, Message: "initialize 报错: " + fmt.Sprint(e["message"])}
	}

	// 2) tools/list
	resp2, err := tryHandshake(2, "tools/list", map[string]any{})
	if err != nil {
		return mcpProbeResult{OK: false, Message: err.Error() + (func() string {
			if t := tail(); t != "" {
				return "。服务输出: " + t
			}
			return ""
		})()}
	}
	if e, ok := resp2["error"].(map[string]any); ok {
		return mcpProbeResult{OK: false, Message: "tools/list 报错: " + fmt.Sprint(e["message"]) + (func() string {
			if t := tail(); t != "" {
				return "。服务输出: " + t
			}
			return ""
		})()}
	}
	result, _ := resp2["result"].(map[string]any)
	rawTools, _ := result["tools"].([]any)
	tools := make([]string, 0, len(rawTools))
	for _, t := range rawTools {
		if tm, ok := t.(map[string]any); ok {
			if n, ok := tm["name"].(string); ok {
				tools = append(tools, n)
			}
		}
	}
	if len(tools) == 0 {
		return mcpProbeResult{OK: false, Message: "握手成功但未返回任何工具（可能需配置环境变量）"}
	}
	return mcpProbeResult{OK: true, Tools: tools, Count: len(tools), Message: fmt.Sprintf("✅ MCP 服务正常，发现 %d 个工具：%s", len(tools), strings.Join(tools, ", "))}
}

// MCPTemplate describes a one-click MCP server preset (data/mcp_templates.json).
type MCPTemplate struct {
	ID           string   `json:"id"`
	Name         string   `json:"name"`
	Description  string   `json:"description"`
	Command      string   `json:"command"`
	Args         []string `json:"args"`
	RequiresPath bool     `json:"requires_path"`
	RequiresEnv  []string `json:"requires_env"`
	RequiresText *struct {
		Label       string `json:"label"`
		Placeholder string `json:"placeholder"`
	} `json:"requires_text,omitempty"`
	Recommended bool   `json:"recommended"`
	Category    string `json:"category"`
	Hint        string `json:"hint,omitempty"`
}

// handleMCPTemplates lists one-click templates from data/mcp_templates.json.
func (a *App) handleMCPTemplates(w http.ResponseWriter, r *http.Request) {
	path := filepath.Join(a.cfg.DataDir, "mcp_templates.json")
	data, err := os.ReadFile(path)
	if err != nil {
		a.writeJSON(w, http.StatusOK, []MCPTemplate{})
		return
	}
	var templates []MCPTemplate
	if err := json.Unmarshal(data, &templates); err != nil {
		log.Printf("mcp: template parse error: %v", err)
		a.writeJSON(w, http.StatusOK, []MCPTemplate{})
		return
	}
	a.writeJSON(w, http.StatusOK, templates)
}

// handleFSList lists a directory for the built-in file browser
// (GET /api/fs/list?path=...).
func (a *App) handleFSList(w http.ResponseWriter, r *http.Request) {
	path := r.URL.Query().Get("path")
	res, err := fsbrowse.List(path)
	if err != nil {
		a.writeJSON(w, http.StatusBadRequest, map[string]string{"error": "无法读取目录: " + err.Error()})
		return
	}
	a.writeJSON(w, http.StatusOK, res)
}

// cacheEnv returns env vars that make llama-server -hf downloads use the
// configured cache directory (empty = llama.cpp default ~/.cache/llama.cpp).
func cacheEnv(cacheDir string) []string {
	if strings.TrimSpace(cacheDir) == "" {
		return nil
	}
	return []string{"LLAMA_CACHE=" + cacheDir}
}

// handleConfigGet returns the global settings (GET /api/config). Secrets are
// only surfaced as a boolean, never decrypted.
func (a *App) handleConfigGet(w http.ResponseWriter, r *http.Request) {
	a.writeJSON(w, http.StatusOK, map[string]any{
		"data_dir":           a.cfg.DataDir,
		"binary_path":        a.cfg.BinaryPath,
		"log_retention_days": a.cfg.LogRetentionDays,
		"hf_endpoint":        a.cfg.HFEndpoint,
		"cache_dir":          a.cfg.CacheDir,
		"has_api_key":        a.cfg.ServerAPIKeyEnc != "",
	})
}

// handleConfigKey returns the decrypted global API key (GET /api/config/key).
// Only surfaced on demand — the settings panel requests it when the user clicks
// the 👁 reveal button, so the plaintext is never sent unless asked for.
func (a *App) handleConfigKey(w http.ResponseWriter, r *http.Request) {
	a.writeJSON(w, http.StatusOK, map[string]string{"key": a.effectiveAPIKey()})
}

// handleConfigPut updates the global settings (PUT /api/config).
// server_api_key semantics: "" → clear, "__KEEP__" → keep existing,
// any other value → encrypt & store.
func (a *App) handleConfigPut(w http.ResponseWriter, r *http.Request) {
	var req struct {
		BinaryPath       string `json:"binary_path"`
		LogRetentionDays int    `json:"log_retention_days"`
		HFEndpoint       string `json:"hf_endpoint"`
		CacheDir         string `json:"cache_dir"`
		ServerAPIKey     string `json:"server_api_key"`
	}
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		a.writeJSON(w, http.StatusBadRequest, map[string]string{"error": err.Error()})
		return
	}
	a.cfg.BinaryPath = req.BinaryPath
	if req.LogRetentionDays > 0 {
		a.cfg.LogRetentionDays = req.LogRetentionDays
	}
	a.cfg.HFEndpoint = strings.TrimSpace(req.HFEndpoint)
	downloader.SetEndpoint(a.cfg.HFEndpoint)
	// 缓存目录变更 → 重建缓存管理器（空=回到默认 ~/.cache/llama.cpp）
	a.cfg.CacheDir = strings.TrimSpace(req.CacheDir)
	a.cache = bundle.NewCacheManager(a.cfg.CacheDir)

	switch req.ServerAPIKey {
	case "__KEEP__":
		// keep existing encrypted value
	case "":
		a.cfg.ServerAPIKeyEnc = ""
	default:
		enc, err := secure.Encrypt(a.secretKeyPath, req.ServerAPIKey)
		if err != nil {
			a.writeJSON(w, http.StatusInternalServerError, map[string]string{"error": "加密失败: " + err.Error()})
			return
		}
		a.cfg.ServerAPIKeyEnc = enc
	}
	if err := a.saveConfig(); err != nil {
		a.writeJSON(w, http.StatusInternalServerError, map[string]string{"error": err.Error()})
		return
	}
	a.writeJSON(w, http.StatusOK, map[string]any{"ok": true})
}

// startRequest is the body of POST /api/sessions/start.
type startRequest struct {
	BundleID string         `json:"bundle_id"`
	Port     int            `json:"port"`
	Params   map[string]any `json:"params"`
}

// handleStart launches a model (POST /api/sessions/start).
func (a *App) handleStart(w http.ResponseWriter, r *http.Request) {
	var req startRequest
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		a.writeJSON(w, http.StatusBadRequest, map[string]string{"error": err.Error()})
		return
	}
	sess, err := a.launch(req.BundleID, req.Port, req.Params, false)
	if err != nil {
		code := http.StatusInternalServerError
		if err == errPortInUse || err == errBundleRunning || err == errBundleNotFound {
			code = http.StatusConflict
		}
		if err == errBundleNotFound {
			code = http.StatusNotFound
		}
		a.writeJSON(w, code, map[string]string{"error": err.Error()})
		return
	}
	a.writeJSON(w, http.StatusOK, sess)
}

// launch performs the full start flow and returns the created session.
func (a *App) launch(bundleID string, port int, params map[string]any, allowSameModel bool) (*session.Session, error) {
	b, ok := a.bundles.Get(bundleID)
	if !ok {
		return nil, errBundleNotFound
	}
	// Resource-conflict pre-checks (port / duplicate model).
	if owner, used := a.sessions.PortInUse(port); used {
		return nil, fmt.Errorf("%w: 端口 %d 已被实例 %s 占用", errPortInUse, port, owner)
	}
	// 测试（批量/参数扫描）允许与同模型的常驻实例并行，故跳过重复检查。
	if !allowSameModel {
		if owner, used := a.sessions.BundleInUse(b.ID); used {
			return nil, fmt.Errorf("%w: 模型已在实例 %s 中运行", errBundleRunning, owner)
		}
	}
	if port == 0 {
		port = 8080
	}
	sess := a.sessions.Create(b.ID, "", a.cfg.BinaryPath, port)
	sess.Params = params
	sess.CmdlineArgs = a.buildArgs(b, params, port)

	// Wire stdout/stderr into the hub so logs stream to the UI.
	pr, pw := io.Pipe()
	a.hub.PublishLog(sess.ID, "INFO", fmt.Sprintf("启动模型 %s (%s)", b.Name, b.BaseModel.Path))
	runner := llama.New(llama.Options{
		BinaryPath: a.cfg.BinaryPath,
		Args:       sess.CmdlineArgs,
		WorkDir:    a.cfg.DataDir,
		Stdout:     pw,
		Stderr:     pw,
		// 让 llama-server 的 -hf 下载也使用配置的缓存目录（若设置了）
		Env: cacheEnv(a.cfg.CacheDir),
	})
	go func() {
		defer pw.Close()
		buf := make([]byte, 4096)
		var pending []byte
		for {
			n, err := pr.Read(buf)
			if n > 0 {
				pending = append(pending, buf[:n]...)
				for {
					idx := bytes.IndexByte(pending, '\n')
					if idx < 0 {
						break
					}
					line := strings.TrimRight(string(pending[:idx]), "\r")
					pending = pending[idx+1:]
					a.handleServerLine(sess.ID, line)
				}
			}
			if err != nil {
				if len(pending) > 0 {
					a.handleServerLine(sess.ID, strings.TrimSpace(string(pending)))
				}
				return
			}
		}
	}()
	if err := runner.Start(); err != nil {
		_ = a.sessions.Update(sess) // persist failure
		return nil, err
	}
	sess.PID = runner.PID()
	sess.Status = session.StatusRunning
	_ = a.sessions.Update(sess)

	a.mu.Lock()
	a.runners[sess.ID] = &activeRun{session: sess, runner: runner}
	a.mu.Unlock()

	// Watch for exit → mark crashed/stopped.
	go func() {
		<-runner.Exited()
		sess.Status = session.StatusCrashed
		_ = a.sessions.Update(sess)
		a.mu.Lock()
		delete(a.runners, sess.ID)
		a.mu.Unlock()
		a.hub.PublishLog(sess.ID, "WARN", "进程已退出")
	}()
	return sess, nil
}

// handleStop stops a running session (POST /api/sessions/{id}/stop).
func (a *App) handleStop(w http.ResponseWriter, r *http.Request) {
	id := r.PathValue("id")
	a.mu.Lock()
	ar, ok := a.runners[id]
	a.mu.Unlock()
	if !ok {
		// 会话可能已崩溃/退出（runner 已被崩溃监控清理）。幂等地把它标记为
		// 已停止，让前端能收起崩溃实例卡片。
		if s, found := a.sessions.Get(id); found && s.Status != session.StatusStopped {
			s.Status = session.StatusStopped
			now := time.Now().UTC().Format(time.RFC3339)
			s.EndTime = &now
			_ = a.sessions.Update(s)
			a.hub.PublishLog(id, "INFO", "实例已清理（进程已退出）")
			a.writeJSON(w, http.StatusOK, s)
			return
		}
		a.writeJSON(w, http.StatusNotFound, map[string]string{"error": "session not running"})
		return
	}
	ar.session.Status = session.StatusStopping
	_ = a.sessions.Update(ar.session)
	a.hub.PublishLog(id, "INFO", "正在停止实例…")
	go func() {
		if err := ar.runner.Stop(8 * time.Second); err != nil {
			a.hub.PublishLog(id, "ERROR", "停止失败: "+err.Error())
			return
		}
		ar.runner.Close()
		ar.session.Status = session.StatusStopped
		now := time.Now().UTC().Format(time.RFC3339)
		ar.session.EndTime = &now
		_ = a.sessions.Update(ar.session)
		a.mu.Lock()
		delete(a.runners, id)
		a.mu.Unlock()
		a.hub.PublishLog(id, "INFO", "实例已停止")
	}()
	a.writeJSON(w, http.StatusOK, ar.session)
}

// handleRestart stops and relaunches a session with its original params
// (POST /api/sessions/{id}/restart).
func (a *App) handleRestart(w http.ResponseWriter, r *http.Request) {
	id := r.PathValue("id")
	a.mu.Lock()
	ar, ok := a.runners[id]
	a.mu.Unlock()
	if !ok {
		// 已崩溃/退出的会话：清理旧记录后用保存的参数重新启动。
		s, found := a.sessions.Get(id)
		if !found {
			a.writeJSON(w, http.StatusNotFound, map[string]string{"error": "session not found"})
			return
		}
		a.hub.PublishLog(id, "INFO", "正在重启已退出的实例…")
		if s.Status != session.StatusStopped {
			s.Status = session.StatusStopped
			now := time.Now().UTC().Format(time.RFC3339)
			s.EndTime = &now
			_ = a.sessions.Update(s)
		}
		sess, err := a.launch(s.BundleID, s.Port, s.Params, false)
		if err != nil {
			a.writeJSON(w, http.StatusInternalServerError, map[string]string{"error": err.Error()})
			return
		}
		a.writeJSON(w, http.StatusOK, sess)
		return
	}
	bundleID := ar.session.BundleID
	port := ar.session.Port
	params := ar.session.Params
	a.hub.PublishLog(id, "INFO", "正在重启实例…")
	if err := ar.runner.Stop(15 * time.Second); err != nil {
		a.writeJSON(w, http.StatusInternalServerError, map[string]string{"error": "stop failed: " + err.Error()})
		return
	}
	ar.runner.Close()
	a.mu.Lock()
	delete(a.runners, id)
	a.mu.Unlock()

	// Wait a beat so the port is released before rebinding.
	time.Sleep(300 * time.Millisecond)
	sess, err := a.launch(bundleID, port, params, false)
	if err != nil {
		a.writeJSON(w, http.StatusInternalServerError, map[string]string{"error": err.Error()})
		return
	}
	a.writeJSON(w, http.StatusOK, sess)
}

// testRequest is the body of POST /api/test/batch.
type testRequest struct {
	BundleIDs []string       `json:"bundle_ids"`
	Prompt    string         `json:"prompt"`
	MaxTokens int            `json:"max_tokens"`
	Params    map[string]any `json:"params"`  // 测试参数覆盖（ctx/GPU层/线程/温度等）
	Repeats   int            `json:"repeats"` // 同一实例测量次数（0/1=单次）
	Warmup    bool           `json:"warmup"`  // 测量前预热
	Ctx       int            `json:"ctx"`     // 测试基础 ctx（0=默认 1024）
}

// ── 测试历史（持久化到 data/test_history.json）────────────────
type TestHistoryItem struct {
	Name   string  `json:"name"`
	Label  string  `json:"label,omitempty"`
	Status string  `json:"status"`
	LoadMS int64   `json:"load_ms"`
	TPS    float64 `json:"tps"`
	Tokens int     `json:"tokens"`
	Error  string  `json:"error,omitempty"`
}

type TestHistoryRecord struct {
	ID        string            `json:"id"`
	Time      string            `json:"time"`
	Type      string            `json:"type"` // batch | sweep
	Mode      string            `json:"mode,omitempty"`
	Model     string            `json:"model,omitempty"` // 扫描的目标模型
	Prompt    string            `json:"prompt"`
	MaxTokens int               `json:"max_tokens"`
	Summary   string            `json:"summary"`
	Items     []TestHistoryItem `json:"items"`
}

// testCacheEntry is a persisted result for one (model, params) fingerprint.
type testCacheEntry struct {
	Key      string  `json:"key"`
	TPS      float64 `json:"tps"`
	Tokens   int     `json:"tokens"`
	LoadMS   int64   `json:"load_ms"`
	PromptPS float64 `json:"prompt_ps"`
	PromptMS float64 `json:"prompt_ms"`
	EvalMS   float64 `json:"eval_ms"`
	Time     string  `json:"time"`
}

func (a *App) testCachePath() string { return filepath.Join(a.cfg.DataDir, "test_cache.json") }

func (a *App) loadTestCache() {
	data, err := os.ReadFile(a.testCachePath())
	if err != nil {
		return
	}
	var m map[string]testCacheEntry
	if json.Unmarshal(data, &m) == nil && m != nil {
		a.testCache = m
	}
}

func (a *App) saveTestCache() {
	a.mu.Lock()
	m := make(map[string]testCacheEntry, len(a.testCache))
	for k, v := range a.testCache {
		m[k] = v
	}
	a.mu.Unlock()
	data, _ := json.MarshalIndent(m, "", "  ")
	_ = os.WriteFile(a.testCachePath(), data, 0644)
}

// fileFingerprint returns a stable identity (size+mtime) of a model file so a
// changed model invalidates its cache entries.
func (a *App) fileFingerprint(path string) string {
	st, err := os.Stat(path)
	if err != nil {
		return "?"
	}
	return fmt.Sprintf("%d-%d", st.Size(), st.ModTime().Unix())
}

// testCacheKey builds the L2 fingerprint: model file identity + base ctx + all combo params.
func (a *App) testCacheKey(bundleID, fp string, baseCtx int, ov map[string]any) string {
	parts := []string{bundleID, fp, "ctx=" + strconv.Itoa(baseCtx)}
	var ks []string
	for k := range ov {
		ks = append(ks, k)
	}
	sort.Strings(ks)
	for _, k := range ks {
		parts = append(parts, k+"="+fmt.Sprintf("%v", ov[k]))
	}
	return strings.Join(parts, "|")
}

func (a *App) testCacheGet(bundleID, fp string, baseCtx int, ov map[string]any) (sweepResult, bool) {
	k := a.testCacheKey(bundleID, fp, baseCtx, ov)
	a.mu.Lock()
	defer a.mu.Unlock()
	e, ok := a.testCache[k]
	if !ok {
		return sweepResult{}, false
	}
	return sweepResult{
		Status: "ok", TPS: e.TPS, Tokens: e.Tokens, LoadMS: e.LoadMS,
		PromptPS: e.PromptPS, PromptMS: e.PromptMS, EvalMS: e.EvalMS, Cached: true,
	}, true
}

func (a *App) testCachePut(bundleID, fp string, baseCtx int, ov map[string]any, res testResult) {
	if res.Status != "ok" {
		return
	}
	k := a.testCacheKey(bundleID, fp, baseCtx, ov)
	a.mu.Lock()
	a.testCache[k] = testCacheEntry{
		Key: k, TPS: res.TPS, Tokens: res.Tokens, LoadMS: res.LoadMS,
		PromptPS: res.PromptPS, PromptMS: res.PromptMS, EvalMS: res.EvalMS,
		Time: time.Now().Format("2006-01-02 15:04:05"),
	}
	a.mu.Unlock()
	a.saveTestCache()
}

func (a *App) loadTestHistory() {
	data, err := os.ReadFile(filepath.Join(a.cfg.DataDir, "test_history.json"))
	if err != nil {
		return
	}
	var list []TestHistoryRecord
	if json.Unmarshal(data, &list) == nil {
		a.testHistory = list
	}
}

func (a *App) saveTestHistory(list []TestHistoryRecord) {
	data, _ := json.MarshalIndent(list, "", "  ")
	_ = os.WriteFile(filepath.Join(a.cfg.DataDir, "test_history.json"), data, 0644)
}

func (a *App) appendTestHistory(rec TestHistoryRecord) {
	a.mu.Lock()
	a.testHistory = append([]TestHistoryRecord{rec}, a.testHistory...)
	if len(a.testHistory) > 50 {
		a.testHistory = a.testHistory[:50]
	}
	copyList := make([]TestHistoryRecord, len(a.testHistory))
	copy(copyList, a.testHistory)
	a.mu.Unlock()
	a.saveTestHistory(copyList)
}

func (a *App) bundleName(id string) string {
	if b, ok := a.bundles.Get(id); ok {
		return b.Name
	}
	return id
}

// recordBatchHistory stores a summary of a batch test run.
func (a *App) recordBatchHistory(req testRequest, results []testResult) {
	items := make([]TestHistoryItem, 0, len(results))
	bestTPS, bestName, okCount := 0.0, "", 0
	for _, r := range results {
		items = append(items, TestHistoryItem{Name: r.Name, Status: r.Status, LoadMS: r.LoadMS, TPS: r.TPS, Tokens: r.Tokens, Error: r.Error})
		if r.Status == "ok" && r.TPS > bestTPS {
			bestTPS, bestName = r.TPS, r.Name
		}
		if r.Status == "ok" {
			okCount++
		}
	}
	summary := fmt.Sprintf("%d 个模型 · ✅ %d 通过", len(results), okCount)
	if bestName != "" {
		summary += fmt.Sprintf(" · 最快 %s %.1f tok/s", bestName, bestTPS)
	}
	a.appendTestHistory(TestHistoryRecord{
		ID:        "h" + strconv.FormatInt(time.Now().UnixNano(), 36),
		Time:      time.Now().Format("2006-01-02 15:04:05"),
		Type:      "batch",
		Prompt:    req.Prompt,
		MaxTokens: req.MaxTokens,
		Summary:   summary,
		Items:     items,
	})
}

// recordSweepHistory stores a summary of a parameter sweep run.
func (a *App) recordSweepHistory(modelName string, req sweepRequest, mode string, results []sweepResult) {
	items := make([]TestHistoryItem, 0, len(results))
	bestTPS, bestLabel, okCount := 0.0, "", 0
	for _, r := range results {
		items = append(items, TestHistoryItem{Name: r.Label, Status: r.Status, LoadMS: r.LoadMS, TPS: r.TPS, Tokens: r.Tokens, Error: r.Error})
		if r.Status == "ok" && r.TPS > bestTPS {
			bestTPS, bestLabel = r.TPS, r.Label
		}
		if r.Status == "ok" {
			okCount++
		}
	}
	summary := fmt.Sprintf("共测 %d 次 · ✅ %d 成功", len(results), okCount)
	if bestLabel != "" {
		summary += fmt.Sprintf(" · 最佳 %s（%.1f tok/s）", bestLabel, bestTPS)
	}
	a.appendTestHistory(TestHistoryRecord{
		ID:        "h" + strconv.FormatInt(time.Now().UnixNano(), 36),
		Time:      time.Now().Format("2006-01-02 15:04:05"),
		Type:      "sweep",
		Mode:      mode,
		Model:     modelName,
		Prompt:    req.Prompt,
		MaxTokens: req.MaxTokens,
		Summary:   summary,
		Items:     items,
	})
}

// testJobCancelled reports whether a test job has been asked to abort.
func (a *App) testJobCancelled(jobID string) bool {
	a.mu.Lock()
	defer a.mu.Unlock()
	return a.testCancel[jobID]
}

// handleTestCancel marks a running test/sweep job for cancellation.
func (a *App) handleTestCancel(w http.ResponseWriter, r *http.Request) {
	var body struct {
		JobID string `json:"job_id"`
	}
	if err := json.NewDecoder(r.Body).Decode(&body); err != nil {
		a.writeJSON(w, http.StatusBadRequest, map[string]string{"error": err.Error()})
		return
	}
	a.mu.Lock()
	a.testCancel[body.JobID] = true
	a.mu.Unlock()
	a.writeJSON(w, http.StatusOK, map[string]any{"ok": true})
}

// handleTestHistory returns the persisted test history (newest first).
func (a *App) handleTestHistory(w http.ResponseWriter, r *http.Request) {
	a.mu.Lock()
	list := make([]TestHistoryRecord, len(a.testHistory))
	copy(list, a.testHistory)
	a.mu.Unlock()
	a.writeJSON(w, http.StatusOK, map[string]any{"records": list})
}

// handleTestHistoryClear wipes all persisted test history.
func (a *App) handleTestHistoryClear(w http.ResponseWriter, r *http.Request) {
	a.mu.Lock()
	a.testHistory = nil
	a.mu.Unlock()
	a.saveTestHistory(nil)
	a.writeJSON(w, http.StatusOK, map[string]any{"ok": true})
}

// testResult is one model's batch-test outcome.
type testResult struct {
	BundleID string       `json:"bundle_id"`
	Name     string       `json:"name"`
	Status   string       `json:"status"` // ok | fail
	LoadMS   int64        `json:"load_ms"`
	TPS      float64      `json:"tps"`
	Tokens   int          `json:"tokens"`
	PromptPS float64      `json:"prompt_ps,omitempty"` // prompt 吞吐 tok/s
	PromptMS float64      `json:"prompt_ms,omitempty"` // 首 token（prompt eval）耗时 ms
	EvalMS   float64      `json:"eval_ms,omitempty"`   // eval 总耗时 ms
	Repeats  int          `json:"repeats,omitempty"`   // 实际测量次数
	VRAMGB   float64      `json:"vram_gb,omitempty"`   // 该配置估算显存（GB，用于帕累托/雷达图）
	Audit    []paramAudit `json:"audit,omitempty"`     // 参数审计：请求 vs 实际生效
	Error    string       `json:"error,omitempty"`
}

// paramAudit compares a requested parameter with the value that actually took
// effect in the launched server (parsed back from the real CLI args).
type paramAudit struct {
	Key       string `json:"key"`
	Label     string `json:"label"`
	Requested string `json:"requested"`
	Effective string `json:"effective"`
	Same      bool   `json:"same"`
	Note      string `json:"note,omitempty"`
}

// handleTestBatch launches each selected model in turn, sends a short test
// chat, records load time / throughput and tears the instance down. Progress
// is streamed over WebSocket ({type:test_progress, type:test_done}).
func (a *App) handleTestBatch(w http.ResponseWriter, r *http.Request) {
	var req testRequest
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		a.writeJSON(w, http.StatusBadRequest, map[string]string{"error": err.Error()})
		return
	}
	if len(req.BundleIDs) == 0 {
		a.writeJSON(w, http.StatusBadRequest, map[string]string{"error": "至少选择一个模型"})
		return
	}
	if req.Prompt == "" {
		req.Prompt = "你好，用一句话介绍你自己"
	}
	if req.MaxTokens <= 0 || req.MaxTokens > 512 {
		req.MaxTokens = 16
	}
	jobID := fmt.Sprintf("test_%d", time.Now().UnixNano())
	a.writeJSON(w, http.StatusOK, map[string]any{"job_id": jobID})

	go func() {
		defer func() {
			a.mu.Lock()
			delete(a.testCancel, jobID)
			a.mu.Unlock()
		}()
		opts := &testRunOpts{Repeats: req.Repeats, Warmup: req.Warmup, Ctx: req.Ctx}
		// 显存感知并行：估算各模型显存，按可用显存贪心分批，组内并行、组间串行
		groups := a.parallelGroups(req.BundleIDs, opts)
		results := make([]testResult, len(req.BundleIDs))
		for _, g := range groups {
			if a.testJobCancelled(jobID) {
				break
			}
			var wg sync.WaitGroup
			for _, idx := range g {
				wg.Add(1)
				go func(idx int) {
					defer wg.Done()
					bid := req.BundleIDs[idx]
					// 每个 goroutine 独立的阶段回调（避免共享 opts 竞态）
					goOpts := *opts
					goOpts.OnStage = func(stage string) {
						data, _ := json.Marshal(map[string]any{
							"type": "test_progress", "job_id": jobID, "stage": stage,
							"index": idx, "total": len(req.BundleIDs), "bundle_id": bid,
						})
						a.hub.Broadcast(data)
					}
					res := a.runOneTest(bid, req.Prompt, req.MaxTokens, req.Params, &goOpts,
						func() bool { return a.testJobCancelled(jobID) })
					results[idx] = res
					data, _ := json.Marshal(map[string]any{
						"type": "test_progress", "job_id": jobID,
						"index": idx, "total": len(req.BundleIDs),
						"bundle_id": res.BundleID, "name": res.Name, "status": res.Status,
						"load_ms": res.LoadMS, "tps": res.TPS, "tokens": res.Tokens, "error": res.Error,
						"vram_gb": res.VRAMGB, "audit": res.Audit,
					})
					a.hub.Broadcast(data)
				}(idx)
			}
			wg.Wait()
		}
		// 汇总（跳过因取消未测的）
		final := make([]testResult, 0, len(req.BundleIDs))
		for _, r := range results {
			if r.BundleID != "" {
				final = append(final, r)
			}
		}
		a.recordBatchHistory(req, final)
		done, _ := json.Marshal(map[string]any{
			"type": "test_done", "job_id": jobID, "results": final,
			"cancelled": a.testJobCancelled(jobID),
		})
		a.hub.Broadcast(done)
	}()
}

// modelSpecFor builds a config.ModelSpec for VRAM estimation from a bundle.
func (a *App) modelSpecFor(b *bundle.Bundle) config.ModelSpec {
	spec := config.ModelSpec{
		FileSizeMB:   b.BaseModel.FileSizeMB,
		MMProjSizeMB: b.MMProj.FileSizeMB,
	}
	if m := b.BaseModel.Metadata; m != nil {
		spec.BlockCount = m.BlockCount
		spec.ContextLength = m.ContextLength
		spec.HeadCountKV = m.HeadCountKV
		spec.EmbeddingLength = m.EmbeddingLength
		spec.Architecture = m.Architecture
		spec.NumExperts = m.NumExperts
		spec.IsMoE = m.IsMoE()
	}
	return spec
}

// modelVRAMGB estimates a bundle's GPU memory (GB) under the test conditions.
func (a *App) modelVRAMGB(bundleID string, opts *testRunOpts) float64 {
	b, ok := a.bundles.Get(bundleID)
	if !ok {
		return 0
	}
	ngl := b.DefaultParams.NGPULayers
	ctx := 1024
	if opts != nil && opts.Ctx > 0 {
		ctx = opts.Ctx
	}
	return config.EstimateVRAMEx(a.modelSpecFor(b), ngl, ctx, a.hw, "f16", "f16", false)
}

// parallelGroups splits model indexes into batches that fit the free VRAM
// budget (greedy), so models within one batch test concurrently.
func (a *App) parallelGroups(ids []string, opts *testRunOpts) [][]int {
	budget := 0.0
	if a.hw != nil && a.hw.FreeVRAMMB > 0 {
		budget = float64(a.hw.FreeVRAMMB) / 1024.0 * 0.8
	}
	type item struct {
		idx int
		v   float64
	}
	var items []item
	for i, id := range ids {
		items = append(items, item{idx: i, v: a.modelVRAMGB(id, opts)})
	}
	var groups [][]int
	var cur []int
	curSum := 0.0
	for _, it := range items {
		if budget <= 0 || it.v <= 0 {
			// 无法估算显存 → 保守：单个一组（串行）
			groups = append(groups, []int{it.idx})
			continue
		}
		if len(cur) > 0 && curSum+it.v > budget {
			groups = append(groups, cur)
			cur = nil
			curSum = 0
		}
		cur = append(cur, it.idx)
		curSum += it.v
	}
	if len(cur) > 0 {
		groups = append(groups, cur)
	}
	return groups
}

// testRunOpts tunes how a single test run is measured.
type testRunOpts struct {
	Repeats int  // 同一实例内测量次数（0/1=单次；>1 取平均，更稳）
	Warmup  bool // 正式测量前先发一次小请求预热（首请求通常偏慢）
	Ctx     int  // 测试基础 ctx（0=默认 1024）
	// OnStage 上报 6 阶段状态机（validating→auditing→warming_up→benchmarking→cleaning）。
	// 调用方（batch/sweep）把它接到 WebSocket 广播上。
	OnStage func(stage string)
}

// chatTiming captures per-request timings reported by llama-server.
type chatTiming struct {
	TPS      float64 // 生成吞吐 predicted_per_second
	Tokens   int     // completion_tokens
	PromptPS float64 // prompt 吞吐 prompt_per_second
	PromptMS float64 // 首 token（prompt eval）耗时 ms
	EvalMS   float64 // eval 总耗时 ms
}

// flagKeyIndex maps every CLI flag (long & short) back to its registry key.
func (a *App) flagKeyIndex() map[string]string {
	m := make(map[string]string, 420)
	for _, d := range a.registry.All() {
		if d.LongFlag != "" {
			m[d.LongFlag] = d.Key
		}
		if d.Flag != "" {
			m[d.Flag] = d.Key
		}
	}
	return m
}

// isNumericArg tells whether an arg like "-1" is a negative number (a value),
// not a flag.
func isNumericArg(s string) bool {
	if len(s) < 2 || s[0] != '-' {
		return false
	}
	for i := 1; i < len(s); i++ {
		c := s[i]
		if c < '0' || c > '9' {
			if c == '.' && i > 1 {
				continue
			}
			return false
		}
	}
	return true
}

// parseEffectiveArgs parses the real CLI args back into a registry-key map so
// we can audit which requested parameters actually took effect.
func parseEffectiveArgs(args []string, flagKeys map[string]string, reg *config.Registry) map[string]any {
	eff := map[string]any{}
	for i := 0; i < len(args); i++ {
		arg := args[i]
		var flag, inline string
		if strings.HasPrefix(arg, "--") {
			if eq := strings.Index(arg, "="); eq >= 0 {
				flag, inline = arg[:eq], arg[eq+1:]
			} else {
				flag = arg
			}
		} else if strings.HasPrefix(arg, "-") && !isNumericArg(arg) {
			flag = arg
		} else {
			continue
		}
		key, ok := flagKeys[flag]
		if !ok {
			continue
		}
		pd, _ := reg.Get(key)
		if inline != "" {
			eff[key] = inline
		} else if pd != nil && !pd.RequiresValue {
			eff[key] = true
		} else if i+1 < len(args) {
			eff[key] = args[i+1]
			i++
		}
	}
	return eff
}

// fmtParamVal renders a requested/effective value for the audit table.
func fmtParamVal(v any) string {
	switch t := v.(type) {
	case bool:
		if t {
			return "on"
		}
		return "off"
	case float64:
		return strconv.FormatFloat(t, 'f', -1, 64)
	case float32:
		return strconv.FormatFloat(float64(t), 'f', -1, 32)
	case nil:
		return ""
	default:
		return fmt.Sprint(v)
	}
}

// auditParams compares the requested params against what actually took effect
// (parsed back from the real CLI args) so the user can verify a scan really
// applied (e.g. --ctx-size / --n-gpu-layers were honored).
func (a *App) auditParams(req map[string]any, args []string) []paramAudit {
	flagKeys := a.flagKeyIndex()
	eff := parseEffectiveArgs(args, flagKeys, a.registry)
	// 跳过与测量无关的固定项
	skip := map[string]bool{"model": true, "port": true, "host": true, "metrics": true, "mmproj": true, "api_key": true}
	keys := make([]string, 0, len(req))
	for k := range req {
		if skip[k] {
			continue
		}
		keys = append(keys, k)
	}
	sort.Strings(keys)
	out := make([]paramAudit, 0, len(keys))
	for _, k := range keys {
		rq := fmtParamVal(req[k])
		ev, ok := eff[k]
		effStr := ""
		if ok {
			effStr = fmtParamVal(ev)
		}
		pa := paramAudit{Key: k, Requested: rq, Effective: effStr, Same: ok && effStr == rq}
		if pd, ok := a.registry.Get(k); ok {
			pa.Label = pd.Label
		}
		if !ok {
			pa.Note = "未在命令行中生效（被忽略或模型默认覆盖）"
		} else if pa.Same {
			pa.Note = "已生效"
		} else {
			pa.Note = "实际值被调整（自动合并）"
		}
		out = append(out, pa)
	}
	return out
}

// paramsVRAMGB estimates VRAM (GB) for a merged params map.
func (a *App) paramsVRAMGB(bundleID string, params map[string]any) float64 {
	b, ok := a.bundles.Get(bundleID)
	if !ok {
		return 0
	}
	ngl := b.DefaultParams.NGPULayers
	if v, ok := params["n_gpu_layers"].(int); ok {
		ngl = v
	}
	ctx := 1024
	if v, ok := params["ctx_size"].(int); ok {
		ctx = v
	}
	kvK, kvV := "f16", "f16"
	if v, ok := params["cache_type_k"].(string); ok {
		kvK = v
	}
	if v, ok := params["cache_type_v"].(string); ok {
		kvV = v
	}
	mmprojCPU := false
	if v, ok := params["no_mmproj_offload"].(bool); ok {
		mmprojCPU = v
	}
	return config.EstimateVRAMEx(a.modelSpecFor(b), ngl, ctx, a.hw, kvK, kvV, mmprojCPU)
}

// comboVRAMGB estimates VRAM (GB) for one sweep override map (帕累托图 X 轴).
func (a *App) comboVRAMGB(bundleID string, baseCtx int, ov map[string]any) float64 {
	b, ok := a.bundles.Get(bundleID)
	if !ok {
		return 0
	}
	ngl := b.DefaultParams.NGPULayers
	if v, ok := ov["n_gpu_layers"].(int); ok {
		ngl = v
	}
	ctx := baseCtx
	if v, ok := ov["ctx_size"].(int); ok {
		ctx = v
	}
	kvK, kvV := "f16", "f16"
	if v, ok := ov["cache_type_k"].(string); ok {
		kvK = v
	}
	if v, ok := ov["cache_type_v"].(string); ok {
		kvV = v
	}
	mmprojCPU := false
	if v, ok := ov["no_mmproj_offload"].(bool); ok {
		mmprojCPU = v
	}
	return config.EstimateVRAMEx(a.modelSpecFor(b), ngl, ctx, a.hw, kvK, kvV, mmprojCPU)
}

// runOneTest loads a model, waits for health, sends a short chat and stops it.
func (a *App) runOneTest(bundleID, prompt string, maxTokens int, overrides map[string]any, opts *testRunOpts, isCancelled func() bool) testResult {
	return a.runOneTestCore(bundleID, prompt, maxTokens, overrides, opts, isCancelled)
}

// runOneTestCore is the shared test runner. overrides are applied on top of
// the standard test parameter set (used by both model batch tests and the
// parameter sweep so both measure under identical conditions). opts tunes
// repeat/warmup measurement. isCancelled is polled during the (potentially
// long) model-load wait so a user can abort.
func (a *App) runOneTestCore(bundleID, prompt string, maxTokens int, overrides map[string]any, opts *testRunOpts, isCancelled func() bool) testResult {
	res := testResult{BundleID: bundleID}
	b, ok := a.bundles.Get(bundleID)
	if !ok {
		res.Status = "fail"
		res.Error = "模型不存在"
		return res
	}
	res.Name = b.Name
	// 6 阶段状态机：validating → auditing → warming_up → benchmarking → cleaning
	stage := func(s string) {
		if opts != nil && opts.OnStage != nil {
			opts.OnStage(s)
		}
	}
	stage("validating")
	port := a.findFreePort(9300)
	baseCtx := 1024
	if opts != nil && opts.Ctx > 0 {
		baseCtx = opts.Ctx
	}
	params := map[string]any{
		"ctx_size":     baseCtx,
		"predict":      maxTokens,
		"temperature":  0.1,
		"n_gpu_layers": b.DefaultParams.NGPULayers,
		"flash_attn":   "on",
		"load_mode":    "mmap",
		"threads":      0,
		"cache_type_k": "f16",
		"cache_type_v": "f16",
	}
	for k, v := range overrides {
		if v == nil {
			continue
		}
		params[k] = v
	}
	a.hub.PublishLog(bundleID, "INFO",
		fmt.Sprintf("🧪 [%s] 启动测试 (端口 %d)", b.Name, port))
	sess, err := a.launch(bundleID, port, params, true)
	if err != nil {
		res.Status = "fail"
		res.Error = err.Error()
		return res
	}
	// 资源兜底：无论成功/失败/取消，最终都确保回收进程并清除 OOM 标志与端口占用
	defer func() {
		a.stopRunner(sess.ID)
		a.testPortMu.Lock()
		delete(a.testPorts, port)
		a.testPortMu.Unlock()
		a.mu.Lock()
		delete(a.testOOM, sess.ID)
		a.mu.Unlock()
	}()
	// 参数审计：对比请求参数 vs 命令行实际生效参数（含模型默认合并）
	stage("auditing")
	res.VRAMGB = a.paramsVRAMGB(bundleID, params)
	res.Audit = a.auditParams(params, sess.CmdlineArgs)
	// Wait for /health (model loaded) with a generous timeout; abort if the
	// process crashes meanwhile.
	start := time.Now()
	healthy := false
	for {
		if isCancelled != nil && isCancelled() {
			res.Status = "fail"
			res.Error = "测试已取消"
			return res
		}
		// OOM 熔断：检测到显存不足立即中止
		if a.testOOMHit(sess.ID) {
			res.Status = "fail"
			res.Error = "显存不足（CUDA out of memory）"
			return res
		}
		if !a.isRunning(sess.ID) {
			break
		}
		resp, err := http.Get(fmt.Sprintf("http://127.0.0.1:%d/health", port))
		if err == nil {
			resp.Body.Close()
			if resp.StatusCode == http.StatusOK {
				healthy = true
				break
			}
		}
		if time.Since(start) > 240*time.Second {
			break
		}
		time.Sleep(2 * time.Second)
	}
	res.LoadMS = time.Since(start).Milliseconds()
	if !healthy {
		a.stopRunner(sess.ID)
		res.Status = "fail"
		// 附加 llama-server 真实日志尾部，让用户看到失败的具体原因
		// （如 mmproj 文件缺失、CUDA 显存不足、非法参数等），而不是笼统报超时。
		res.Error = "加载超时或进程退出（当前机器可能无法运行该模型）"
		if tail := a.sessionLogTail(sess.ID, 8); len(tail) > 0 {
			res.Error += "。最近日志：\n" + strings.Join(tail, "\n")
		}
		return res
	}
	// 预热（可选）：首请求通常含 CUDA/KV 初始化开销，先发一次小请求
	if opts != nil && opts.Warmup {
		stage("warming_up")
		_, _ = a.testChatTiming(port, "你好", 4)
	}
	// 正式测量：同一实例内重复 N 次取平均（不额外启动模型，只加推理时间）
	stage("benchmarking")
	repeats := 1
	if opts != nil && opts.Repeats > 1 {
		repeats = opts.Repeats
	}
	var sumTPS, sumPPS, sumPMS, sumEMS float64
	var lastTokens int
	okCount := 0
	var lastErr error
	for i := 0; i < repeats; i++ {
		ct, terr := a.testChatTiming(port, prompt, maxTokens)
		if terr != nil {
			lastErr = terr
			continue
		}
		sumTPS += ct.TPS
		sumPPS += ct.PromptPS
		sumPMS += ct.PromptMS
		sumEMS += ct.EvalMS
		lastTokens = ct.Tokens
		okCount++
	}
	stage("cleaning")
	a.stopRunner(sess.ID)
	if okCount == 0 {
		if lastErr == nil {
			lastErr = fmt.Errorf("测量失败")
		}
		res.Status = "fail"
		res.Error = lastErr.Error()
		return res
	}
	res.Status = "ok"
	res.TPS = sumTPS / float64(okCount)
	res.Tokens = lastTokens
	res.Repeats = okCount
	res.PromptPS = sumPPS / float64(okCount)
	res.PromptMS = sumPMS / float64(okCount)
	res.EvalMS = sumEMS / float64(okCount)
	return res
}

// ── 参数扫描（单模型 × 多参数组合）──────────────────────────
// sweepParamReq is one sweepable parameter with its candidate values.
type sweepParamReq struct {
	Key    string   `json:"key"`    // registry key, e.g. n_gpu_layers
	Values []string `json:"values"` // raw string values (empty entries skipped)
}

// sweepRequest is the body of POST /api/test/sweep.
type sweepRequest struct {
	ModelID   string          `json:"model_id"`
	Prompt    string          `json:"prompt"`
	MaxTokens int             `json:"max_tokens"`
	Mode      string          `json:"mode"` // exhaustive | greedy
	Params    []sweepParamReq `json:"params"`
	Repeats   int             `json:"repeats"`    // 同一实例测量次数
	Warmup    bool            `json:"warmup"`     // 测量前预热
	Ctx       int             `json:"ctx"`        // 测试基础 ctx（0=默认 1024）
	MaxCombos int             `json:"max_combos"` // 最大测试组合数（0=不限制；防呆）
}

// sweepResult is one parameter-combination outcome.
type sweepResult struct {
	Combo    int          `json:"combo"`
	Label    string       `json:"label"`           // e.g. "GPU层=0, ctx=512, 线程=8"
	Step     string       `json:"step,omitempty"`  // greedy 模式：当前优化步骤
	Fixed    string       `json:"fixed,omitempty"` // greedy 模式：固定参数摘要
	IsBest   bool         `json:"is_best,omitempty"`
	Status   string       `json:"status"` // ok | fail
	LoadMS   int64        `json:"load_ms"`
	TPS      float64      `json:"tps"`
	Tokens   int          `json:"tokens"`
	PromptPS float64      `json:"prompt_ps,omitempty"`
	PromptMS float64      `json:"prompt_ms,omitempty"`
	EvalMS   float64      `json:"eval_ms,omitempty"`
	Repeats  int          `json:"repeats,omitempty"`
	Cached   bool         `json:"cached,omitempty"`  // 该组合已测过，直接复用结果（未启动模型）
	VRAMGB   float64      `json:"vram_gb,omitempty"` // 估算显存（GB，帕累托图 X 轴）
	Audit    []paramAudit `json:"audit,omitempty"`   // 参数审计（仅真实测试时携带）
	Error    string       `json:"error,omitempty"`
}

// sweepShort maps registry keys to compact labels used in result rows.
var sweepShort = map[string]string{
	"n_gpu_layers": "GPU层", "main_gpu": "主GPU", "split_mode": "拆分",
	"ctx_size": "ctx", "threads": "线程", "threads_batch": "批线程",
	"batch_size": "batch", "ubatch_size": "ubatch",
	"cache_type_k": "K缓存", "cache_type_v": "V缓存",
	"rope_scaling": "rope", "flash_attn": "FA", "parallel": "槽位",
	"tensor_split": "tsplit",
	"load_mode":    "加载", "numa": "NUMA", "kv_unified": "统一KV",
	"cpu_moe": "MoE-CPU", "cache_ram": "缓存RAM", "ctx_checkpoints": "检查点",
	"checkpoint_min_step": "检查点间隔",
}

func shortSweepLabel(key string) string {
	if s, ok := sweepShort[key]; ok {
		return s
	}
	return key
}

// sweepInt extracts an int param value (0 when absent or not an int).
func sweepInt(m map[string]any, key string) int {
	if v, ok := m[key]; ok {
		if n, ok := v.(int); ok {
			return n
		}
	}
	return 0
}

// castSweepValue converts a raw string to the registry's typed value.
func castSweepValue(pd *config.ParamDef, raw string) (any, error) {
	switch pd.Kind {
	case config.KindInt, config.KindRange:
		n, err := strconv.Atoi(strings.TrimSpace(raw))
		if err != nil {
			return nil, fmt.Errorf("需要整数: %q", raw)
		}
		return n, nil
	case config.KindFloat:
		f, err := strconv.ParseFloat(strings.TrimSpace(raw), 64)
		if err != nil {
			return nil, fmt.Errorf("需要数字: %q", raw)
		}
		return f, nil
	case config.KindBool:
		switch strings.ToLower(strings.TrimSpace(raw)) {
		case "on", "true", "1", "yes", "开", "开启":
			return true, nil
		case "off", "false", "0", "no", "关", "关闭":
			return false, nil
		default:
			return nil, fmt.Errorf("需要 on/off 或 true/false: %q", raw)
		}
	default:
		return strings.TrimSpace(raw), nil
	}
}

// sweepCombos computes the cartesian product of all parameter values and
// returns the per-combo override maps plus human-readable labels.
func (a *App) sweepCombos(params []sweepParamReq) ([]map[string]any, []string, error) {
	type dim struct {
		key  string
		lbl  string
		vals []any
		strs []string
	}
	var dims []dim
	for _, p := range params {
		pd, ok := a.registry.Get(p.Key)
		if !ok {
			return nil, nil, fmt.Errorf("未知参数: %s", p.Key)
		}
		var d dim
		d.key = p.Key
		for _, raw := range p.Values {
			raw = strings.TrimSpace(raw)
			if raw == "" {
				continue
			}
			v, err := castSweepValue(pd, raw)
			if err != nil {
				return nil, nil, fmt.Errorf("%s: %v", p.Key, err)
			}
			d.vals = append(d.vals, v)
			d.strs = append(d.strs, raw)
		}
		if len(d.vals) == 0 {
			continue
		}
		d.lbl = shortSweepLabel(p.Key)
		dims = append(dims, d)
	}
	if len(dims) == 0 {
		return nil, nil, errors.New("请至少为一个参数填写数值")
	}
	total := 1
	for _, d := range dims {
		total *= len(d.vals)
	}
	if total > 512 {
		return nil, nil, fmt.Errorf("组合数 %d 超过上限 512，请减少参数值", total)
	}
	combos := make([]map[string]any, 0, total)
	labels := make([]string, 0, total)
	idx := make([]int, len(dims))
	for {
		ov := make(map[string]any, len(dims))
		parts := make([]string, 0, len(dims))
		for i, d := range dims {
			ov[d.key] = d.vals[idx[i]]
			parts = append(parts, fmt.Sprintf("%s=%s", d.lbl, d.strs[idx[i]]))
		}
		combos = append(combos, ov)
		labels = append(labels, strings.Join(parts, ", "))
		k := len(dims) - 1
		for k >= 0 {
			idx[k]++
			if idx[k] < len(dims[k].vals) {
				break
			}
			idx[k] = 0
			k--
		}
		if k < 0 {
			break
		}
	}
	return combos, labels, nil
}

// handleTestSweep tests one model across many parameter combinations and
// reports which config is fastest ({type:sweep_progress, type:sweep_done}).
func (a *App) handleTestSweep(w http.ResponseWriter, r *http.Request) {
	var req sweepRequest
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		a.writeJSON(w, http.StatusBadRequest, map[string]string{"error": err.Error()})
		return
	}
	if req.ModelID == "" {
		a.writeJSON(w, http.StatusBadRequest, map[string]string{"error": "请选择模型"})
		return
	}
	if req.Prompt == "" {
		req.Prompt = "你好，用一句话介绍你自己"
	}
	if req.MaxTokens <= 0 || req.MaxTokens > 512 {
		req.MaxTokens = 16
	}
	if req.Mode == "greedy" {
		a.runGreedySweep(w, req)
		return
	}
	combos, labels, err := a.sweepCombos(req.Params)
	if err != nil {
		a.writeJSON(w, http.StatusBadRequest, map[string]string{"error": err.Error()})
		return
	}
	// 预算控制（防呆）：用户设定了最大测试组合数则截断，杜绝无限扫描
	if req.MaxCombos > 0 && len(combos) > req.MaxCombos {
		combos = combos[:req.MaxCombos]
		labels = labels[:req.MaxCombos]
	}
	opts := &testRunOpts{Repeats: req.Repeats, Warmup: req.Warmup, Ctx: req.Ctx}
	jobID := fmt.Sprintf("sweep_%d", time.Now().UnixNano())
	a.writeJSON(w, http.StatusOK, map[string]any{"job_id": jobID, "total": len(combos)})

	go func() {
		defer func() {
			a.mu.Lock()
			delete(a.testCancel, jobID)
			a.mu.Unlock()
		}()
		modelFP := ""
		if b, ok := a.bundles.Get(req.ModelID); ok {
			modelFP = a.fileFingerprint(b.BaseModel.Path)
		}
		baseCtx := 1024
		if req.Ctx > 0 {
			baseCtx = req.Ctx
		}
		opts.OnStage = func(stage string) {
			data, _ := json.Marshal(map[string]any{
				"type": "sweep_progress", "job_id": jobID, "stage": stage,
			})
			a.hub.Broadcast(data)
		}
		results := make([]sweepResult, 0, len(combos))
		best, bestTPS := -1, 0.0
		for i, ov := range combos {
			if a.testJobCancelled(jobID) {
				break
			}
			var res testResult
			sr := sweepResult{Combo: i, Label: labels[i], Status: "skip"}
			sr.VRAMGB = a.comboVRAMGB(req.ModelID, baseCtx, ov)
			if l2, ok := a.testCacheGet(req.ModelID, modelFP, baseCtx, ov); ok {
				// L2 磁盘缓存命中（历史测过）→ 复用，不启动模型
				sr = l2
				sr.Combo = i
				sr.Label = labels[i]
				sr.VRAMGB = a.comboVRAMGB(req.ModelID, baseCtx, ov)
				res = testResult{Status: "ok", TPS: l2.TPS, Tokens: l2.Tokens, LoadMS: l2.LoadMS,
					PromptPS: l2.PromptPS, PromptMS: l2.PromptMS, EvalMS: l2.EvalMS}
			} else {
				res = a.runOneTestCore(req.ModelID, req.Prompt, req.MaxTokens, ov, opts,
					func() bool { return a.testJobCancelled(jobID) })
				sr = sweepResult{
					Combo: i, Label: labels[i], Status: res.Status,
					LoadMS: res.LoadMS, TPS: res.TPS, Tokens: res.Tokens, Error: res.Error,
					PromptPS: res.PromptPS, PromptMS: res.PromptMS, EvalMS: res.EvalMS, Repeats: res.Repeats,
					VRAMGB: res.VRAMGB, Audit: res.Audit,
				}
				a.testCachePut(req.ModelID, modelFP, baseCtx, ov, res)
			}
			if res.Status == "ok" && res.TPS > bestTPS {
				bestTPS = res.TPS
				best = i
			}
			results = append(results, sr)
			data, _ := json.Marshal(map[string]any{
				"type": "sweep_progress", "job_id": jobID,
				"combo": i, "total": len(combos),
				"label": sr.Label, "status": sr.Status,
				"load_ms": sr.LoadMS, "tps": sr.TPS, "tokens": sr.Tokens, "error": sr.Error,
				"prompt_ps": sr.PromptPS, "prompt_ms": sr.PromptMS, "eval_ms": sr.EvalMS, "repeats": sr.Repeats,
				"cached": sr.Cached, "vram_gb": sr.VRAMGB, "audit": sr.Audit,
			})
			a.hub.Broadcast(data)
		}
		a.recordSweepHistory(a.bundleName(req.ModelID), req, "exhaustive", results)
		doneMsg := map[string]any{
			"type": "sweep_done", "job_id": jobID,
			"results": results, "best": best,
			"cancelled": a.testJobCancelled(jobID),
		}
		if best >= 0 && best < len(combos) && best < len(results) && results[best].Status == "ok" {
			doneMsg["best_params"] = combos[best]
			doneMsg["best_meta"] = map[string]any{
				"mode": "exhaustive", "tps": results[best].TPS, "load_ms": results[best].LoadMS,
				"tokens": results[best].Tokens, "ctx_size": sweepInt(combos[best], "ctx_size"),
				"n_gpu_layers": sweepInt(combos[best], "n_gpu_layers"),
				"max_tokens":   req.MaxTokens, "prompt": req.Prompt,
			}
		}
		done, _ := json.Marshal(doneMsg)
		a.hub.Broadcast(done)
	}()
}

// sweepDim is one swept parameter with its cast candidate values (greedy 用).
type sweepDim struct {
	key, lbl string
	vals     []any
	strs     []string
}

// enumerateCombos iterates all cartesian combinations of dims (values already
// cast), merged with fixed, skipping duplicates by keyFn.
func (a *App) enumerateCombos(dims []sweepDim, fixed map[string]any, keyFn func(map[string]any) string, seen map[string]bool) []map[string]any {
	var out []map[string]any
	idx := make([]int, len(dims))
	for {
		ov := make(map[string]any, len(dims)+len(fixed))
		for k, v := range fixed {
			ov[k] = v
		}
		for i, d := range dims {
			ov[d.key] = d.vals[idx[i]]
		}
		k := keyFn(ov)
		if !seen[k] {
			seen[k] = true
			out = append(out, ov)
		}
		j := len(dims) - 1
		for j >= 0 {
			idx[j]++
			if idx[j] < len(dims[j].vals) {
				break
			}
			idx[j] = 0
			j--
		}
		if j < 0 {
			break
		}
	}
	return out
}

// runGreedySweep optimizes parameters as a whole (not one-at-a-time): it first
// explores the parameter space with a stratified random sample, then refines
// the best few starting points with coordinate descent (adopting only
// improvements above a threshold), and finally confirms the global best.
func (a *App) runGreedySweep(w http.ResponseWriter, req sweepRequest) {
	var dims []sweepDim
	fixed := map[string]any{}
	var fixedStrs []string
	for _, p := range req.Params {
		pd, ok := a.registry.Get(p.Key)
		if !ok {
			a.writeJSON(w, http.StatusBadRequest, map[string]string{"error": "未知参数: " + p.Key})
			return
		}
		var vals []any
		var strs []string
		for _, raw := range p.Values {
			raw = strings.TrimSpace(raw)
			if raw == "" {
				continue
			}
			v, err := castSweepValue(pd, raw)
			if err != nil {
				a.writeJSON(w, http.StatusBadRequest, map[string]string{"error": p.Key + ": " + err.Error()})
				return
			}
			vals = append(vals, v)
			strs = append(strs, raw)
		}
		if len(vals) == 0 {
			continue
		}
		if len(vals) == 1 {
			fixed[p.Key] = vals[0]
			fixedStrs = append(fixedStrs, shortSweepLabel(p.Key)+"="+strs[0])
		} else {
			dims = append(dims, sweepDim{key: p.Key, lbl: shortSweepLabel(p.Key), vals: vals, strs: strs})
		}
	}
	if len(dims) == 0 {
		a.writeJSON(w, http.StatusBadRequest, map[string]string{"error": "智能寻优需要至少一个参数填多个值"})
		return
	}
	// 整体寻优算法参数：先全局探索再多起点精调，改进超过阈值才采纳
	const (
		exploreN      = 20   // 全局探索采样组合数（覆盖参数空间找好区域）
		refineTopK    = 2    // 从探索结果取最优的 K 个起点做局部精调
		refineRounds  = 2    // 每个起点最多精调轮数
		improveThresh = 0.05 // 相对改进阈值：提升 <5% 不采纳（避免无意义微调）
	)
	// 估算测试总数（用于前端进度条；实际可能略少）
	totalCombos := 1
	maxDimVals := 0
	for _, d := range dims {
		totalCombos *= len(d.vals)
		if len(d.vals) > maxDimVals {
			maxDimVals = len(d.vals)
		}
	}
	explore := exploreN
	if totalCombos < explore {
		explore = totalCombos
	}
	totalTests := explore + refineTopK*refineRounds*maxDimVals*len(dims) + 2
	jobID := fmt.Sprintf("sweep_%d", time.Now().UnixNano())
	a.writeJSON(w, http.StatusOK, map[string]any{"job_id": jobID, "total": totalTests, "mode": "greedy"})

	go func() {
		defer func() {
			a.mu.Lock()
			delete(a.testCancel, jobID)
			a.mu.Unlock()
		}()
		opts := &testRunOpts{Repeats: req.Repeats, Warmup: req.Warmup, Ctx: req.Ctx}
		opts.OnStage = func(stage string) {
			data, _ := json.Marshal(map[string]any{
				"type": "sweep_progress", "job_id": jobID, "mode": "greedy", "stage": stage,
			})
			a.hub.Broadcast(data)
		}
		modelFP := ""
		if b, ok := a.bundles.Get(req.ModelID); ok {
			modelFP = a.fileFingerprint(b.BaseModel.Path)
		}
		baseCtx := 1024
		if req.Ctx > 0 {
			baseCtx = req.Ctx
		}
		results := make([]sweepResult, 0, totalTests)
		combo := 0

		// 工具：合并 fixed 的基础参数副本
		cloneBase := func() map[string]any {
			ov := make(map[string]any, len(fixed)+len(dims))
			for k, v := range fixed {
				ov[k] = v
			}
			return ov
		}
		// 工具：参数组合 → 去重键（相同组合只测一次，其余复用缓存结果，避免重复测试浪费时间）
		keyOf := func(ov map[string]any) string {
			var ks []string
			for k := range ov {
				ks = append(ks, k)
			}
			sort.Strings(ks)
			parts := make([]string, 0, len(ks))
			for _, k := range ks {
				parts = append(parts, k+"="+fmt.Sprintf("%v", ov[k]))
			}
			return strings.Join(parts, "|")
		}
		resultCache := map[string]sweepResult{} // 已测组合缓存
		testedCount := 0                        // 真实启动模型的次数（其余为缓存复用）
		var bestGlobal map[string]any           // 全局最优配置
		bestGlobalTPS := 0.0
		abortEarly := false       // 预算/连续无提升 → 提前终止
		noImproveStreak := 0      // 连续真实测试无提升计数
		const noImproveLimit = 10 // 连续 N 次无提升提前终止（防呆）
		// 工具：参数组合 → 可读 label
		comboLabel := func(ov map[string]any) string {
			parts := make([]string, 0, len(fixedStrs)+len(dims))
			parts = append(parts, fixedStrs...)
			keys := make([]string, 0, len(dims))
			for _, d := range dims {
				keys = append(keys, d.key)
			}
			sort.Strings(keys)
			for _, k := range keys {
				for _, d := range dims {
					if d.key != k {
						continue
					}
					for i, v := range d.vals {
						if fmt.Sprintf("%v", v) == fmt.Sprintf("%v", ov[k]) {
							parts = append(parts, d.lbl+"="+d.strs[i])
							break
						}
					}
					break
				}
			}
			return strings.Join(parts, ", ")
		}
		// 工具：运行一次并广播进度（相同组合自动复用缓存，不重复启动模型）
		runOne := func(ov map[string]any, step string) (testResult, sweepResult) {
			k := keyOf(ov)
			var sr sweepResult
			sr.VRAMGB = a.comboVRAMGB(req.ModelID, baseCtx, ov)
			res := testResult{BundleID: req.ModelID, Name: a.bundleName(req.ModelID)}
			if c, ok := resultCache[k]; ok {
				// 该组合已测过 → 直接复用结果，不再启动模型
				sr = c
				sr.Cached = true
				sr.Step = step
				sr.Combo = combo
				sr.Label = comboLabel(ov)
				res = testResult{Status: sr.Status, TPS: sr.TPS, Tokens: sr.Tokens, LoadMS: sr.LoadMS,
					PromptPS: sr.PromptPS, PromptMS: sr.PromptMS, EvalMS: sr.EvalMS, Repeats: sr.Repeats}
			} else if l2, ok := a.testCacheGet(req.ModelID, modelFP, baseCtx, ov); ok {
				// L2 磁盘缓存命中（历史测过）→ 复用，不启动模型
				sr = l2
				sr.Cached = true
				sr.Step = step
				sr.Combo = combo
				sr.Label = comboLabel(ov)
				sr.Fixed = strings.Join(fixedStrs, ", ")
				res = testResult{Status: "ok", TPS: l2.TPS, Tokens: l2.Tokens, LoadMS: l2.LoadMS,
					PromptPS: l2.PromptPS, PromptMS: l2.PromptMS, EvalMS: l2.EvalMS}
				resultCache[k] = sr
			} else if req.MaxCombos > 0 && testedCount >= req.MaxCombos {
				// 预算硬上限：不启动新模型，标记跳过（防呆）
				sr = sweepResult{Combo: combo, Label: comboLabel(ov), Step: step,
					Fixed: strings.Join(fixedStrs, ", "), Status: "skip", Error: "已超出最大测试次数，跳过", Cached: true}
			} else {
				res = a.runOneTestCore(req.ModelID, req.Prompt, req.MaxTokens, ov, opts,
					func() bool { return a.testJobCancelled(jobID) })
				sr = sweepResult{
					Combo: combo, Label: comboLabel(ov), Step: step,
					Fixed:  strings.Join(fixedStrs, ", "),
					Status: res.Status, LoadMS: res.LoadMS, TPS: res.TPS, Tokens: res.Tokens, Error: res.Error,
					PromptPS: res.PromptPS, PromptMS: res.PromptMS, EvalMS: res.EvalMS, Repeats: res.Repeats,
					VRAMGB: res.VRAMGB, Audit: res.Audit,
				}
				resultCache[k] = sr
				testedCount++
				a.testCachePut(req.ModelID, modelFP, baseCtx, ov, res)
				// 全局最优跟踪 + 连续无提升提前终止（仅真实测试计数）
				if res.Status == "ok" {
					if res.TPS > bestGlobalTPS {
						bestGlobalTPS = res.TPS
						bestGlobal = ov
						noImproveStreak = 0
					} else {
						noImproveStreak++
						if noImproveStreak >= noImproveLimit {
							abortEarly = true
						}
					}
				}
			}
			results = append(results, sr)
			data, _ := json.Marshal(map[string]any{
				"type": "sweep_progress", "job_id": jobID, "mode": "greedy",
				"combo": combo, "total": totalTests,
				"label": sr.Label, "step": sr.Step, "fixed": sr.Fixed,
				"status": sr.Status, "load_ms": sr.LoadMS,
				"tps": sr.TPS, "tokens": sr.Tokens, "error": sr.Error,
				"prompt_ps": sr.PromptPS, "prompt_ms": sr.PromptMS, "eval_ms": sr.EvalMS, "repeats": sr.Repeats,
				"cached": sr.Cached, "vram_gb": sr.VRAMGB, "audit": sr.Audit,
			})
			a.hub.Broadcast(data)
			combo++
			return res, sr
		}

		// ── Phase 1：全局探索（分层随机采样覆盖参数空间）────────
		type cand struct {
			params map[string]any
			tps    float64
		}
		var explored []cand
		{
			var sampled []map[string]any
			seen := map[string]bool{}
			add := func(ov map[string]any) {
				k := keyOf(ov)
				if !seen[k] {
					seen[k] = true
					sampled = append(sampled, ov)
				}
			}
			if totalCombos <= explore {
				// 组合不多 → 直接穷举全覆盖
				sampled = a.enumerateCombos(dims, fixed, keyOf, seen)
			} else {
				// 分层：每个参数每个档位至少出现一次，再随机补充
				for _, d := range dims {
					for _, v := range d.vals {
						ov := cloneBase()
						for _, d2 := range dims {
							if d2.key != d.key {
								ov[d2.key] = d2.vals[rand.IntN(len(d2.vals))]
							}
						}
						ov[d.key] = v
						add(ov)
					}
				}
				for len(sampled) < explore && len(seen) < totalCombos {
					ov := cloneBase()
					for _, d := range dims {
						ov[d.key] = d.vals[rand.IntN(len(d.vals))]
					}
					add(ov)
				}
			}
			for _, ov := range sampled {
				if a.testJobCancelled(jobID) || abortEarly {
					break
				}
				res, _ := runOne(ov, "🌐 全局探索")
				if res.Status == "ok" {
					explored = append(explored, cand{params: ov, tps: res.TPS})
				}
			}
		}

		// ── Phase 2：多起点局部精调（坐标下降 + 改进阈值）────────
		sort.Slice(explored, func(i, j int) bool { return explored[i].tps > explored[j].tps })
		if len(explored) > refineTopK {
			explored = explored[:refineTopK]
		}
		for si, st := range explored {
			if abortEarly {
				break
			}
			cur := make(map[string]any, len(st.params))
			for k, v := range st.params {
				cur[k] = v
			}
			curTPS := st.tps
			for round := 1; round <= refineRounds; round++ {
				if a.testJobCancelled(jobID) || abortEarly {
					break
				}
				improved := false
				for _, d := range dims {
					if a.testJobCancelled(jobID) || abortEarly {
						break
					}
					bestInDim := curTPS
					var winVal any
					for i, v := range d.vals {
						if abortEarly {
							break
						}
						ov := make(map[string]any, len(cur))
						for k, vv := range cur {
							ov[k] = vv
						}
						ov[d.key] = v
						res, _ := runOne(ov, fmt.Sprintf("🔍 精调起点%d · 第%d轮", si+1, round))
						if res.Status == "ok" && res.TPS > bestInDim {
							bestInDim = res.TPS
							winVal = v
						}
						_ = i
					}
					// 整体寻优：相对提升超过阈值才采纳（避免单参数微小波动干扰）
					if winVal != nil && bestInDim > curTPS*(1+improveThresh) {
						cur[d.key] = winVal
						curTPS = bestInDim
						improved = true
					}
				}
				if !improved {
					break
				}
			}
			if curTPS > bestGlobalTPS {
				bestGlobalTPS = curTPS
				bestGlobal = cur
			}
		}

		// ── Phase 3：最终确认（对全局最优配置做一次干净测量）────────
		if bestGlobal == nil {
			bestGlobal = cloneBase()
			for _, d := range dims {
				bestGlobal[d.key] = d.vals[0]
			}
		}
		var fres testResult
		if a.testJobCancelled(jobID) {
			fres = testResult{Status: "fail", Error: "测试已取消"}
		} else {
			fres, _ = runOne(bestGlobal, "🏁 最终配置")
		}
		if len(results) > 0 {
			results[len(results)-1].IsBest = true
		}
		a.recordSweepHistory(a.bundleName(req.ModelID), req, "greedy", results)
		done, _ := json.Marshal(map[string]any{
			"type": "sweep_done", "job_id": jobID, "mode": "greedy",
			"results": results, "total": combo,
			"tested":     testedCount, // 实际启动模型的组合数（其余为缓存复用）
			"best_label": comboLabel(bestGlobal), "best_tps": fres.TPS, "best_tokens": fres.Tokens,
			"best_params": bestGlobal,
			"cancelled":   a.testJobCancelled(jobID),
			"best_meta": map[string]any{
				"mode": "greedy", "tps": fres.TPS, "load_ms": fres.LoadMS, "tokens": fres.Tokens,
				"ctx_size":     sweepInt(bestGlobal, "ctx_size"),
				"n_gpu_layers": sweepInt(bestGlobal, "n_gpu_layers"),
				"max_tokens":   req.MaxTokens, "prompt": req.Prompt,
			},
		})
		a.hub.Broadcast(done)
	}()
}

// isRunning reports whether a session still has a live runner.
func (a *App) isRunning(id string) bool {
	a.mu.Lock()
	_, ok := a.runners[id]
	a.mu.Unlock()
	return ok
}

// stopRunner gracefully stops a session and cleans it up (idempotent).
func (a *App) stopRunner(id string) {
	a.mu.Lock()
	ar, ok := a.runners[id]
	a.mu.Unlock()
	if !ok {
		if s, found := a.sessions.Get(id); found && s.Status != session.StatusStopped {
			s.Status = session.StatusStopped
			now := time.Now().UTC().Format(time.RFC3339)
			s.EndTime = &now
			_ = a.sessions.Update(s)
		}
		return
	}
	_ = ar.runner.Stop(5 * time.Second)
	ar.runner.Close()
	ar.session.Status = session.StatusStopped
	now := time.Now().UTC().Format(time.RFC3339)
	ar.session.EndTime = &now
	_ = a.sessions.Update(ar.session)
	a.mu.Lock()
	delete(a.runners, id)
	a.mu.Unlock()
}

// findFreePort returns the first free port starting at from.
func (a *App) findFreePort(from int) int {
	a.testPortMu.Lock()
	defer a.testPortMu.Unlock()
	if a.testPorts == nil {
		a.testPorts = map[int]bool{}
	}
	for p := from; p < from+500; p++ {
		if a.testPorts[p] {
			continue
		}
		if _, used := a.sessions.PortInUse(p); !used {
			a.testPorts[p] = true
			return p
		}
	}
	return from
}

// testChatTiming sends one non-streaming chat completion and returns timings.
func (a *App) testChatTiming(port int, prompt string, maxTokens int) (chatTiming, error) {
	body, _ := json.Marshal(map[string]any{
		"model":      "test",
		"messages":   []map[string]string{{"role": "user", "content": prompt}},
		"max_tokens": maxTokens,
		"stream":     false,
	})
	req, err := http.NewRequest(http.MethodPost,
		fmt.Sprintf("http://127.0.0.1:%d/v1/chat/completions", port), bytes.NewReader(body))
	if err != nil {
		return chatTiming{}, err
	}
	req.Header.Set("Content-Type", "application/json")
	if key := a.effectiveAPIKey(); key != "" {
		req.Header.Set("Authorization", "Bearer "+key)
	}
	resp, err := (&http.Client{Timeout: 90 * time.Second}).Do(req) // 看门狗：单次测量超时防止死锁
	if err != nil {
		return chatTiming{}, fmt.Errorf("请求失败: %v", err)
	}
	defer resp.Body.Close()
	if resp.StatusCode != http.StatusOK {
		b, _ := io.ReadAll(resp.Body)
		return chatTiming{}, fmt.Errorf("HTTP %d: %s", resp.StatusCode, truncateStr(string(b), 200))
	}
	var out struct {
		Usage struct {
			CompletionTokens int `json:"completion_tokens"`
		} `json:"usage"`
		Timings struct {
			PredictedPerSecond float64 `json:"predicted_per_second"`
			PromptPerSecond    float64 `json:"prompt_per_second"`
			PromptMS           float64 `json:"prompt_ms"`
			EvalMS             float64 `json:"predicted_ms"`
		} `json:"timings"`
	}
	if err := json.NewDecoder(resp.Body).Decode(&out); err != nil {
		return chatTiming{}, err
	}
	return chatTiming{
		TPS:      out.Timings.PredictedPerSecond,
		Tokens:   out.Usage.CompletionTokens,
		PromptPS: out.Timings.PromptPerSecond,
		PromptMS: out.Timings.PromptMS,
		EvalMS:   out.Timings.EvalMS,
	}, nil
}

// effectiveAPIKey returns the global server API key (decrypted) or "".
func (a *App) effectiveAPIKey() string {
	if a.cfg.ServerAPIKeyEnc == "" {
		return ""
	}
	plain, err := secure.Decrypt(a.secretKeyPath, a.cfg.ServerAPIKeyEnc)
	if err != nil {
		return ""
	}
	return plain
}

// sessionAPIKey returns the key a session actually runs with: session-level
// api_key param first, otherwise the globally configured (decrypted) key.
func (a *App) sessionAPIKey(s *session.Session) string {
	if s != nil && s.Params != nil {
		if v, ok := s.Params["api_key"]; ok {
			if str, ok := v.(string); ok && str != "" {
				return str
			}
		}
	}
	return a.effectiveAPIKey()
}

// truncateStr shortens a string for safe display in logs.
func truncateStr(s string, n int) string {
	if len(s) <= n {
		return s
	}
	return s[:n] + "…"
}

// handlePreview renders the CLI command from parameters (POST /api/preview).
// When bundle_id is provided the preview mirrors the real launch command,
// including model-specific defaults (e.g. the auto-attached mmproj vision
// encoder and --mcp flags) — previously the preview omitted --mmproj, which
// made it look like multimodal models were launched in text-only mode.
func (a *App) handlePreview(w http.ResponseWriter, r *http.Request) {
	var req struct {
		BundleID string         `json:"bundle_id"`
		Params   map[string]any `json:"params"`
	}
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		a.writeJSON(w, http.StatusBadRequest, map[string]string{"error": err.Error()})
		return
	}
	if req.Params == nil {
		req.Params = map[string]any{}
	}
	// Resolve the launch port from the form if present.
	port := 8080
	if p, ok := req.Params["port"]; ok {
		if n, ok := p.(float64); ok && n > 0 {
			port = int(n)
		}
	}
	chain := config.NewChain(a.registry)
	var args []string
	if req.BundleID != "" {
		if b, ok := a.bundles.Get(req.BundleID); ok {
			chain.Merge(a.cfg.DefaultParams, a.modelDefaults(b, port), req.Params)
			args = chain.ArgList()
			if cfgJSON, err := a.mcpCursorJSON(b); err == nil && cfgJSON != "" {
				args = append(args, "--mcp-servers-json", cfgJSON)
			}
		}
	}
	if args == nil {
		chain.Merge(a.cfg.DefaultParams, nil, req.Params)
		args = chain.ArgList()
	}
	a.writeJSON(w, http.StatusOK, map[string]any{
		"args":  args,
		"cli":   "llama-server " + strings.Join(args, " "),
		"count": len(args),
	})
}

// modelDefaults returns the model-specific (Level-2) defaults for a bundle.
// Besides the standard defaults it auto-attaches the bound vision encoder
// (mmproj) and, for MTP-head models, auto-enables --spec-type draft-mtp so the
// MTP tensor is used instead of being ignored as unused. This applies to every
// launch path (manual start, tests, sweeps) unless the user overrides spec_type.
func (a *App) modelDefaults(b *bundle.Bundle, port int) map[string]any {
	m := map[string]any{
		"model":        b.BaseModel.Path,
		"n_gpu_layers": b.DefaultParams.NGPULayers,
		"ctx_size":     b.DefaultParams.CtxSize,
		"load_mode":    b.DefaultParams.LoadMode,
		"flash_attn":   b.DefaultParams.FlashAttn,
		"metrics":      true, // 默认开启 /metrics，供监控面板采集
		"port":         port,
	}
	if b.MMProj.Path != "" {
		if mmPath := a.resolveMMProj(b); mmPath != "" {
			m["mmproj"] = mmPath
		}
	}
	if bundleIsMTP(b) {
		m["spec_type"] = "draft-mtp"
	}
	return m
}

// resolveMMProj returns a usable vision-encoder (mmproj) path for the bundle,
// or "" if none is available. If the persisted companion path is stale (the
// file no longer exists — e.g. it was renamed/removed after binding), it falls
// back so loading a vision model never fails just because of a dead binding:
//  1. same path minus ".gguf" (some dirs keep mmproj-BF16 without the suffix)
//  2. any existing mmproj file in the same directory (DetectCompanions)
//
// Otherwise the --mmproj flag is simply omitted (model still loads, CPU-only).
func (a *App) resolveMMProj(b *bundle.Bundle) string {
	p := b.MMProj.Path
	if p != "" {
		if fi, err := os.Stat(p); err == nil && !fi.IsDir() {
			return p
		}
		if strings.HasSuffix(strings.ToLower(p), ".gguf") {
			alt := strings.TrimSuffix(p, ".gguf")
			if fi, err := os.Stat(alt); err == nil && !fi.IsDir() {
				return alt
			}
		}
	}
	hints := bundle.DetectCompanions(b.BaseModel.Path)
	if hints.MMProj != "" {
		if fi, err := os.Stat(hints.MMProj); err == nil && !fi.IsDir() {
			return hints.MMProj
		}
	}
	return ""
}

// bundleIsMTP reports whether a bundle carries an MTP speculative-decoding
// head. It checks the persisted tags plus file name/path (nextn is llama.cpp's
// internal next-token-network tensor prefix), then falls back to probing the
// GGUF's tensor names — so a model like "Qwen3.8-27B-UD-IQ2_XXS.gguf" that
// embeds a blk.*.nextn.* MTP head without advertising it is still detected.
func bundleIsMTP(b *bundle.Bundle) bool {
	if b == nil {
		return false
	}
	for _, t := range b.Tags {
		if t == "mtp" {
			return true
		}
	}
	lower := strings.ToLower(b.Name + " " + b.BaseModel.Path)
	if strings.Contains(lower, "mtp") || strings.Contains(lower, "nextn") {
		return true
	}
	if b.BaseModel.Exists {
		return bundle.HasMTPHeadByFile(b.BaseModel.Path)
	}
	return false
}

// annotateMTP appends the "mtp" capability tag to each bundle's response copy
// when its file embeds an MTP head, so the UI can surface the MTP group even
// for bundles whose persisted tags predate tensor probing.
func annotateMTP(list []*bundle.Bundle) []*bundle.Bundle {
	out := make([]*bundle.Bundle, 0, len(list))
	for _, b := range list {
		if !bundleIsMTP(b) {
			out = append(out, b)
			continue
		}
		cp := *b
		cp.Tags = append([]string{}, b.Tags...)
		has := false
		for _, t := range cp.Tags {
			if t == "mtp" {
				has = true
				break
			}
		}
		if !has {
			cp.Tags = append(cp.Tags, "mtp")
		}
		out = append(out, &cp)
	}
	return out
}

// buildArgs resolves the final CLI arguments for a launch.
func (a *App) buildArgs(b *bundle.Bundle, params map[string]any, port int) []string {
	chain := config.NewChain(a.registry)
	chain.Merge(a.cfg.DefaultParams, a.modelDefaults(b, port), params)
	args := chain.ArgList()
	// 把绑定到该 bundle 的 MCP 服务器转换为 Cursor 格式内联注入
	// （llama.cpp 用 --mcp-servers-json，不是 --mcp）
	if cfgJSON, err := a.mcpCursorJSON(b); err == nil && cfgJSON != "" {
		args = append(args, "--mcp-servers-json", cfgJSON)
	}
	// Inject the globally-configured (encrypted) server API key when the user
	// did not supply one explicitly in the form.
	if _, hasKey := params["api_key"]; !hasKey && a.cfg.ServerAPIKeyEnc != "" {
		if plain, err := secure.Decrypt(a.secretKeyPath, a.cfg.ServerAPIKeyEnc); err == nil && plain != "" {
			args = append(args, "--api-key", plain)
		}
	}
	// Reject unknown/empty model to avoid launching with garbage.
	return args
}

// handleWS upgrades to WebSocket and starts the log stream.
func (a *App) handleWS(w http.ResponseWriter, r *http.Request) {
	conn, err := a.upgrader.Upgrade(w, r, nil)
	if err != nil {
		return
	}
	c := &wsClient{conn: conn, send: make(chan []byte, 128)}
	a.hub.register(c)
	go c.writePump()
	go c.readPump(a.hub)
}

// routes registers all HTTP handlers.
func (a *App) routes() http.Handler {
	mux := http.NewServeMux()
	mux.HandleFunc("GET /api/health", a.handleHealth)
	mux.HandleFunc("GET /api/system", a.handleSystem)
	mux.HandleFunc("GET /api/monitor", a.handleMonitor)
	mux.HandleFunc("GET /api/params", a.handleParams)
	mux.HandleFunc("/api/bundles", a.handleBundles)
	mux.HandleFunc("/api/bundles/{id}", a.handleBundleItem)
	mux.HandleFunc("POST /api/bundles/{id}/configs", a.handleBundleConfigs)
	mux.HandleFunc("DELETE /api/bundles/{id}/configs/{cfgId}", a.handleBundleConfigItem)
	mux.HandleFunc("PUT /api/bundles/{id}/mcpservers", a.handleBundleMCPServers)
	mux.HandleFunc("POST /api/parse", a.handleParseGGUF)
	mux.HandleFunc("POST /api/bundles/analyze", a.handleAnalyze)
	mux.HandleFunc("POST /api/bundles/import", a.handleImport)
	mux.HandleFunc("POST /api/bundles/scan", a.handleScan)
	mux.HandleFunc("POST /api/recommend", a.handleRecommend)
	mux.HandleFunc("GET /api/cache", a.handleCache)
	mux.HandleFunc("POST /api/cache/delete", a.handleCacheDelete)
	mux.HandleFunc("POST /api/cache/import", a.handleCacheImport)
	mux.HandleFunc("POST /api/cache/export", a.handleCacheExport)
	mux.HandleFunc("POST /api/hf/list", a.handleHFList)
	mux.HandleFunc("POST /api/hf/download", a.handleHFDownload)
	mux.HandleFunc("POST /api/debug/proxy", a.handleDebugProxy)
	mux.HandleFunc("GET /api/sessions", a.handleSessions)
	mux.HandleFunc("GET /api/insights", a.handleInsights)
	mux.HandleFunc("GET /api/mcp", a.handleMCPList)
	mux.HandleFunc("POST /api/mcp", a.handleMCPAdd)
	mux.HandleFunc("DELETE /api/mcp/{id}", a.handleMCPDelete)
	mux.HandleFunc("GET /api/mcp/status", a.handleMCPStatus)
	mux.HandleFunc("GET /api/mcp/check-env", a.handleMCPCheckEnv)
	mux.HandleFunc("POST /api/mcp/test", a.handleMCPTest)
	mux.HandleFunc("GET /api/mcp/templates", a.handleMCPTemplates)
	mux.HandleFunc("GET /api/config", a.handleConfigGet)
	mux.HandleFunc("GET /api/config/key", a.handleConfigKey)
	mux.HandleFunc("PUT /api/config", a.handleConfigPut)
	mux.HandleFunc("GET /api/fs/list", a.handleFSList)
	mux.HandleFunc("POST /api/sessions/start", a.handleStart)
	mux.HandleFunc("POST /api/test/batch", a.handleTestBatch)
	mux.HandleFunc("POST /api/test/sweep", a.handleTestSweep)
	mux.HandleFunc("POST /api/test/cancel", a.handleTestCancel)
	mux.HandleFunc("GET /api/test/history", a.handleTestHistory)
	mux.HandleFunc("DELETE /api/test/history", a.handleTestHistoryClear)
	mux.HandleFunc("POST /api/sessions/{id}/stop", a.handleStop)
	mux.HandleFunc("POST /api/sessions/{id}/restart", a.handleRestart)
	mux.HandleFunc("POST /api/preview", a.handlePreview)
	mux.HandleFunc("GET /api/ws", a.handleWS)

	// Static front-end (embedded from internal/webui/dist).
	webRoot, err := webui.FS()
	if err != nil {
		log.Printf("webui: %v", err)
	}
	fileServer := http.FileServer(http.FS(webRoot))
	// Fallback for everything not matched by the /api routes above.
	mux.Handle("/", fileServer)
	return logRequests(mux)
}

// logRequests logs each request at INFO level.
func logRequests(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		start := time.Now()
		next.ServeHTTP(w, r)
		log.Printf("%s %s %s", r.Method, r.URL.Path, time.Since(start).Round(time.Millisecond))
	})
}

// main is the process entry point.
var startTime = time.Now()

func main() {
	parseCmd := flag.NewFlagSet("parse", flag.ExitOnError)
	_ = parseCmd
	if len(os.Args) > 1 {
		switch os.Args[1] {
		case "parse":
			runParse(os.Args[2:])
			return
		case "websearch-mcp":
			// 内置免 Key 搜索 MCP server（Bing 后端，国内可直连）。
			if err := websearch.RunMCP(); err != nil {
				log.Fatalf("websearch-mcp: %v", err)
			}
			return
		}
	}

	host := flag.String("host", "127.0.0.1", "监听地址")
	port := flag.Int("port", 8080, "监听端口")
	dataDir := flag.String("data", "", "数据目录 (默认 data)")
	binary := flag.String("binary", "llama-server", "llama-server 可执行文件路径")
	flag.Parse()

	cfg := loadGlobalConfig(*dataDir)
	if *dataDir != "" {
		cfg.DataDir = *dataDir
	}
	if *binary != "llama-server" {
		cfg.BinaryPath = *binary
	}

	app, err := NewApp(cfg)
	if err != nil {
		log.Fatalf("初始化失败: %v", err)
	}

	addr := fmt.Sprintf("%s:%d", *host, *port)
	srv := &http.Server{Addr: addr, Handler: app.routes()}

	go func() {
		log.Printf("🚀 Llama Launcher v%s 已启动: http://%s", Version, addr)
		if err := srv.ListenAndServe(); err != nil && err != http.ErrServerClosed {
			log.Fatalf("服务异常: %v", err)
		}
	}()

	// Graceful shutdown: close server, then let the Job Object reap children.
	stop := make(chan os.Signal, 1)
	signal.Notify(stop, os.Interrupt, syscall.SIGTERM)
	<-stop
	log.Println("正在关闭…")
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	_ = srv.Shutdown(ctx)
	app.mu.Lock()
	for id, ar := range app.runners {
		_ = ar.runner.Stop(3 * time.Second)
		ar.runner.Close()
		delete(app.runners, id)
	}
	app.mu.Unlock()
	log.Println("已退出")
}

// runParse implements `llama-launcher parse <path>`.
func runParse(args []string) {
	if len(args) < 1 {
		log.Fatal("用法: llama-launcher parse <model.gguf>")
	}
	info, err := gguf.Parse(args[0])
	if err != nil {
		log.Fatalf("解析失败: %v", err)
	}
	enc := json.NewEncoder(os.Stdout)
	enc.SetIndent("", "  ")
	_ = enc.Encode(map[string]any{
		"path":             info.Path,
		"file_size_mb":     info.FileSizeMB,
		"architecture":     info.Architecture,
		"context_length":   info.ContextLength,
		"block_count":      info.BlockCount,
		"head_count":       info.HeadCount,
		"head_count_kv":    info.HeadCountKV,
		"embedding_length": info.EmbeddingLength,
		"vocab_size":       info.VocabSize,
		"file_type":        gguf.FileTypeName(info.FileType),
		"metadata_keys":    len(info.RawKeys),
	})
}
