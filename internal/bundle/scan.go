package bundle

// scan.go implements the "smart bundling" features from the spec:
//   - recursive folder scanning of .gguf models
//   - shard grouping (via shard.go)
//   - companion detection (mmproj / draft / LoRA) by filename keywords

import (
	"fmt"
	"os"
	"path/filepath"
	"strings"

	"llama-launcher/internal/gguf"
)

// CompanionHints lists companion files detected next to a primary model.
type CompanionHints struct {
	MMProj string   `json:"mmproj,omitempty"`
	Draft  string   `json:"draft,omitempty"`
	LORA   []string `json:"lora,omitempty"`
}

// Candidate is a scan result preview, shown in the UI before import.
type Candidate struct {
	Bundle   *Bundle  `json:"bundle"`
	Warnings []string `json:"warnings"`
}

// classifyCompanion returns "mmproj" | "draft" | "lora" | "" for a file name.
func classifyCompanion(name string) string {
	lower := strings.ToLower(name)
	switch {
	case strings.Contains(lower, "mmproj") || strings.Contains(lower, "mm_projector"):
		return "mmproj"
	case strings.Contains(lower, "draft"):
		return "draft"
	case strings.Contains(lower, "lora") || strings.Contains(lower, "adapter"):
		return "lora"
	}
	return ""
}

// DetectCompanions looks in the same directory as basePath for mmproj /
// draft / LoRA files that belong to the model.
func DetectCompanions(basePath string) CompanionHints {
	dir := filepath.Dir(basePath)
	var hints CompanionHints
	entries, err := os.ReadDir(dir)
	if err != nil {
		return hints
	}
	// 获取主模型文件大小
	var baseSize int64
	if fi, err := os.Stat(basePath); err == nil {
		baseSize = fi.Size()
	}
	for _, e := range entries {
		if e.IsDir() || !strings.HasSuffix(strings.ToLower(e.Name()), ".gguf") {
			continue
		}
		fullPath := filepath.Join(dir, e.Name())
		if fullPath == basePath {
			continue
		}
		switch classifyCompanion(e.Name()) {
		case "mmproj":
			hints.MMProj = fullPath
		case "draft":
			if hints.Draft == "" {
				hints.Draft = fullPath
			}
		case "lora":
			hints.LORA = append(hints.LORA, fullPath)
		default:
			// 文件名无关键字：检查文件大小是否明显小于主模型
			if baseSize > 0 {
				fi, err := os.Stat(fullPath)
				if err == nil && !fi.IsDir() {
					size := fi.Size()
					if size < baseSize/3 && size < 2*1024*1024*1024 {
						if hints.Draft == "" {
							hints.Draft = fullPath
						}
					}
				}
			}
		}
	}
	return hints
}

// NewFromGGUF parses a GGUF file and builds a Bundle (not yet saved).
// name may be empty (inferred from file name). Companion hints are applied
// if non-empty; pass an empty CompanionHints to auto-detect.
func NewFromGGUF(path, name string, hints CompanionHints) (*Bundle, error) {
	info, err := gguf.Parse(path)
	if err != nil {
		return nil, fmt.Errorf("parse gguf: %w", err)
	}
	if name == "" {
		name = info.Filename()
	}
	b := &Bundle{
		Name:       name,
		SourceType: SourceLocal,
		BaseModel:  fileInfo(path, info),
		Tags:       detectTags(info, name),
	}
	b.DefaultParams = defaultParamsFrom(info)
	// Companion detection: use provided hints, else auto-detect by keyword.
	if hints.MMProj == "" && hints.Draft == "" && len(hints.LORA) == 0 {
		hints = DetectCompanions(path)
	}
	applyCompanions(b, hints)
	// Shard detection for the same directory.
	applyShardInfo(b)
	return b, nil
}

// applyCompanions wires companion hints onto the bundle.
func applyCompanions(b *Bundle, hints CompanionHints) {
	if hints.MMProj != "" {
		b.MMProj = ModelFile{Path: hints.MMProj, Exists: fileExists(hints.MMProj)}
		if m, err := gguf.Parse(hints.MMProj); err == nil {
			b.MMProj.Metadata = m
			b.MMProj.FileSizeMB = m.FileSizeMB
		}
		b.Tags = append(b.Tags, "vision")
	}
	if hints.Draft != "" {
		b.DraftModel = DraftModel{
			Path:     hints.Draft,
			Enabled:  true,
			SpecType: "draft-simple",
			SpecParams: map[string]any{
				"n_max":   16, // 与 registry 默认值保持一致
				"n_min":   0,
				"p_split": 0.10,
				"p_min":   0.00,
			},
		}
	}
	for _, p := range hints.LORA {
		b.LORAList = append(b.LORAList, LoRA{Path: p, Scale: 1.0})
	}
}

// applyShardInfo inspects the model's directory and fills shard info.
func applyShardInfo(b *Bundle) {
	dir := filepath.Dir(b.BaseModel.Path)
	prefix, _, total, ok := ParseShardName(filepath.Base(b.BaseModel.Path))
	if !ok || total <= 1 {
		return
	}
	shards := InspectDir(dir)
	if si, found := shards[prefix]; found {
		b.ShardInfo = si
	}
}

// ScanDir recursively scans a directory for GGUF models and returns import
// candidates. Sharded models are grouped; companions are auto-detected.
// Files that could not be parsed are not silently dropped — their paths and
// reasons are returned in the second slice so the UI can explain why some
// models were skipped.
func ScanDir(dir string) ([]*Candidate, []string, error) {
	if fi, err := os.Stat(dir); err != nil || !fi.IsDir() {
		return nil, nil, fmt.Errorf("invalid directory: %q", dir)
	}
	var candidates []*Candidate
	var skipped []string
	err := filepath.WalkDir(dir, func(path string, d os.DirEntry, err error) error {
		if err != nil {
			return nil // skip unreadable entries
		}
		if d.IsDir() {
			return nil
		}
		if strings.ToLower(filepath.Ext(path)) != ".gguf" {
			return nil
		}
		name := d.Name()
		// Skip companions — they are attached to their primary model.
		if classifyCompanion(name) != "" {
			return nil
		}
		// For sharded sets only visit the first shard.
		if _, idx, total, ok := ParseShardName(name); ok && total > 1 {
			if idx != 1 {
				return nil
			}
		}
		b, err := NewFromGGUF(path, "", CompanionHints{})
		if err != nil {
			skipped = append(skipped, fmt.Sprintf("%s: %v", filepath.Base(path), err))
			return nil
		}
		var warnings []string
		if b.ShardInfo.IsSharded && !b.ShardInfo.AllShardsPresent {
			warnings = append(warnings,
				fmt.Sprintf("分片不完整: 期望 %d 片，当前缺少部分分片", b.ShardInfo.TotalShards))
		}
		if b.MMProj.Path != "" {
			warnings = append(warnings, "已自动捆绑视觉编码器 mmproj")
		}
		if b.DraftModel.Enabled {
			warnings = append(warnings, "已自动捆绑草稿模型（投机解码）")
		}
		candidates = append(candidates, &Candidate{Bundle: b, Warnings: warnings})
		return nil
	})
	if err != nil {
		return nil, nil, err
	}
	return candidates, skipped, nil
}
