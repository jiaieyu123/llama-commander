package llama

// health.go implements the three-way health fusion from the spec:
//   - stdout (startup phase)        — handled by the log collector
//   - GET /health  every 2s         — runtime liveness
//   - GET /metrics every 5s         — deep monitoring

import (
	"context"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"strconv"
	"strings"
	"time"
)

// HealthChecker polls a llama-server instance.
type HealthChecker struct {
	BaseURL string
	Client  *http.Client
	APIKey  string // 实例启用了 --api-key 时用于鉴权
}

// NewHealthChecker creates a checker for the given base URL.
func NewHealthChecker(baseURL string) *HealthChecker {
	return &HealthChecker{
		BaseURL: baseURL,
		Client:  &http.Client{Timeout: 3 * time.Second},
	}
}

// applyAuth injects the bearer token when the server requires an API key.
func (h *HealthChecker) applyAuth(req *http.Request) {
	if h.APIKey != "" {
		req.Header.Set("Authorization", "Bearer "+h.APIKey)
	}
}

// Health probes GET /health. A 200 means the server is ready.
func (h *HealthChecker) Health(ctx context.Context) (bool, error) {
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, h.BaseURL+"/health", nil)
	if err != nil {
		return false, err
	}
	h.applyAuth(req)
	resp, err := h.Client.Do(req)
	if err != nil {
		return false, err
	}
	defer resp.Body.Close()
	return resp.StatusCode == http.StatusOK, nil
}

// Metrics is the JSON shape exposed by llama-server /metrics.
type Metrics struct {
	TPromptProcessing       float64 `json:"t_prompt_processing"`
	TEval                   float64 `json:"t_eval"`
	NPromptTokensProcessed  int64   `json:"n_prompt_tokens_processed"`
	NPredicted              int64   `json:"n_predicted"`
	NPromptTokensTotal      int64   `json:"n_prompt_tokens_total"`
	NPredictedTokensTotal   int64   `json:"n_predicted_tokens_total"`
	KVCacheUsageRatio       float64 `json:"kv_cache_usage_ratio"`
	KVCacheTokensCount      int64   `json:"kv_cache_tokens_count"`
	SlotsIdle               int     `json:"slots_idle"`
	SlotsProcessing         int     `json:"slots_processing"`
	PromptPerSecond         float64 `json:"prompt_per_second"`
	PredictedPerSecond      float64 `json:"predicted_per_second"`
}

// Metrics probes GET /metrics and decodes the payload. llama.cpp serves two
// formats depending on build:
//   - older builds: JSON (fields like t_prompt_processing, n_predicted_tokens_total)
//   - newer builds (e.g. b10520): Prometheus text exposition (llamacpp:*)
//
// We sniff Content-Type and parse whichever the server speaks.
func (h *HealthChecker) Metrics(ctx context.Context) (*Metrics, error) {
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, h.BaseURL+"/metrics", nil)
	if err != nil {
		return nil, err
	}
	h.applyAuth(req)
	req.Header.Set("Accept", "application/json, text/plain; version=0.0.4; charset=utf-8")
	resp, err := h.Client.Do(req)
	if err != nil {
		return nil, err
	}
	defer resp.Body.Close()
	if resp.StatusCode != http.StatusOK {
		return nil, fmt.Errorf("metrics: status %d", resp.StatusCode)
	}
	body, err := io.ReadAll(resp.Body)
	if err != nil {
		return nil, err
	}
	ct := resp.Header.Get("Content-Type")
	if strings.Contains(ct, "application/json") {
		var m Metrics
		if err := json.Unmarshal(body, &m); err != nil {
			return nil, err
		}
		return &m, nil
	}
	return parsePrometheus(body), nil
}

// parsePrometheus parses llama.cpp's Prometheus text exposition into Metrics.
// Lines are `llamacpp:<name> <value>`; `#` lines are HELP/TYPE comments.
func parsePrometheus(body []byte) *Metrics {
	m := &Metrics{}
	get := func(name string) (string, bool) {
		for _, ln := range strings.Split(string(body), "\n") {
			ln = strings.TrimSpace(ln)
			if ln == "" || strings.HasPrefix(ln, "#") {
				continue
			}
			if strings.HasPrefix(ln, "llamacpp:"+name+" ") {
				return strings.TrimSpace(strings.TrimPrefix(ln, "llamacpp:"+name+" ")), true
			}
		}
		return "", false
	}
	if v, ok := get("prompt_tokens_total"); ok {
		if n, err := strconv.ParseInt(v, 10, 64); err == nil {
			m.NPromptTokensTotal = n
		}
	}
	if v, ok := get("tokens_predicted_total"); ok {
		if n, err := strconv.ParseInt(v, 10, 64); err == nil {
			m.NPredictedTokensTotal = n
		}
	}
	if v, ok := get("prompt_tokens_seconds"); ok {
		if f, err := strconv.ParseFloat(v, 64); err == nil {
			m.PromptPerSecond = f
		}
	}
	if v, ok := get("predicted_tokens_seconds"); ok {
		if f, err := strconv.ParseFloat(v, 64); err == nil {
			m.PredictedPerSecond = f
		}
	}
	if v, ok := get("requests_processing"); ok {
		if n, err := strconv.Atoi(v); err == nil {
			m.SlotsProcessing = n
		}
	}
	return m
}
