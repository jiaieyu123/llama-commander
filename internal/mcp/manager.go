// Package mcp manages MCP (Model Context Protocol) servers that a model can
// be launched with. Skeleton: registration + status; tool-level monitoring
// arrives in a later phase.
package mcp

import (
	"encoding/json"
	"os"
	"path/filepath"
	"sync"
	"time"
)

// Server describes one registered MCP server.
type Server struct {
	ID      string   `json:"id"`
	Name    string   `json:"name"`
	Command string   `json:"command"`
	Args    []string `json:"args"`
	Env     []string `json:"env,omitempty"`
	Enabled bool     `json:"enabled"`
	Notes   string   `json:"notes,omitempty"`
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

// Add registers a new server.
func (m *Manager) Add(s *Server) error {
	if s.ID == "" {
		s.ID = "mcp_" + time.Now().Format("150405")
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
