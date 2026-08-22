// Package mcp manages MCP (Model Context Protocol) servers that a model can
// be launched with. Skeleton: registration + status; tool-level monitoring
// arrives in a later phase.
package mcp

import (
	"encoding/json"
	"fmt"
	"os"
	"path/filepath"
	"sync"
	"sync/atomic"
	"time"
)

// Server describes one registered MCP server.
type Server struct {
	ID      string            `json:"id"`
	Name    string            `json:"name"`
	Command string            `json:"command"`
	Args    []string          `json:"args,omitempty"`
	Env     map[string]string `json:"env,omitempty"`
	Enabled bool              `json:"enabled"`
	Notes   string            `json:"notes,omitempty"`
}

// cursorConfig is the llama.cpp / Cursor-compatible MCP definition format
// (see llama.cpp tools/server/README.md: --mcp-servers-json).
type cursorConfig struct {
	MCPServers map[string]cursorServer `json:"mcpServers"`
}

type cursorServer struct {
	Command string            `json:"command"`
	Args    []string          `json:"args,omitempty"`
	Env     map[string]string `json:"env,omitempty"`
}

// Status is a lightweight runtime status snapshot.
type Status struct {
	ServerID string `json:"server_id"`
	Running  bool   `json:"running"`
	PID      int    `json:"pid,omitempty"`
	Tools    int    `json:"tools,omitempty"`
	Updated  string `json:"updated"`
}

// Manager stores MCP server definitions in data/mcp.json.
type Manager struct {
	path    string
	mu      sync.RWMutex
	servers map[string]*Server
}

// NewManager loads the MCP registry.
func NewManager(path string) (*Manager, error) {
	m := &Manager{path: path, servers: make(map[string]*Server)}
	data, err := os.ReadFile(path)
	if err != nil {
		if os.IsNotExist(err) {
			return m, nil
		}
		return nil, err
	}
	var list []*Server
	if err := json.Unmarshal(data, &list); err != nil {
		return nil, err
	}
	for _, s := range list {
		if s.Env == nil {
			s.Env = map[string]string{}
		}
		m.servers[s.ID] = s
	}
	return m, nil
}

// List returns registered servers.
func (m *Manager) List() []*Server {
	m.mu.RLock()
	defer m.mu.RUnlock()
	out := make([]*Server, 0, len(m.servers))
	for _, s := range m.servers {
		out = append(out, s)
	}
	return out
}

// mcpSeq 保证同一时间戳内生成的 ID 也唯一（Windows 上 time.Now 精度约 1ms，
// 纯纳秒时间戳在快速连续注册时会碰撞互相覆盖）。
var mcpSeq atomic.Uint64

// Add registers a new server.
func (m *Manager) Add(s *Server) error {
	if s.ID == "" {
		s.ID = fmt.Sprintf("mcp_%d_%d", time.Now().UnixNano(), mcpSeq.Add(1))
	}
	if s.Env == nil {
		s.Env = map[string]string{}
	}
	m.mu.Lock()
	m.servers[s.ID] = s
	err := m.save()
	m.mu.Unlock()
	return err
}

// Remove unregisters a server.
func (m *Manager) Remove(id string) error {
	m.mu.Lock()
	defer m.mu.Unlock()
	delete(m.servers, id)
	return m.save()
}

// GetByName looks up a server by its display name (unique per registered tool).
func (m *Manager) GetByName(name string) (*Server, bool) {
	m.mu.RLock()
	defer m.mu.RUnlock()
	for _, s := range m.servers {
		if s.Name == name {
			return s, true
		}
	}
	return nil, false
}

// ToCursorJSON converts the servers whose names are listed (and enabled) into
// the Cursor-compatible JSON string expected by llama.cpp --mcp-servers-json.
// Returns "" when none of the requested servers are enabled (nothing to inject).
func (m *Manager) ToCursorJSON(names []string) (string, error) {
	m.mu.RLock()
	defer m.mu.RUnlock()
	cfg := cursorConfig{MCPServers: make(map[string]cursorServer)}
	for _, name := range names {
		for _, s := range m.servers {
			if s.Name != name || !s.Enabled {
				continue
			}
			sc := cursorServer{Command: s.Command, Args: append([]string{}, s.Args...)}
			if len(s.Env) > 0 {
				sc.Env = make(map[string]string, len(s.Env))
				for k, v := range s.Env {
					sc.Env[k] = v
				}
			}
			cfg.MCPServers[name] = sc
			break
		}
	}
	if len(cfg.MCPServers) == 0 {
		return "", nil
	}
	data, err := json.Marshal(cfg)
	if err != nil {
		return "", err
	}
	return string(data), nil
}

func (m *Manager) save() error {
	list := make([]*Server, 0, len(m.servers))
	for _, s := range m.servers {
		list = append(list, s)
	}
	if err := os.MkdirAll(filepath.Dir(m.path), 0o755); err != nil {
		return err
	}
	data, err := json.MarshalIndent(list, "", "  ")
	if err != nil {
		return err
	}
	return os.WriteFile(m.path, data, 0o644)
}
