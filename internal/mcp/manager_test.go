package mcp

import (
	"encoding/json"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

func newTestManager(t *testing.T) (*Manager, string) {
	t.Helper()
	dir := t.TempDir()
	path := filepath.Join(dir, "mcp.json")
	m, err := NewManager(path)
	if err != nil {
		t.Fatalf("NewManager: %v", err)
	}
	return m, path
}

func TestManagerCRUD(t *testing.T) {
	m, path := newTestManager(t)

	if err := m.Add(&Server{Name: "filesystem", Command: "npx", Args: []string{"-y", "server-filesystem", "D:/"}, Enabled: true}); err != nil {
		t.Fatalf("Add: %v", err)
	}
	if len(m.List()) != 1 {
		t.Fatalf("List: want 1 got %d", len(m.List()))
	}

	// 持久化后重新加载
	m2, err := NewManager(path)
	if err != nil {
		t.Fatalf("NewManager reload: %v", err)
	}
	if len(m2.List()) != 1 {
		t.Fatalf("reload: want 1 got %d", len(m2.List()))
	}
	s := m2.List()[0]
	if s.Name != "filesystem" || s.Command != "npx" || !s.Enabled {
		t.Fatalf("reload server mismatch: %+v", s)
	}
	if s.Env == nil {
		t.Fatalf("Env should be non-nil after load")
	}

	if err := m.Remove(s.ID); err != nil {
		t.Fatalf("Remove: %v", err)
	}
	if len(m.List()) != 0 {
		t.Fatalf("Remove: want 0 got %d", len(m.List()))
	}
}

func TestGetByName(t *testing.T) {
	m, _ := newTestManager(t)
	if err := m.Add(&Server{Name: "memory", Command: "npx", Enabled: true}); err != nil {
		t.Fatalf("Add: %v", err)
	}
	s, ok := m.GetByName("memory")
	if !ok || s.Command != "npx" {
		t.Fatalf("GetByName memory: ok=%v s=%+v", ok, s)
	}
	if _, ok := m.GetByName("missing"); ok {
		t.Fatalf("GetByName missing should be false")
	}
}

func TestToCursorJSON(t *testing.T) {
	m, _ := newTestManager(t)
	mustAdd := func(name string, enabled bool) {
		t.Helper()
		if err := m.Add(&Server{Name: name, Command: "npx", Args: []string{"-y", name}, Env: map[string]string{"K": "V"}, Enabled: enabled}); err != nil {
			t.Fatalf("Add %s: %v", name, err)
		}
	}
	mustAdd("filesystem", true)
	mustAdd("memory", true)
	mustAdd("disabled", false)

	// 只取启用的
	out, err := m.ToCursorJSON([]string{"filesystem", "disabled", "memory"})
	if err != nil {
		t.Fatalf("ToCursorJSON: %v", err)
	}
	var cfg cursorConfig
	if err := json.Unmarshal([]byte(out), &cfg); err != nil {
		t.Fatalf("unmarshal: %v", err)
	}
	if len(cfg.MCPServers) != 2 {
		t.Fatalf("want 2 servers got %d: %s", len(cfg.MCPServers), out)
	}
	fs, ok := cfg.MCPServers["filesystem"]
	if !ok || fs.Command != "npx" || len(fs.Args) != 2 || fs.Env["K"] != "V" {
		t.Fatalf("filesystem config mismatch: %+v", fs)
	}
	if _, ok := cfg.MCPServers["disabled"]; ok {
		t.Fatalf("disabled server should be skipped")
	}

	// 不存在的名字 → 空
	out, err = m.ToCursorJSON([]string{"nonexistent"})
	if err != nil {
		t.Fatalf("ToCursorJSON empty: %v", err)
	}
	if out != "" {
		t.Fatalf("empty config should return \"\", got %q", out)
	}

	// 全部 disabled → 空
	out, err = m.ToCursorJSON([]string{"disabled"})
	if err != nil || out != "" {
		t.Fatalf("all-disabled should return \"\", got %q err %v", out, err)
	}
}

func TestLoadCompatMissingFields(t *testing.T) {
	// 模拟旧数据：无 Env 字段、无 enabled 字段
	dir := t.TempDir()
	path := filepath.Join(dir, "mcp.json")
	legacy := `[{"id":"mcp_1","name":"old","command":"npx","args":["-y","x"]}]`
	if err := os.WriteFile(path, []byte(legacy), 0o644); err != nil {
		t.Fatalf("write: %v", err)
	}
	m, err := NewManager(path)
	if err != nil {
		t.Fatalf("NewManager: %v", err)
	}
	if len(m.List()) != 1 {
		t.Fatalf("want 1 server got %d", len(m.List()))
	}
	s := m.List()[0]
	if s.Env == nil {
		t.Fatalf("legacy Env should be initialized to empty map, got nil")
	}
	// 旧数据没有 enabled → 反序列化为 false，但不应 panic；ToCursorJSON 应跳过它
	out, err := m.ToCursorJSON([]string{"old"})
	if err != nil {
		t.Fatalf("ToCursorJSON: %v", err)
	}
	if out != "" {
		t.Fatalf("legacy disabled server should be skipped, got %q", out)
	}
}

func TestManagerPersistsEnv(t *testing.T) {
	m, path := newTestManager(t)
	if err := m.Add(&Server{Name: "github", Command: "npx", Env: map[string]string{"GITHUB_TOKEN": "abc"}, Enabled: true}); err != nil {
		t.Fatalf("Add: %v", err)
	}
	m2, err := NewManager(path)
	if err != nil {
		t.Fatalf("reload: %v", err)
	}
	s, ok := m2.GetByName("github")
	if !ok {
		t.Fatalf("github not found after reload")
	}
	if s.Env["GITHUB_TOKEN"] != "abc" {
		t.Fatalf("Env not persisted: %+v", s.Env)
	}
	// 确保输出是合法 JSON 且含 env
	out, _ := m2.ToCursorJSON([]string{"github"})
	if !strings.Contains(out, "GITHUB_TOKEN") || !strings.Contains(out, "mcpServers") {
		t.Fatalf("cursor json missing env: %s", out)
	}
}
