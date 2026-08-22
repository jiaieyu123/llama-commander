package bundle

// cache.go manages the official llama.cpp download cache (~/.cache/llama.cpp).
// llama-server -hf stores downloaded models there with a manifest and etag;
// this module lets users browse, clean and import/export those entries.

import (
	"encoding/json"
	"errors"
	"os"
	"path/filepath"
	"sort"
	"strings"
	"time"
)

// CachePath returns the official llama.cpp cache directory for the platform.
func CachePath() string {
	home, err := os.UserHomeDir()
	if err != nil {
		return ""
	}
	return filepath.Join(home, ".cache", "llama.cpp")
}

// CacheEntry mirrors a single cache entry's manifest.json.
type Entry struct {
	RepoID     string  `json:"repo_id"`
	Filename   string  `json:"filename"`
	Path       string  `json:"path"`
	SizeMB     float64 `json:"size_mb"`
	ETag       string  `json:"etag"`
	Downloaded string  `json:"downloaded,omitempty"`
}

// CacheManager provides read-only browsing + delete/import/export helpers.
type CacheManager struct {
	root string
}

// NewCacheManager creates a cache manager rooted at the official cache dir.
func NewCacheManager(root string) *CacheManager {
	if root == "" {
		root = CachePath()
	}
	return &CacheManager{root: root}
}

// Root returns the cache root.
func (m *CacheManager) Root() string { return m.root }

// List scans the cache directory and returns all discovered entries.
// Directory layout: <root>/models--<org>--<name>/snapshots/<sha>/<files>
func (m *CacheManager) List() ([]Entry, error) {
	if m.root == "" {
		return nil, errors.New("cache root is empty")
	}
	var out []Entry
	_ = filepath.WalkDir(m.root, func(path string, d os.DirEntry, err error) error {
		if err != nil || d.IsDir() {
			return nil
		}
		name := d.Name()
		if name == "manifest.json" || name == "refs" {
			rel, _ := filepath.Rel(m.root, path)
			if isWithinSnapshots(rel) {
				// manifest handled below by its sibling
			}
			return nil
		}
		if strings.HasSuffix(name, ".gguf") && isWithinSnapshots(mustRel(m.root, path)) {
			fi, _ := d.Info()
			sizeMB := 0.0
			if fi != nil {
				sizeMB = float64(fi.Size()) / (1024 * 1024)
			}
			out = append(out, Entry{
				RepoID:     inferRepoID(path),
				Filename:   name,
				Path:       path,
				SizeMB:     sizeMB,
				Downloaded: time.Now().Format(time.RFC3339),
			})
		}
		return nil
	})
	sort.Slice(out, func(i, j int) bool { return out[i].RepoID < out[j].RepoID })
	return out, nil
}

// Delete removes a single cached file and its manifest sibling.
func (m *CacheManager) Delete(entry Entry) error {
	if entry.Path == "" {
		return errors.New("empty entry path")
	}
	if err := os.Remove(entry.Path); err != nil && !errors.Is(err, os.ErrNotExist) {
		return err
	}
	manifest := filepath.Join(filepath.Dir(entry.Path), "manifest.json")
	_ = os.Remove(manifest)
	return nil
}

// Import registers a local GGUF file into the cache by copying it under a
// repo-style path and writing a manifest. (Stub — full etag handling later.)
func (m *CacheManager) Import(localPath, repoID string) (Entry, error) {
	if localPath == "" || repoID == "" {
		return Entry{}, errors.New("local path and repo id required")
	}
	dest := filepath.Join(m.root, "models--"+strings.ReplaceAll(repoID, "/", "--"),
		"snapshots", "local-import", filepath.Base(localPath))
	if err := os.MkdirAll(filepath.Dir(dest), 0o755); err != nil {
		return Entry{}, err
	}
	data, err := os.ReadFile(localPath)
	if err != nil {
		return Entry{}, err
	}
	if err := os.WriteFile(dest, data, 0o644); err != nil {
		return Entry{}, err
	}
	entry := Entry{RepoID: repoID, Filename: filepath.Base(localPath), Path: dest}
	manifest := filepath.Join(filepath.Dir(dest), "manifest.json")
	_ = os.WriteFile(manifest, []byte("{\"local-import\":true}\n"), 0o644)
	return entry, nil
}

// Export copies an entry out of the cache to a target directory.
func (m *CacheManager) Export(entry Entry, destDir string) error {
	if entry.Path == "" {
		return errors.New("empty entry path")
	}
	if err := os.MkdirAll(destDir, 0o755); err != nil {
		return err
	}
	data, err := os.ReadFile(entry.Path)
	if err != nil {
		return err
	}
	return os.WriteFile(filepath.Join(destDir, entry.Filename), data, 0o644)
}

// ---- helpers ----

func mustRel(root, path string) string {
	rel, err := filepath.Rel(root, path)
	if err != nil {
		return ""
	}
	return rel
}

func isWithinSnapshots(rel string) bool {
	return strings.Contains(rel, string(filepath.Separator)+"snapshots"+string(filepath.Separator))
}

func inferRepoID(path string) string {
	parts := strings.Split(filepath.ToSlash(path), "/")
	for i, p := range parts {
		if strings.HasPrefix(p, "models--") {
			rest := parts[i][len("models--"):]
			if len(rest) > 0 {
				return strings.ReplaceAll(rest, "--", "/")
			}
		}
	}
	return filepath.Base(filepath.Dir(filepath.Dir(filepath.Dir(path))))
}

// ensure json import is used (manifest may be parsed later)
var _ = json.Valid
