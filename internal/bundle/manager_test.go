package bundle

import (
	"bytes"
	"encoding/binary"
	"fmt"
	"llama-commander/internal/gguf"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"testing"
)

func mustWrite(t *testing.T, path string, data []byte) {
	t.Helper()
	if err := os.WriteFile(path, data, 0o644); err != nil {
		t.Fatal(err)
	}
}

// fakeGGUF builds a minimal valid GGUF with 4 metadata keys.
func fakeGGUF(t *testing.T, arch string, ctx, blocks uint64, ftype uint32) []byte {
	t.Helper()
	var buf bytes.Buffer
	le := binary.LittleEndian
	var u32 [4]byte
	var u64 [8]byte
	buf.WriteString("GGUF")
	le.PutUint32(u32[:], 3)
	buf.Write(u32[:]) // version
	le.PutUint64(u64[:], 0)
	buf.Write(u64[:]) // tensor count
	le.PutUint64(u64[:], 4)
	buf.Write(u64[:]) // kv count
	writeStr := func(s string) {
		le.PutUint64(u64[:], uint64(len(s)))
		buf.Write(u64[:])
		buf.WriteString(s)
	}
	writeStr("general.architecture")
	le.PutUint32(u32[:], 8) // TypeString
	buf.Write(u32[:])
	writeStr(arch)
	writeStr(arch + ".context_length")
	le.PutUint32(u32[:], 10) // TypeUint64
	buf.Write(u32[:])
	le.PutUint64(u64[:], ctx)
	buf.Write(u64[:])
	writeStr(arch + ".block_count")
	le.PutUint32(u32[:], 10)
	buf.Write(u32[:])
	le.PutUint64(u64[:], blocks)
	buf.Write(u64[:])
	writeStr("general.file_type")
	le.PutUint32(u32[:], 4) // TypeUint32
	buf.Write(u32[:])
	le.PutUint32(u32[:], ftype)
	buf.Write(u32[:])
	return buf.Bytes()
}

// TestManagerCRUD exercises the full CRUD cycle. This also guards against the
// RWMutex re-entrancy deadlock that occurred when Save() was called inside
// the write lock (Add/Update/Delete).
func TestManagerCRUD(t *testing.T) {
	dir := t.TempDir()
	m, err := NewManager(filepath.Join(dir, "bundles.json"))
	if err != nil {
		t.Fatalf("NewManager: %v", err)
	}
	b := &Bundle{Name: "Test Model", SourceType: SourceLocal, Tags: []string{"test"}}
	if err := m.Add(b); err != nil {
		t.Fatalf("Add: %v", err)
	}
	if b.ID == "" {
		t.Fatal("Add did not assign an ID")
	}
	if len(m.List()) != 1 {
		t.Fatalf("List length = %d, want 1", len(m.List()))
	}
	got, ok := m.Get(b.ID)
	if !ok || got.Name != "Test Model" {
		t.Fatalf("Get = %+v, %v", got, ok)
	}

	// Update
	b.Name = "Renamed"
	if err := m.Update(b); err != nil {
		t.Fatalf("Update: %v", err)
	}
	got, _ = m.Get(b.ID)
	if got.Name != "Renamed" {
		t.Fatalf("after update name = %q", got.Name)
	}

	// Persistence: reload from disk and confirm the update survived.
	m2, err := NewManager(filepath.Join(dir, "bundles.json"))
	if err != nil {
		t.Fatalf("reload: %v", err)
	}
	if len(m2.List()) != 1 || m2.List()[0].Name != "Renamed" {
		t.Fatalf("reloaded list mismatch: %+v", m2.List())
	}

	// Delete
	if err := m.Delete(b.ID); err != nil {
		t.Fatalf("Delete: %v", err)
	}
	if _, ok := m.Get(b.ID); ok {
		t.Fatal("bundle still present after delete")
	}
}

// TestConcurrentAdd runs many Add calls in parallel and verifies every one
// survives (no ID collisions, no lost updates, no .tmp file conflicts).
func TestConcurrentAdd(t *testing.T) {
	dir := t.TempDir()
	m, err := NewManager(filepath.Join(dir, "bundles.json"))
	if err != nil {
		t.Fatalf("NewManager: %v", err)
	}
	const n = 32
	var wg sync.WaitGroup
	for i := 0; i < n; i++ {
		wg.Add(1)
		go func(i int) {
			defer wg.Done()
			b := &Bundle{Name: fmt.Sprintf("model-%d", i), SourceType: SourceLocal}
			if err := m.Add(b); err != nil {
				t.Errorf("Add %d: %v", i, err)
			}
		}(i)
	}
	wg.Wait()
	if got := len(m.List()); got != n {
		t.Fatalf("expected %d bundles, got %d (ID collision or lost update)", n, got)
	}
	// Reload from disk and confirm everything persisted.
	m2, err := NewManager(filepath.Join(dir, "bundles.json"))
	if err != nil {
		t.Fatalf("reload: %v", err)
	}
	if got := len(m2.List()); got != n {
		t.Fatalf("reloaded %d bundles, want %d", got, n)
	}
}

// TestScanDir verifies scan-based discovery, shard grouping and companion
// detection on a synthetic tree.
func TestScanDir(t *testing.T) {
	root := t.TempDir()
	mustWrite(t, filepath.Join(root, "model.Q4_K_M.gguf"), fakeGGUF(t, "llama", 8192, 32, 17))
	mustWrite(t, filepath.Join(root, "model-mmproj.gguf"), fakeGGUF(t, "clip", 4096, 24, 1))
	mustWrite(t, filepath.Join(root, "model-draft.gguf"), fakeGGUF(t, "llama", 4096, 12, 16))
	mustWrite(t, filepath.Join(root, "big-00001-of-00002.gguf"), fakeGGUF(t, "llama", 32768, 64, 17))
	mustWrite(t, filepath.Join(root, "big-00002-of-00002.gguf"), fakeGGUF(t, "llama", 32768, 64, 17))

	cands, skipped, err := ScanDir(root)
	if err != nil {
		t.Fatalf("ScanDir: %v", err)
	}
	if len(skipped) != 0 {
		t.Fatalf("expected no skipped files, got %v", skipped)
	}
	if len(cands) != 2 {
		t.Fatalf("expected 2 primary candidates, got %d", len(cands))
	}
	byName := map[string]*Candidate{}
	for _, c := range cands {
		byName[c.Bundle.Name] = c
	}
	if m := byName["model.Q4_K_M.gguf"]; m == nil {
		t.Fatal("primary model.Q4_K_M.gguf not found")
	} else {
		if m.Bundle.MMProj.Path == "" {
			t.Error("mmproj companion not attached")
		}
		if !m.Bundle.DraftModel.Enabled {
			t.Error("draft companion not attached")
		}
		if m.Bundle.BaseModel.Metadata == nil || m.Bundle.BaseModel.Metadata.ContextLength != 8192 {
			t.Errorf("metadata parse failed: %+v", m.Bundle.BaseModel.Metadata)
		}
	}
	if s := byName["big-00001-of-00002.gguf"]; s == nil {
		t.Fatal("sharded candidate not found")
	} else if !s.Bundle.ShardInfo.IsSharded || s.Bundle.ShardInfo.TotalShards != 2 {
		t.Errorf("shard info wrong: %+v", s.Bundle.ShardInfo)
	}
}

// TestMetadataPrune guards the bundles.json slim-down: the raw GGUF metadata
// map (tokenizer vocab etc., tens of MB per model) must be dropped on save
// and load, while the typed display/config fields and MoE detection survive.
func TestMetadataPrune(t *testing.T) {
	dir := t.TempDir()
	path := filepath.Join(dir, "bundles.json")
	m, err := NewManager(path)
	if err != nil {
		t.Fatalf("NewManager: %v", err)
	}

	big := strings.Repeat("x", 1024*1024) // 1 MiB fake vocab payload
	md := &gguf.ModelInfo{
		Architecture:  "qwen2vl",
		ContextLength: 32768,
		BlockCount:    32,
		NumExperts:    8,
		FileType:      7,
		FileTypeName:  "Q8_0",
		Moe:           true,
		Metadata: map[string]any{
			"general.architecture":  "qwen2vl",
			"tokenizer.ggml.tokens": []any{big},
		},
	}
	b := &Bundle{Name: "VL", BaseModel: ModelFile{Path: "x.gguf", Metadata: md}}
	if err := m.Add(b); err != nil {
		t.Fatalf("Add: %v", err)
	}

	data, err := os.ReadFile(path)
	if err != nil {
		t.Fatal(err)
	}
	if strings.Contains(string(data), big) {
		t.Fatal("bundles.json still contains the raw metadata map (not pruned)")
	}
	if !strings.Contains(string(data), `"expert_count": 8`) {
		t.Fatalf("typed expert_count not persisted:\n%s", data)
	}

	// Reload: raw map gone from memory, typed fields and MoE detection intact.
	m2, err := NewManager(path)
	if err != nil {
		t.Fatalf("reload: %v", err)
	}
	got := m2.List()[0]
	if got.BaseModel.Metadata == nil {
		t.Fatal("metadata typed fields lost on reload")
	}
	if got.BaseModel.Metadata.Metadata != nil {
		t.Fatal("raw metadata map still present after reload")
	}
	if got.BaseModel.Metadata.Architecture != "qwen2vl" || got.BaseModel.Metadata.ContextLength != 32768 {
		t.Fatalf("typed fields lost: %+v", got.BaseModel.Metadata)
	}
	if !got.BaseModel.Metadata.IsMoE() {
		t.Fatal("IsMoE should be true after prune")
	}
	if got.BaseModel.Metadata.ExpertCount() != 8 {
		t.Fatalf("ExpertCount = %d, want 8", got.BaseModel.Metadata.ExpertCount())
	}
}

// TestTestConfigCap verifies per-model saved configs are capped so they can't
// accumulate without bound.
func TestTestConfigCap(t *testing.T) {
	dir := t.TempDir()
	m, err := NewManager(filepath.Join(dir, "bundles.json"))
	if err != nil {
		t.Fatalf("NewManager: %v", err)
	}
	b := &Bundle{Name: "Cap"}
	if err := m.Add(b); err != nil {
		t.Fatalf("Add: %v", err)
	}
	for i := 0; i < 40; i++ {
		if _, err := m.AddTestConfig(b.ID, TestConfig{Name: fmt.Sprintf("cfg%d", i)}); err != nil {
			t.Fatalf("AddTestConfig %d: %v", i, err)
		}
	}
	got, _ := m.Get(b.ID)
	if len(got.TestConfigs) > 30 {
		t.Fatalf("test configs = %d, want capped at 30", len(got.TestConfigs))
	}
	if got.TestConfigs[len(got.TestConfigs)-1].Name != "cfg39" {
		t.Fatalf("newest config should be kept, got %q", got.TestConfigs[len(got.TestConfigs)-1].Name)
	}
}
