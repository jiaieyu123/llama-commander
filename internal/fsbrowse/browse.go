// Package fsbrowse lists directories and .gguf files for the built-in file
// browser in the "添加模型" flow.
package fsbrowse

import (
	"os"
	"path/filepath"
	"runtime"
	"sort"
	"strings"
)

// Entry is a single directory or .gguf file.
type Entry struct {
	Name  string `json:"name"`
	Path  string `json:"path"`
	Size  int64  `json:"size"`
	IsDir bool   `json:"is_dir"`
}

// Result is a directory listing.
type Result struct {
	Path   string  `json:"path"`
	Parent string  `json:"parent"` // "" when at root
	IsRoot bool    `json:"is_root"`
	Dirs   []Entry `json:"dirs"`
	Files  []Entry `json:"files"` // only *.gguf
}

// List returns the contents of a directory. An empty path lists drive roots
// on Windows or "/" elsewhere.
func List(path string) (*Result, error) {
	if strings.TrimSpace(path) == "" {
		return listRoots()
	}
	info, err := os.Stat(path)
	if err != nil {
		return nil, err
	}
	if !info.IsDir() {
		path = filepath.Dir(path) // allow selecting a file → show its parent
	}
	entries, err := os.ReadDir(path)
	if err != nil {
		return nil, err
	}
	res := &Result{Path: path, Parent: parentOf(path), IsRoot: isRoot(path), Dirs: []Entry{}, Files: []Entry{}}
	for _, e := range entries {
		full := filepath.Join(path, e.Name())
		if e.IsDir() {
			res.Dirs = append(res.Dirs, Entry{Name: e.Name(), Path: full, IsDir: true})
			continue
		}
		if !strings.HasSuffix(strings.ToLower(e.Name()), ".gguf") {
			continue
		}
		var size int64
		if fi, err := e.Info(); err == nil {
			size = fi.Size()
		}
		res.Files = append(res.Files, Entry{Name: e.Name(), Path: full, Size: size})
	}
	sort.Slice(res.Dirs, func(i, j int) bool { return strings.ToLower(res.Dirs[i].Name) < strings.ToLower(res.Dirs[j].Name) })
	sort.Slice(res.Files, func(i, j int) bool { return strings.ToLower(res.Files[i].Name) < strings.ToLower(res.Files[j].Name) })
	return res, nil
}

func listRoots() (*Result, error) {
	if runtime.GOOS == "windows" {
		var dirs []Entry
		for _, d := range "CDEFGHIJKLMNOPQRSTUVWXYZ" {
			p := string(d) + ":\\"
			if fi, err := os.Stat(p); err == nil && fi.IsDir() {
				dirs = append(dirs, Entry{Name: string(d) + ":\\", Path: p, IsDir: true})
			}
		}
		if dirs == nil {
			dirs = []Entry{}
		}
		return &Result{Path: "", Parent: "", IsRoot: true, Dirs: dirs, Files: []Entry{}}, nil
	}
	return &Result{Path: "/", Parent: "", IsRoot: true, Dirs: []Entry{{Name: "/", Path: "/", IsDir: true}}, Files: []Entry{}}, nil
}

func parentOf(p string) string {
	parent := filepath.Dir(p)
	if parent == p {
		return "" // already at root
	}
	return parent
}

func isRoot(p string) bool {
	return parentOf(p) == ""
}
