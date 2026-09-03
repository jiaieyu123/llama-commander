// Package bundle manages "model bundles": a primary GGUF model plus optional
// companions (vision encoder mmproj, draft model, LoRA adapters) and their
// default parameter sets. Persistence is JSON in data/bundles.json.
package bundle

import (
	"crypto/rand"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"os"
	"path/filepath"
	"sort"
	"strings"
	"sync"
	"time"

	"llama-launcher/internal/gguf"
)

// SourceType describes where the bundle's model originates.
type SourceType string

const (
	SourceLocal  SourceType = "local"
	SourceHF     SourceType = "huggingface"
	SourceURL    SourceType = "url"
	SourceDocker SourceType = "docker"
	SourceCache  SourceType = "cache"
)

// SourceRef describes a remote source.
type SourceRef struct {
	HFRepo      string `json:"hf_repo,omitempty"`
	HFQuant     string `json:"hf_quant,omitempty"`
	HFTokenUsed bool   `json:"hf_token_used,omitempty"`
	DockerRepo  string `json:"docker_repo,omitempty"`
	URL         string `json:"url,omitempty"`
}

// CacheEntry describes the relationship to the official ~/.cache/llama.cpp.
type CacheEntry struct {
	InLlamaCache   bool   `json:"in_llama_cache"`
	CachePath      string `json:"cache_path,omitempty"`
	ManifestExists bool   `json:"manifest_exists,omitempty"`
	ETag           string `json:"etag,omitempty"`
}

// ShardInfo describes whether the model is split across multiple files.
type ShardInfo struct {
	IsSharded        bool     `json:"is_sharded"`
	TotalShards      int      `json:"total_shards"`
	ShardPattern     string   `json:"shard_pattern,omitempty"`
	AllShardsPresent bool     `json:"all_shards_present"`
	ShardFiles       []string `json:"shard_files,omitempty"`
}

// ModelFile is a concrete on-disk file plus its parsed metadata.
type ModelFile struct {
	Path       string          `json:"path"`
	FileSizeMB float64         `json:"file_size_mb"`
	SHA256     string          `json:"sha256,omitempty"`
	Exists     bool            `json:"exists"`
	Metadata   *gguf.ModelInfo `json:"metadata,omitempty"`
}

// DraftModel describes a speculative-decoding draft model.
type DraftModel struct {
	Path       string         `json:"path"`
	Enabled    bool           `json:"enabled"`
	SpecType   string         `json:"spec_type,omitempty"`
	SpecParams map[string]any `json:"spec_params,omitempty"`
}

// LoRA is a single LoRA adapter.
type LoRA struct {
	Path  string  `json:"path"`
	Scale float64 `json:"scale"`
}

// UsageStats tracks aggregate usage of a bundle.
type UsageStats struct {
	TotalSessions        int     `json:"total_sessions"`
	TotalTokensGenerated int64   `json:"total_tokens_generated"`
	AvgTokensPerSecond   float64 `json:"avg_tokens_per_second"`
	CrashCount           int     `json:"crash_count"`
}

// TestConfig is a saved best configuration from a test/sweep run, so it can be
// re-applied to the launch params later with one click.
type TestConfig struct {
	ID        string         `json:"id"`
	Name      string         `json:"name"`
	Params    map[string]any `json:"params"`
	Meta      TestConfigMeta `json:"meta"`
	CreatedAt string         `json:"created_at"`
	Baseline  bool           `json:"baseline,omitempty"` // 每模型至多一个基线配置
	RunRef    *RunRef        `json:"run_ref,omitempty"`  // 关联的测试 Run（S1 血缘追溯）
}

// RunRef points at a TestRun entity for provenance (config → run).
type RunRef struct {
	RunID   string `json:"run_id"`
	ItemIdx int    `json:"item_idx"`
}

// TestConfigMeta records how well the configuration scored when tested.
type TestConfigMeta struct {
	Mode       string  `json:"mode,omitempty"` // exhaustive | greedy
	TPS        float64 `json:"tps,omitempty"`
	LoadMS     int64   `json:"load_ms,omitempty"`
	Tokens     int     `json:"tokens,omitempty"`
	CtxSize    int     `json:"ctx_size,omitempty"`
	NGPULayers int     `json:"n_gpu_layers,omitempty"`
	MaxTokens  int     `json:"max_tokens,omitempty"`
	Prompt     string  `json:"prompt,omitempty"`
	Date       string  `json:"date,omitempty"`
}

// DefaultParams is the Level-2 (model specific) configuration.
type DefaultParams struct {
	CtxSize    int    `json:"ctx_size"`
	NGPULayers int    `json:"n_gpu_layers"`
	LoadMode   string `json:"load_mode"`
	CPUMoE     bool   `json:"cpu_moe"`
	Samplers   string `json:"samplers"`
	FlashAttn  string `json:"flash_attn"`
}

// Bundle is the central model-composition entity.
type Bundle struct {
	ID            string        `json:"id"`
	Name          string        `json:"name"`
	SourceType    SourceType    `json:"source_type"`
	SourceRef     SourceRef     `json:"source_ref"`
	CacheEntry    CacheEntry    `json:"cache_entry"`
	ShardInfo     ShardInfo     `json:"shard_info"`
	BaseModel     ModelFile     `json:"base_model"`
	MMProj        ModelFile     `json:"mmproj,omitempty"`
	DraftModel    DraftModel    `json:"draft_model"`
	LORAList      []LoRA        `json:"lora_list"`
	MCPServers    []string      `json:"mcp_servers"`
	DefaultParams DefaultParams `json:"default_params"`
	TestConfigs   []TestConfig  `json:"test_configs,omitempty"`
	UsageStats    UsageStats    `json:"usage_stats"`
	Tags          []string      `json:"tags"`
	LastUsed      string        `json:"last_used,omitempty"`
	CreatedAt     string        `json:"created_at"`
	UpdatedAt     string        `json:"updated_at"`
}

// Manager is the thread-safe CRUD store for bundles.
type Manager struct {
	path    string
	mu      sync.RWMutex // guards in-memory map
	saveMu  sync.Mutex   // serializes disk writes (avoid .tmp collisions)
	bundles map[string]*Bundle
}

// NewManager loads (or initializes) the bundle store at path.
func NewManager(path string) (*Manager, error) {
	m := &Manager{path: path, bundles: make(map[string]*Bundle)}
	if err := m.Load(); err != nil {
		return nil, err
	}
	return m, nil
}

// Load reads bundles.json from disk. Missing/empty files initialize an
// empty store instead of failing.
func (m *Manager) Load() error {
	m.mu.Lock()
	m.bundles = make(map[string]*Bundle)
	data, err := os.ReadFile(m.path)
	if err != nil {
		m.mu.Unlock()
		if errors.Is(err, os.ErrNotExist) {
			return nil
		}
		return err
	}
	var list []*Bundle
	if err := json.Unmarshal(data, &list); err != nil {
		m.mu.Unlock()
		return fmt.Errorf("bundles.json: %w", err)
	}
	oldFormat := false
	for _, b := range list {
		if pruneRawMetadata(b) {
			oldFormat = true
		}
		m.bundles[b.ID] = b
	}
	m.mu.Unlock()
	// One-shot migration: an old file that still embeds the full metadata maps
	// was just slimmed in memory — rewrite it now so disk usage and future
	// loads stay small. Runs outside the write lock (Save takes its own locks).
	if oldFormat {
		return m.Save()
	}
	return nil
}

// mtpProbeCache caches file→hasMTP probe results by path so repeated lookups
// (per launch, per API listing) don't re-parse the GGUF header every time.
var mtpProbeCache sync.Map // path -> bool

// HasMTPHeadByFile probes a GGUF file for an MTP head using its tensor names
// (blk.*.nextn.*). Results are cached; model files are treated as immutable
// after import.
func HasMTPHeadByFile(path string) bool {
	if path == "" {
		return false
	}
	if v, ok := mtpProbeCache.Load(path); ok {
		return v.(bool)
	}
	has := false
	if info, err := gguf.Parse(path); err == nil {
		has = info.HasMTPHead()
	}
	mtpProbeCache.Store(path, has)
	return has
}

// slimCopy returns a shallow copy of b whose raw GGUF metadata maps are
// dropped. The full metadata map (containing the tokenizer vocab — tens of MB
// for a 150k-token model) is only needed transiently during parsing; persisting
// it bloated bundles.json to 300+ MB. The typed fields survive, so the UI and
// the config engine keep working unchanged.
func slimCopy(b *Bundle) *Bundle {
	cp := *b
	if b.BaseModel.Metadata != nil {
		pm := *b.BaseModel.Metadata
		pm.Metadata = nil
		cp.BaseModel.Metadata = &pm
	}
	if b.MMProj.Metadata != nil {
		pm := *b.MMProj.Metadata
		pm.Metadata = nil
		cp.MMProj.Metadata = &pm
	}
	return &cp
}

// pruneRawMetadata drops the raw metadata maps in place. It is applied after
// Load so old on-disk data stops holding huge maps in memory. Returns true
// when anything was pruned (i.e. the file was old-format and should be
// rewritten once by the caller).
func pruneRawMetadata(b *Bundle) bool {
	changed := false
	if b.BaseModel.Metadata != nil && b.BaseModel.Metadata.Metadata != nil {
		b.BaseModel.Metadata.Metadata = nil
		changed = true
	}
	if b.MMProj.Metadata != nil && b.MMProj.Metadata.Metadata != nil {
		b.MMProj.Metadata.Metadata = nil
		changed = true
	}
	return changed
}

// Save writes the store to disk atomically. A dedicated saveMu serializes
// concurrent writers (batch imports) so the .tmp file never collides.
//
// Raw GGUF metadata maps (tokenizer vocab etc., tens of MB per model) are
// dropped from the serialized copy: they are only needed transiently during
// parsing, and persisting them bloated bundles.json to 300+ MB.
func (m *Manager) Save() error {
	m.saveMu.Lock()
	defer m.saveMu.Unlock()

	m.mu.RLock()
	list := make([]*Bundle, 0, len(m.bundles))
	for _, b := range m.bundles {
		list = append(list, slimCopy(b))
	}
	m.mu.RUnlock()
	sort.Slice(list, func(i, j int) bool { return list[i].Name < list[j].Name })
	data, err := json.MarshalIndent(list, "", "  ")
	if err != nil {
		return err
	}
	if err := os.MkdirAll(filepath.Dir(m.path), 0o755); err != nil {
		return err
	}
	tmp := m.path + ".tmp"
	if err := os.WriteFile(tmp, data, 0o644); err != nil {
		return err
	}
	return os.Rename(tmp, m.path)
}

// List returns all bundles.
func (m *Manager) List() []*Bundle {
	m.mu.RLock()
	defer m.mu.RUnlock()
	out := make([]*Bundle, 0, len(m.bundles))
	for _, b := range m.bundles {
		out = append(out, b)
	}
	sort.Slice(out, func(i, j int) bool { return out[i].Name < out[j].Name })
	return out
}

// Get returns a bundle by ID.
func (m *Manager) Get(id string) (*Bundle, bool) {
	m.mu.RLock()
	defer m.mu.RUnlock()
	b, ok := m.bundles[id]
	return b, ok
}

// GetSHA256 returns the SHA256 hash of a bundle's base model file, or empty
// string if the bundle doesn't exist or hash is not computed.
func (m *Manager) GetSHA256(id string) string {
	m.mu.RLock()
	defer m.mu.RUnlock()
	b, ok := m.bundles[id]
	if !ok {
		return ""
	}
	return b.BaseModel.SHA256
}

// FindByPath returns the existing bundle whose base model path matches the
// given file path (case-insensitive, path-normalized). Used to reject
// duplicate imports so re-scanning a folder never re-adds the same model.
func (m *Manager) FindByPath(path string) (*Bundle, bool) {
	if path == "" {
		return nil, false
	}
	lower := strings.ToLower(filepath.Clean(path))
	m.mu.RLock()
	defer m.mu.RUnlock()
	for _, b := range m.bundles {
		if b.BaseModel.Path == "" {
			continue
		}
		if strings.ToLower(filepath.Clean(b.BaseModel.Path)) == lower {
			return b, true
		}
	}
	return nil, false
}

// Add stores a new bundle, assigning ID/timestamps if empty.
func (m *Manager) Add(b *Bundle) error {
	if b == nil {
		return errors.New("nil bundle")
	}
	m.mu.Lock()
	if b.ID == "" {
		b.ID = newID("bundle")
	}
	now := time.Now().UTC().Format(time.RFC3339)
	if b.CreatedAt == "" {
		b.CreatedAt = now
	}
	b.UpdatedAt = now
	m.bundles[b.ID] = b
	m.mu.Unlock()
	// Note: Save must run OUTSIDE the write lock (RWMutex is not reentrant).
	return m.Save()
}

// Update replaces an existing bundle.
func (m *Manager) Update(b *Bundle) error {
	if b == nil || b.ID == "" {
		return errors.New("bundle id required")
	}
	m.mu.Lock()
	if _, ok := m.bundles[b.ID]; !ok {
		m.mu.Unlock()
		return fmt.Errorf("bundle %q not found", b.ID)
	}
	b.UpdatedAt = time.Now().UTC().Format(time.RFC3339)
	m.bundles[b.ID] = b
	m.mu.Unlock()
	return m.Save()
}

// Delete removes a bundle.
func (m *Manager) Delete(id string) error {
	m.mu.Lock()
	if _, ok := m.bundles[id]; !ok {
		m.mu.Unlock()
		return fmt.Errorf("bundle %q not found", id)
	}
	delete(m.bundles, id)
	m.mu.Unlock()
	return m.Save()
}

// AddTestConfig appends a tested configuration to a bundle.
func (m *Manager) AddTestConfig(id string, tc TestConfig) (TestConfig, error) {
	m.mu.Lock()
	b, ok := m.bundles[id]
	if !ok {
		m.mu.Unlock()
		return tc, fmt.Errorf("bundle %q not found", id)
	}
	if tc.ID == "" {
		tc.ID = newID("cfg")
	}
	tc.CreatedAt = time.Now().UTC().Format(time.RFC3339)
	if tc.Meta.Date == "" {
		tc.Meta.Date = tc.CreatedAt
	}
	b.TestConfigs = append(b.TestConfigs, tc)
	// Cap the per-model history so saved best-configs can't grow without bound.
	const maxTestConfigs = 30
	if len(b.TestConfigs) > maxTestConfigs {
		b.TestConfigs = append([]TestConfig(nil), b.TestConfigs[len(b.TestConfigs)-maxTestConfigs:]...)
	}
	m.mu.Unlock()
	return tc, m.Save()
}

// RemoveTestConfig removes a tested configuration from a bundle.
func (m *Manager) RemoveTestConfig(id, cfgID string) error {
	m.mu.Lock()
	b, ok := m.bundles[id]
	if !ok {
		m.mu.Unlock()
		return fmt.Errorf("bundle %q not found", id)
	}
	out := b.TestConfigs[:0]
	for _, tc := range b.TestConfigs {
		if tc.ID != cfgID {
			out = append(out, tc)
		}
	}
	b.TestConfigs = out
	m.mu.Unlock()
	return m.Save()
}

// computeFileSHA256 calculates the SHA256 hash of a file.
// Returns empty string if the file cannot be read.
func computeFileSHA256(path string) string {
	f, err := os.Open(path)
	if err != nil {
		return ""
	}
	defer f.Close()
	h := sha256.New()
	if _, err := io.Copy(h, f); err != nil {
		return ""
	}
	return hex.EncodeToString(h.Sum(nil))
}

// AddFromGGUF parses a GGUF file and creates a bundle automatically,
// including companion detection (mmproj/draft/lora). name may be empty;
// it is inferred from the file name.
func (m *Manager) AddFromGGUF(path, name string, parseMetadata bool) (*Bundle, error) {
	b, err := NewFromGGUF(path, name, CompanionHints{})
	if err != nil {
		return nil, err
	}
	// Compute SHA256 if not already set
	if b.BaseModel.SHA256 == "" {
		b.BaseModel.SHA256 = computeFileSHA256(path)
	}
	if err := m.Add(b); err != nil {
		return nil, err
	}
	return b, nil
}

// defaultParamsFrom derives sensible defaults from GGUF metadata.
func defaultParamsFrom(info *gguf.ModelInfo) DefaultParams {
	dp := DefaultParams{
		LoadMode:  "auto", // 官方默认：auto（mmap 除非设备不支持）
		Samplers:  "penalties;dry;top_k;top_p;min_p;temperature",
		FlashAttn: "auto", // 官方默认：auto
	}
	if info != nil {
		dp.CtxSize = int(info.ContextLength)
		if dp.CtxSize == 0 {
			dp.CtxSize = 4096
		}
	}
	return dp
}

// detectTags guesses tags from metadata/file name so the UI can surface the
// model's capabilities (vision / MoE / reasoning / embedding / MTP head).
func detectTags(info *gguf.ModelInfo, name string) []string {
	var tags []string
	if info != nil {
		arch := strings.ToLower(info.Architecture)
		if strings.Contains(arch, "clip") || strings.Contains(arch, "vision") {
			tags = append(tags, "vision")
		}
		if info.IsMoE() {
			tags = append(tags, "moe")
		}
		if strings.Contains(arch, "bert") || strings.Contains(arch, "bge") ||
			strings.Contains(arch, "gte") || strings.Contains(arch, "embed") {
			tags = append(tags, "embedding")
		}
		tags = append(tags, info.Architecture)
	}
	lower := strings.ToLower(name)
	// MTP head: from file name/path OR the header tensor table, so models whose
	// name doesn't advertise MTP but embed a blk.*.nextn.* head are tagged too.
	if (info != nil && info.HasMTPHead()) ||
		strings.Contains(lower, "mtp") || strings.Contains(lower, "nextn") {
		tags = append(tags, "mtp")
	}
	// Reasoning/thinking models (e.g. DeepSeek-R1, Qwen3-thinking variants).
	if strings.Contains(lower, "r1") || strings.Contains(lower, "reasoning") ||
		strings.Contains(lower, "thinking") || strings.Contains(lower, "reflect") {
		tags = append(tags, "reasoning")
	}
	if strings.Contains(lower, "embed") || strings.Contains(lower, "bge") || strings.Contains(lower, "gte") {
		tags = append(tags, "embedding")
	}
	return tags
}

// fileInfo builds a ModelFile from a parsed GGUF.
func fileInfo(path string, info *gguf.ModelInfo) ModelFile {
	var sizeMB float64
	if fi, err := os.Stat(path); err == nil {
		sizeMB = float64(fi.Size()) / (1024 * 1024)
	}
	return ModelFile{
		Path:       path,
		FileSizeMB: sizeMB,
		Exists:     fileExists(path),
		Metadata:   info,
	}
}

func fileExists(path string) bool {
	_, err := os.Stat(path)
	return err == nil
}

// newID returns a short unique id with the given prefix. It uses crypto/rand
// so concurrent callers can never collide (a previous time-seeded version
// caused concurrent imports to overwrite each other).
func newID(prefix string) string {
	b := make([]byte, 4)
	if _, err := rand.Read(b); err != nil {
		// fallback: timestamp-based (last resort, still unique-ish)
		return fmt.Sprintf("%s_%d", prefix, time.Now().UnixNano())
	}
	return fmt.Sprintf("%s_%08x", prefix, b)
}
