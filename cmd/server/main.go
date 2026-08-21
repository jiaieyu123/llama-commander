// Llama Commander — llama.cpp 智能启动管理器
//
// 主入口：HTTP REST API + WebSocket 日志流 + 内嵌静态前端 + 子进程生命周期管理。
// 用法:
//   llama-commander                      启动 Web 服务
//   llama-commander parse <model.gguf>   单独测试 GGUF 解析
package main

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"flag"
	"fmt"
	"io"
	"log"
	"net/http"
	"os"
	"os/signal"
	"path/filepath"
	"sort"
	"strconv"
	"strings"
	"sync"
	"syscall"
	"time"

	"github.com/gorilla/websocket"

	"llama-commander/internal/bundle"
	"llama-commander/internal/config"
	"llama-commander/internal/downloader"
	"llama-commander/internal/fsbrowse"
	"llama-commander/internal/gguf"
	"llama-commander/internal/llama"
	"llama-commander/internal/mcp"
	"llama-commander/internal/secure"
	"llama-commander/internal/session"
	"llama-commander/internal/webui"
)

// Version of the manager itself.
const Version = "0.1.0-skeleton"

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
	HFEndpoint       string         `json:"hf_endpoint,omitempty"`         // HF 镜像覆盖
	CacheDir         string         `json:"cache_dir,omitempty"`           // llama.cpp 模型下载缓存目录（空=默认 ~/.cache/llama.cpp）
	ServerAPIKeyEnc  string         `json:"server_api_key_enc,omitempty"`  // AES-256-GCM 加密
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
	metricsTick   int // throttles session persistence
	configPath    string
	secretKeyPath string
}

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

func (h *Hub) register(c *wsClient)  { h.mu.Lock(); h.clients[c] = true; h.mu.Unlock() }
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
		cfg:            cfg,
		registry:       config.NewRegistry(),
		bundles:        bundlesMgr,
		sessions:       sessionsMgr,
		mcp:            mcpMgr,
		cache:          bundle.NewCacheManager(cfg.CacheDir),
		hw:             hw,
		upgrader:       websocket.Upgrader{CheckOrigin: func(*http.Request) bool { return true }},
		hub:            NewHub(),
		runners:        make(map[string]*activeRun),
		configPath:     filepath.Join(cfg.DataDir, "config.json"),
		secretKeyPath:  filepath.Join(cfg.DataDir, ".secret"),
	}
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
		"name":    "llama-commander",
		"version": Version,
		"status":  "ok",
		"running": a.sessions.RunningCount(),
		"uptime":  time.Since(startTime).String(),
	})
}

func (a *App) handleSystem(w http.ResponseWriter, r *http.Request) {
	a.writeJSON(w, http.StatusOK, map[string]any{
		"hardware": a.hw,
		"binary":   a.cfg.BinaryPath,
		"data_dir": a.cfg.DataDir,
	})
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
		a.writeJSON(w, http.StatusOK, a.bundles.List())
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

// handleBundleConfigs saves a tested configuration to a model (POST
// /api/bundles/{id}/configs).
func (a *App) handleBundleConfigs(w http.ResponseWriter, r *http.Request) {
	id := r.PathValue("id")
	var req struct {
		Name   string                 `json:"name"`
		Params map[string]any         `json:"params"`
		Meta   bundle.TestConfigMeta  `json:"meta"`
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
		"path":          info.Path,
		"architecture":  info.Architecture,
		"context_length": info.ContextLength,
		"block_count":   info.BlockCount,
		"head_count_kv": info.HeadCountKV,
		"embedding_length": info.EmbeddingLength,
		"file_type":     gguf.FileTypeName(info.FileType),
		"file_size_mb":  info.FileSizeMB,
		"metadata":      info.Metadata,
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
		"name":        b.Name,
		"path":        req.Path,
		"exists":      b.BaseModel.Exists,
		"file_size_mb": b.BaseModel.FileSizeMB,
		"architecture": b.BaseModel.Metadata.Architecture,
		"context_length": b.BaseModel.Metadata.ContextLength,
		"block_count":   b.BaseModel.Metadata.BlockCount,
		"head_count_kv": b.BaseModel.Metadata.HeadCountKV,
		"embedding_length": b.BaseModel.Metadata.EmbeddingLength,
		"is_moe":       b.BaseModel.Metadata.IsMoE(),
		"file_type":    gguf.FileTypeName(b.BaseModel.Metadata.FileType),
		"shard_info":   b.ShardInfo,
		"mmproj":       b.MMProj.Path,
		"draft":        b.DraftModel.Path,
		"lora":         loraPaths(b.LORAList),
		"tags":         b.Tags,
		"metadata":     meta,
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
	Scene    string         `json:"scene"`   // speed | context | lowvram | creative | ""
	Params   map[string]any `json:"params"`  // current form values for audit
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
			"file_size_mb":    spec.FileSizeMB,
			"block_count":     spec.BlockCount,
			"context_length":  spec.ContextLength,
			"head_count_kv":   spec.HeadCountKV,
			"embedding_length": spec.EmbeddingLength,
			"architecture":    spec.Architecture,
			"is_moe":          spec.IsMoE,
			"num_experts":     spec.NumExperts,
		},
	})
}

// modelSpecFromBundle converts a bundle into the config engine's ModelSpec.
func modelSpecFromBundle(b *bundle.Bundle) config.ModelSpec {
	spec := config.ModelSpec{
		FileSizeMB: b.BaseModel.FileSizeMB,
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
	Path     string `json:"path"`
	RepoID   string `json:"repo_id"`
	DestDir  string `json:"dest_dir"`
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
		"total_tokens":      totalTokens,
		"total_sessions":    totalSessions,
		"today_sessions":    todaySessions,
		"crashes":           crashes,
		"success_rate":      successRate,
		"avg_tps":           avgTPS,
		"models":            models,
		"days":              days,
		"generated_at":      time.Now().Format(time.RFC3339),
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
		for {
			n, err := pr.Read(buf)
			if n > 0 {
				a.hub.PublishLog(sess.ID, "INFO", string(buf[:n]))
			}
			if err != nil {
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
	BundleIDs []string `json:"bundle_ids"`
	Prompt    string   `json:"prompt"`
	MaxTokens int      `json:"max_tokens"`
}

// testResult is one model's batch-test outcome.
type testResult struct {
	BundleID string  `json:"bundle_id"`
	Name     string  `json:"name"`
	Status   string  `json:"status"` // ok | fail
	LoadMS   int64   `json:"load_ms"`
	TPS      float64 `json:"tps"`
	Tokens   int     `json:"tokens"`
	Error    string  `json:"error,omitempty"`
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
		results := make([]testResult, 0, len(req.BundleIDs))
		for i, bid := range req.BundleIDs {
			res := a.runOneTest(bid, req.Prompt, req.MaxTokens)
			results = append(results, res)
			data, _ := json.Marshal(map[string]any{
				"type": "test_progress", "job_id": jobID,
				"index": i, "total": len(req.BundleIDs),
				"bundle_id": res.BundleID, "name": res.Name, "status": res.Status,
				"load_ms": res.LoadMS, "tps": res.TPS, "tokens": res.Tokens, "error": res.Error,
			})
			a.hub.Broadcast(data)
		}
		done, _ := json.Marshal(map[string]any{"type": "test_done", "job_id": jobID, "results": results})
		a.hub.Broadcast(done)
	}()
}

// runOneTest loads a model, waits for health, sends a short chat and stops it.
func (a *App) runOneTest(bundleID, prompt string, maxTokens int) testResult {
	return a.runOneTestCore(bundleID, prompt, maxTokens, nil)
}

// runOneTestCore is the shared test runner. overrides are applied on top of
// the standard test parameter set (used by both model batch tests and the
// parameter sweep so both measure under identical conditions).
func (a *App) runOneTestCore(bundleID, prompt string, maxTokens int, overrides map[string]any) testResult {
	res := testResult{BundleID: bundleID}
	b, ok := a.bundles.Get(bundleID)
	if !ok {
		res.Status = "fail"
		res.Error = "模型不存在"
		return res
	}
	res.Name = b.Name
	port := a.findFreePort(9300)
	params := map[string]any{
		"ctx_size":      1024,
		"predict":       maxTokens,
		"temperature":   0.1,
		"n_gpu_layers":  b.DefaultParams.NGPULayers,
		"flash_attn":    "on",
		"load_mode":     "mmap",
		"threads":       0,
		"cache_type_k":  "f16",
		"cache_type_v":  "f16",
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
	// Wait for /health (model loaded) with a generous timeout; abort if the
	// process crashes meanwhile.
	start := time.Now()
	healthy := false
	for {
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
		res.Error = "加载超时或进程退出（当前机器可能无法运行该模型）"
		return res
	}
	tps, tokens, terr := a.testChat(port, prompt, maxTokens)
	a.stopRunner(sess.ID)
	if terr != nil {
		res.Status = "fail"
		res.Error = terr.Error()
		return res
	}
	res.Status = "ok"
	res.TPS = tps
	res.Tokens = tokens
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
}

// sweepResult is one parameter-combination outcome.
type sweepResult struct {
	Combo  int     `json:"combo"`
	Label  string  `json:"label"`  // e.g. "GPU层=0, ctx=512, 线程=8"
	Step   string  `json:"step,omitempty"`  // greedy 模式：当前优化步骤
	Fixed  string  `json:"fixed,omitempty"` // greedy 模式：固定参数摘要
	IsBest bool    `json:"is_best,omitempty"`
	Status string  `json:"status"` // ok | fail
	LoadMS int64   `json:"load_ms"`
	TPS    float64 `json:"tps"`
	Tokens int     `json:"tokens"`
	Error  string  `json:"error,omitempty"`
}

// sweepShort maps registry keys to compact labels used in result rows.
var sweepShort = map[string]string{
	"n_gpu_layers": "GPU层", "main_gpu": "主GPU", "split_mode": "拆分",
	"ctx_size": "ctx", "threads": "线程", "threads_batch": "批线程",
	"batch_size": "batch", "ubatch_size": "ubatch",
	"cache_type_k": "K缓存", "cache_type_v": "V缓存",
	"rope_scaling": "rope", "flash_attn": "FA", "parallel": "槽位",
	"tensor_split": "tsplit",
	"load_mode": "加载", "numa": "NUMA", "kv_unified": "统一KV",
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
	jobID := fmt.Sprintf("sweep_%d", time.Now().UnixNano())
	a.writeJSON(w, http.StatusOK, map[string]any{"job_id": jobID, "total": len(combos)})

	go func() {
		results := make([]sweepResult, 0, len(combos))
		best, bestTPS := -1, 0.0
		for i, ov := range combos {
			res := a.runOneTestCore(req.ModelID, req.Prompt, req.MaxTokens, ov)
			sr := sweepResult{
				Combo: i, Label: labels[i], Status: res.Status,
				LoadMS: res.LoadMS, TPS: res.TPS, Tokens: res.Tokens, Error: res.Error,
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
			})
			a.hub.Broadcast(data)
		}
		doneMsg := map[string]any{
			"type": "sweep_done", "job_id": jobID,
			"results": results, "best": best,
		}
		if best >= 0 && best < len(combos) && best < len(results) && results[best].Status == "ok" {
			doneMsg["best_params"] = combos[best]
			doneMsg["best_meta"] = map[string]any{
				"mode": "exhaustive", "tps": results[best].TPS, "load_ms": results[best].LoadMS,
				"tokens": results[best].Tokens, "ctx_size": sweepInt(combos[best], "ctx_size"),
				"n_gpu_layers": sweepInt(combos[best], "n_gpu_layers"),
				"max_tokens": req.MaxTokens, "prompt": req.Prompt,
			}
		}
		done, _ := json.Marshal(doneMsg)
		a.hub.Broadcast(done)
	}()
}

// runGreedySweep optimizes parameters one at a time (coordinate descent): in
// each round every swept parameter is tested against the current best of the
// others, and the winner becomes the new best. This avoids the exponential
// cartesian explosion of exhaustive mode while usually converging to a
// near-optimal config in a few dozen tests.
func (a *App) runGreedySweep(w http.ResponseWriter, req sweepRequest) {
	type dim struct {
		key, lbl string
		vals     []any
		strs     []string
	}
	var dims []dim
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
			dims = append(dims, dim{key: p.Key, lbl: shortSweepLabel(p.Key), vals: vals, strs: strs})
		}
	}
	if len(dims) == 0 {
		a.writeJSON(w, http.StatusBadRequest, map[string]string{"error": "智能寻优需要至少一个参数填多个值"})
		return
	}
	const rounds = 2
	totalTests := 0
	for _, d := range dims {
		totalTests += len(d.vals) * rounds
	}
	jobID := fmt.Sprintf("sweep_%d", time.Now().UnixNano())
	a.writeJSON(w, http.StatusOK, map[string]any{"job_id": jobID, "total": totalTests, "mode": "greedy"})

	go func() {
		best := make(map[string]any, len(dims))
		bestStr := make(map[string]string, len(dims))
		for _, d := range dims {
			best[d.key] = d.vals[0]
			bestStr[d.key] = d.strs[0]
		}
		results := make([]sweepResult, 0, totalTests+1)
		combo := 0
		for round := 1; round <= rounds; round++ {
			improved := false
			for _, d := range dims {
				bestTPS := -1.0
				var winVal any
				winStr := ""
				for i, v := range d.vals {
					ov := make(map[string]any, len(best)+len(fixed))
					for k, vv := range fixed {
						ov[k] = vv
					}
					for k, vv := range best {
						ov[k] = vv
					}
					ov[d.key] = v
					res := a.runOneTestCore(req.ModelID, req.Prompt, req.MaxTokens, ov)
					sr := sweepResult{
						Combo: combo, Label: d.lbl + "=" + d.strs[i],
						Step:   fmt.Sprintf("第%d轮 · %s", round, d.lbl),
						Fixed:  strings.Join(fixedStrs, ", "),
						Status: res.Status, LoadMS: res.LoadMS, TPS: res.TPS,
						Tokens: res.Tokens, Error: res.Error,
					}
					if res.Status == "ok" && res.TPS > bestTPS {
						bestTPS = res.TPS
						winVal = v
						winStr = d.strs[i]
					}
					results = append(results, sr)
					data, _ := json.Marshal(map[string]any{
						"type": "sweep_progress", "job_id": jobID, "mode": "greedy",
						"combo": combo, "total": totalTests,
						"label": sr.Label, "step": sr.Step, "fixed": sr.Fixed,
						"status": sr.Status, "load_ms": sr.LoadMS,
						"tps": sr.TPS, "tokens": sr.Tokens, "error": sr.Error,
					})
					a.hub.Broadcast(data)
					combo++
				}
				if winStr != "" && winStr != bestStr[d.key] {
					best[d.key] = winVal
					bestStr[d.key] = winStr
					improved = true
				}
			}
			if !improved {
				break
			}
		}
		// 最终配置确认（一次干净测量）
		finalMap := make(map[string]any, len(best)+len(fixed))
		for k, v := range fixed {
			finalMap[k] = v
		}
		for k, v := range best {
			finalMap[k] = v
		}
		fres := a.runOneTestCore(req.ModelID, req.Prompt, req.MaxTokens, finalMap)
		parts := make([]string, 0, len(fixedStrs)+len(bestStr))
		parts = append(parts, fixedStrs...)
		keys := make([]string, 0, len(bestStr))
		for k := range bestStr {
			keys = append(keys, k)
		}
		sort.Strings(keys)
		for _, k := range keys {
			parts = append(parts, shortSweepLabel(k)+"="+bestStr[k])
		}
		finalLabel := strings.Join(parts, ", ")
		fsr := sweepResult{
			Combo: combo, Label: finalLabel, Step: "🏁 最终配置",
			Fixed: strings.Join(fixedStrs, ", "), IsBest: true,
			Status: fres.Status, LoadMS: fres.LoadMS, TPS: fres.TPS,
			Tokens: fres.Tokens, Error: fres.Error,
		}
		results = append(results, fsr)
		// 广播最终确认，前端将其渲染为独立步骤
		fdata, _ := json.Marshal(map[string]any{
			"type": "sweep_progress", "job_id": jobID, "mode": "greedy",
			"combo": combo, "total": totalTests,
			"label": finalLabel, "step": fsr.Step, "fixed": fsr.Fixed,
			"status": fsr.Status, "load_ms": fsr.LoadMS,
			"tps": fsr.TPS, "tokens": fsr.Tokens, "error": fsr.Error,
		})
		a.hub.Broadcast(fdata)
		combo++
		done, _ := json.Marshal(map[string]any{
			"type": "sweep_done", "job_id": jobID, "mode": "greedy",
			"results": results, "total": combo,
			"best_label": finalLabel, "best_tps": fres.TPS, "best_tokens": fres.Tokens,
			"best_params": finalMap,
			"best_meta": map[string]any{
				"mode": "greedy", "tps": fres.TPS, "load_ms": fres.LoadMS, "tokens": fres.Tokens,
				"ctx_size": sweepInt(finalMap, "ctx_size"),
				"n_gpu_layers": sweepInt(finalMap, "n_gpu_layers"),
				"max_tokens": req.MaxTokens, "prompt": req.Prompt,
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
	for p := from; p < from+500; p++ {
		if _, used := a.sessions.PortInUse(p); !used {
			return p
		}
	}
	return from
}

// testChat sends one non-streaming chat completion and returns (tps, tokens).
func (a *App) testChat(port int, prompt string, maxTokens int) (float64, int, error) {
	body, _ := json.Marshal(map[string]any{
		"model":      "test",
		"messages":   []map[string]string{{"role": "user", "content": prompt}},
		"max_tokens": maxTokens,
		"stream":     false,
	})
	req, err := http.NewRequest(http.MethodPost,
		fmt.Sprintf("http://127.0.0.1:%d/v1/chat/completions", port), bytes.NewReader(body))
	if err != nil {
		return 0, 0, err
	}
	req.Header.Set("Content-Type", "application/json")
	if key := a.effectiveAPIKey(); key != "" {
		req.Header.Set("Authorization", "Bearer "+key)
	}
	resp, err := http.DefaultClient.Do(req)
	if err != nil {
		return 0, 0, fmt.Errorf("请求失败: %v", err)
	}
	defer resp.Body.Close()
	if resp.StatusCode != http.StatusOK {
		b, _ := io.ReadAll(resp.Body)
		return 0, 0, fmt.Errorf("HTTP %d: %s", resp.StatusCode, truncateStr(string(b), 200))
	}
	var out struct {
		Usage struct {
			CompletionTokens int `json:"completion_tokens"`
		} `json:"usage"`
		Timings struct {
			PredictedPerSecond float64 `json:"predicted_per_second"`
		} `json:"timings"`
	}
	if err := json.NewDecoder(resp.Body).Decode(&out); err != nil {
		return 0, 0, err
	}
	return out.Timings.PredictedPerSecond, out.Usage.CompletionTokens, nil
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
func (a *App) handlePreview(w http.ResponseWriter, r *http.Request) {
	var req struct {
		Params map[string]any `json:"params"`
	}
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		a.writeJSON(w, http.StatusBadRequest, map[string]string{"error": err.Error()})
		return
	}
	chain := config.NewChain(a.registry)
	chain.Merge(a.cfg.DefaultParams, nil, req.Params)
	args := chain.ArgList()
	a.writeJSON(w, http.StatusOK, map[string]any{
		"args":   args,
		"cli":    "llama-server " + chain.CommandLine(),
		"count":  len(args),
	})
}

// buildArgs resolves the final CLI arguments for a launch.
func (a *App) buildArgs(b *bundle.Bundle, params map[string]any, port int) []string {
	chain := config.NewChain(a.registry)
	modelDefaults := map[string]any{
		"model":       b.BaseModel.Path,
		"n_gpu_layers": b.DefaultParams.NGPULayers,
		"ctx_size":    b.DefaultParams.CtxSize,
		"load_mode":   b.DefaultParams.LoadMode,
		"flash_attn":  b.DefaultParams.FlashAttn,
		"metrics":     true, // 默认开启 /metrics，供监控面板采集
		"port":        port,
	}
	if b.MMProj.Path != "" {
		modelDefaults["mmproj"] = b.MMProj.Path
	}
	chain.Merge(a.cfg.DefaultParams, modelDefaults, params)
	args := chain.ArgList()
	// Append MCP server flags bound to this bundle (--mcp <name> ...).
	for _, name := range b.MCPServers {
		args = append(args, "--mcp", name)
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
	mux.HandleFunc("GET /api/params", a.handleParams)
	mux.HandleFunc("/api/bundles", a.handleBundles)
	mux.HandleFunc("/api/bundles/{id}", a.handleBundleItem)
	mux.HandleFunc("POST /api/bundles/{id}/configs", a.handleBundleConfigs)
	mux.HandleFunc("DELETE /api/bundles/{id}/configs/{cfgId}", a.handleBundleConfigItem)
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
	mux.HandleFunc("GET /api/config", a.handleConfigGet)
	mux.HandleFunc("GET /api/config/key", a.handleConfigKey)
	mux.HandleFunc("PUT /api/config", a.handleConfigPut)
	mux.HandleFunc("GET /api/fs/list", a.handleFSList)
	mux.HandleFunc("POST /api/sessions/start", a.handleStart)
	mux.HandleFunc("POST /api/test/batch", a.handleTestBatch)
	mux.HandleFunc("POST /api/test/sweep", a.handleTestSweep)
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
	if len(os.Args) > 1 && os.Args[1] == "parse" {
		runParse(os.Args[2:])
		return
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
		log.Printf("🚀 Llama Commander v%s 已启动: http://%s", Version, addr)
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

// runParse implements `llama-commander parse <path>`.
func runParse(args []string) {
	if len(args) < 1 {
		log.Fatal("用法: llama-commander parse <model.gguf>")
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
