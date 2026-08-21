// Package downloader implements model downloads from HuggingFace with
// resumable (HTTP Range) transfers, mirror support via the HF_ENDPOINT env
// var, and a repo-style cache layout compatible with llama.cpp:
//
//	<root>/models--org--name/snapshots/<revision>/<file>
package downloader

import (
	"context"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"os"
	"path/filepath"
	"sort"
	"strings"
)

var endpointOverride string

// SetEndpoint overrides the HF base URL at runtime (empty resets to env/default).
func SetEndpoint(ep string) { endpointOverride = ep }

// Endpoint returns the HF base URL. Priority: runtime override > HF_ENDPOINT
// env (mirror) > https://huggingface.co.
func Endpoint() string {
	if endpointOverride != "" {
		return strings.TrimRight(endpointOverride, "/")
	}
	if e := os.Getenv("HF_ENDPOINT"); e != "" {
		return strings.TrimRight(e, "/")
	}
	return "https://huggingface.co"
}

// RepoFile is a single file inside a HF repo tree.
type RepoFile struct {
	Name string `json:"name"`
	Size int64  `json:"size"`
}

type hfTreeEntry struct {
	Type string `json:"type"`
	Path string `json:"path"`
	Size *int64 `json:"size"`
}

func userAgent() string { return "llama-commander/0.1" }

// ListFiles returns every .gguf file (including mmproj/draft) in the repo.
// revision defaults to "main".
func ListFiles(ctx context.Context, repo, revision string) ([]RepoFile, error) {
	if strings.TrimSpace(repo) == "" {
		return nil, fmt.Errorf("仓库名不能为空")
	}
	if revision == "" {
		revision = "main"
	}
	url := fmt.Sprintf("%s/api/models/%s/tree/%s?recursive=true&expand=true",
		Endpoint(), repo, revision)
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, url, nil)
	if err != nil {
		return nil, err
	}
	req.Header.Set("User-Agent", userAgent())
	resp, err := http.DefaultClient.Do(req)
	if err != nil {
		return nil, fmt.Errorf("访问 HuggingFace 失败: %w", err)
	}
	defer resp.Body.Close()
	if resp.StatusCode != http.StatusOK {
		return nil, fmt.Errorf("仓库 %q 不存在或不可访问 (HTTP %d)", repo, resp.StatusCode)
	}
	var entries []hfTreeEntry
	if err := json.NewDecoder(resp.Body).Decode(&entries); err != nil {
		return nil, err
	}
	var files []RepoFile
	for _, e := range entries {
		if e.Type != "file" {
			continue
		}
		if !strings.HasSuffix(strings.ToLower(e.Path), ".gguf") {
			continue
		}
		var size int64
		if e.Size != nil {
			size = *e.Size
		}
		files = append(files, RepoFile{Name: e.Path, Size: size})
	}
	sort.Slice(files, func(i, j int) bool { return files[i].Size < files[j].Size })
	return files, nil
}

// Download streams repo/<revision>/<filename> into the llama.cpp-style cache
// under root. An existing ".part" file resumes via the Range header. Progress
// is reported through the optional callback (throttled by the caller).
// Returns the final local path.
func Download(ctx context.Context, repo, filename, revision, root string, progress func(done, total int64)) (string, error) {
	if strings.TrimSpace(repo) == "" || strings.TrimSpace(filename) == "" {
		return "", fmt.Errorf("仓库名与文件名不能为空")
	}
	if revision == "" {
		revision = "main"
	}
	destDir := filepath.Join(root, "models--"+strings.ReplaceAll(repo, "/", "--"),
		"snapshots", revision)
	dest := filepath.Join(destDir, filepath.FromSlash(filename))
	if err := os.MkdirAll(filepath.Dir(dest), 0o755); err != nil {
		return "", err
	}
	part := dest + ".part"

	var from int64
	if fi, err := os.Stat(part); err == nil {
		from = fi.Size()
	}

	url := fmt.Sprintf("%s/%s/resolve/%s/%s", Endpoint(), repo, revision, filename)
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, url, nil)
	if err != nil {
		return "", err
	}
	req.Header.Set("User-Agent", userAgent())
	if from > 0 {
		req.Header.Set("Range", fmt.Sprintf("bytes=%d-", from))
	}
	resp, err := http.DefaultClient.Do(req)
	if err != nil {
		return "", fmt.Errorf("下载失败: %w", err)
	}
	defer resp.Body.Close()
	if resp.StatusCode != http.StatusOK && resp.StatusCode != http.StatusPartialContent {
		return "", fmt.Errorf("下载失败: HTTP %d", resp.StatusCode)
	}
	total := from
	if resp.ContentLength > 0 {
		total = from + resp.ContentLength
	}

	f, err := os.OpenFile(part, os.O_CREATE|os.O_WRONLY|os.O_APPEND, 0o644)
	if err != nil {
		return "", err
	}
	buf := make([]byte, 256*1024)
	var done = from
	for {
		n, rerr := resp.Body.Read(buf)
		if n > 0 {
			if _, werr := f.Write(buf[:n]); werr != nil {
				f.Close()
				return "", werr
			}
			done += int64(n)
			if progress != nil {
				progress(done, total)
			}
		}
		if rerr == io.EOF {
			break
		}
		if rerr != nil {
			f.Close()
			return "", rerr
		}
	}
	if err := f.Close(); err != nil {
		return "", err
	}
	// On Windows os.Rename fails if the target already exists — remove a
	// stale copy (from a previous interrupted run) before finalizing.
	if _, err := os.Stat(dest); err == nil {
		_ = os.Remove(dest)
	}
	if err := os.Rename(part, dest); err != nil {
		return "", err
	}
	return dest, nil
}

// HumanSize renders bytes as a readable string.
func HumanSize(b int64) string {
	const unit = 1024
	if b < unit {
		return fmt.Sprintf("%d B", b)
	}
	div, exp := int64(unit), 0
	for n := b / unit; n >= unit; n /= unit {
		div *= unit
		exp++
	}
	return fmt.Sprintf("%.1f %ciB", float64(b)/float64(div), "KMGTPE"[exp])
}
