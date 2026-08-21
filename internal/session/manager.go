// Package session manages running/stopped llama-server instances, including
// multi-instance concurrency and historical session persistence.
package session

import (
	"encoding/json"
	"fmt"
	"os"
	"path/filepath"
	"sort"
	"sync"
	"time"
)

// Status is the lifecycle state of a session.
type Status string

const (
	StatusStopped  Status = "stopped"
	StatusStarting Status = "starting"
	StatusRunning  Status = "running"
	StatusStopping Status = "stopping"
	StatusCrashed  Status = "crashed"
)

// Session records one launch of a model.
type Session struct {
	ID                   string         `json:"id"`
	BundleID             string         `json:"bundle_id"`
	PresetID             string         `json:"preset_id,omitempty"`
	BinaryVersion        string         `json:"binary_version,omitempty"`
	PID                  int            `json:"pid"`
	Port                 int            `json:"port"`
	CmdlineArgs          []string       `json:"cmdline_args"`
	Params               map[string]any `json:"params,omitempty"` // raw form params, reused on restart
	StartTime            string         `json:"start_time"`
	EndTime              *string        `json:"end_time,omitempty"`
	Status               Status         `json:"status"`
	ExitCode             *int           `json:"exit_code,omitempty"`
	LogFile              string         `json:"log_file,omitempty"`
	PeakVRAMGB           float64        `json:"peak_vram_gb"`
	PeakTPS              float64        `json:"peak_tps"`
	TotalTokensGenerated int64          `json:"total_tokens_generated"`
}

// Manager tracks all sessions and persists them under data/sessions/.
type Manager struct {
	dir      string
	mu       sync.RWMutex
	sessions map[string]*Session
}

// NewManager creates a session manager rooted at dir.
func NewManager(dir string) (*Manager, error) {
	m := &Manager{dir: dir, sessions: make(map[string]*Session)}
	if err := m.Load(); err != nil {
		return nil, err
	}
	return m, nil
}

// Load reads all historical session files (data/sessions/<date>/session_*.json).
func (m *Manager) Load() error {
	m.mu.Lock()
	defer m.mu.Unlock()
	m.sessions = make(map[string]*Session)
	_ = filepath.WalkDir(m.dir, func(path string, d os.DirEntry, err error) error {
		if err != nil || d.IsDir() {
			return nil
		}
		if filepath.Ext(path) != ".json" {
			return nil
		}
		data, err := os.ReadFile(path)
		if err != nil {
			return nil
		}
		var s Session
		if json.Unmarshal(data, &s) == nil && s.ID != "" {
			m.sessions[s.ID] = &s
		}
		return nil
	})
	return nil
}

// Create registers a new session (not yet saved).
func (m *Manager) Create(bundleID, presetID, binaryVersion string, port int) *Session {
	now := time.Now().UTC()
	s := &Session{
		ID:            fmt.Sprintf("session_%d", now.UnixNano()),
		BundleID:      bundleID,
		PresetID:      presetID,
		BinaryVersion: binaryVersion,
		Port:          port,
		StartTime:     now.Format(time.RFC3339),
		Status:        StatusStarting,
	}
	m.mu.Lock()
	m.sessions[s.ID] = s
	m.mu.Unlock()
	return s
}

// Get returns a session by ID.
func (m *Manager) Get(id string) (*Session, bool) {
	m.mu.RLock()
	defer m.mu.RUnlock()
	s, ok := m.sessions[id]
	return s, ok
}

// List returns all sessions (newest first).
func (m *Manager) List() []*Session {
	m.mu.RLock()
	defer m.mu.RUnlock()
	out := make([]*Session, 0, len(m.sessions))
	for _, s := range m.sessions {
		out = append(out, s)
	}
	sort.Slice(out, func(i, j int) bool { return out[i].StartTime > out[j].StartTime })
	return out
}

// Update mutates a session and persists it to disk.
func (m *Manager) Update(s *Session) error {
	m.mu.Lock()
	if _, ok := m.sessions[s.ID]; !ok {
		m.mu.Unlock()
		return fmt.Errorf("session %q not found", s.ID)
	}
	m.sessions[s.ID] = s
	m.mu.Unlock()
	return m.save(s)
}

// save writes one session JSON into the date-partitioned directory.
func (m *Manager) save(s *Session) error {
	day := s.StartTime[:10] // YYYY-MM-DD
	dir := filepath.Join(m.dir, day)
	if err := os.MkdirAll(dir, 0o755); err != nil {
		return err
	}
	data, err := json.MarshalIndent(s, "", "  ")
	if err != nil {
		return err
	}
	return os.WriteFile(filepath.Join(dir, s.ID+".json"), data, 0o644)
}

// RunningCount returns how many sessions are currently active.
func (m *Manager) RunningCount() int {
	m.mu.RLock()
	defer m.mu.RUnlock()
	n := 0
	for _, s := range m.sessions {
		if s.Status == StatusRunning || s.Status == StatusStarting {
			n++
		}
	}
	return n
}

// PortInUse reports whether any active session occupies the port.
func (m *Manager) PortInUse(port int) (string, bool) {
	m.mu.RLock()
	defer m.mu.RUnlock()
	for _, s := range m.sessions {
		if s.Port == port && (s.Status == StatusRunning || s.Status == StatusStarting) {
			return s.ID, true
		}
	}
	return "", false
}

// BundleInUse reports whether a bundle is already running.
func (m *Manager) BundleInUse(bundleID string) (string, bool) {
	m.mu.RLock()
	defer m.mu.RUnlock()
	for _, s := range m.sessions {
		if s.BundleID == bundleID && (s.Status == StatusRunning || s.Status == StatusStarting) {
			return s.ID, true
		}
	}
	return "", false
}
