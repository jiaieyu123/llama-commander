package bundle

// shard.go implements detection of sharded GGUF models. llama.cpp splits
// large models into files like "model-00001-of-00002.gguf".

import (
	"os"
	"path/filepath"
	"regexp"
	"strconv"
	"strings"
)

// shardPattern matches names such as "model-00001-of-00002.gguf".
var shardPattern = regexp.MustCompile(`^(.+)-(\d{5})-of-(\d{5})\.gguf$`)

// ParseShardName splits a shard file name into (prefix, index, total).
func ParseShardName(name string) (prefix string, index, total int, ok bool) {
	m := shardPattern.FindStringSubmatch(name)
	if len(m) != 4 {
		return "", 0, 0, false
	}
	index, err1 := strconv.Atoi(m[2])
	total, err2 := strconv.Atoi(m[3])
	if err1 != nil || err2 != nil {
		return "", 0, 0, false
	}
	return m[1], index, total, true
}

// InspectDir scans a directory for sharded GGUF files and groups them by
// prefix. A model is considered complete when index 1..total all exist.
func InspectDir(dir string) map[string]ShardInfo {
	result := make(map[string]ShardInfo)
	entries, err := os.ReadDir(dir)
	if err != nil {
		return result
	}
	// group: prefix -> {index: filename}
	groups := make(map[string]map[int]string)
	totals := make(map[string]int)
	for _, e := range entries {
		if e.IsDir() || !strings.HasSuffix(e.Name(), ".gguf") {
			continue
		}
		prefix, index, total, ok := ParseShardName(e.Name())
		if !ok {
			continue
		}
		if groups[prefix] == nil {
			groups[prefix] = make(map[int]string)
		}
		groups[prefix][index] = filepath.Join(dir, e.Name())
		totals[prefix] = total
	}
	for prefix, idx := range groups {
		total := totals[prefix]
		info := ShardInfo{
			IsSharded:    total > 1,
			TotalShards:  total,
			ShardPattern: prefix + "-%05d-of-%05d.gguf",
		}
		info.AllShardsPresent = true
		for i := 1; i <= total; i++ {
			if _, ok := idx[i]; !ok {
				info.AllShardsPresent = false
				break
			}
		}
		for i := 1; i <= total; i++ {
			if f, ok := idx[i]; ok {
				info.ShardFiles = append(info.ShardFiles, f)
			}
		}
		result[prefix] = info
	}
	return result
}

// Primary returns the first shard path (the one llama-server loads).
func (s *ShardInfo) Primary() string {
	if s == nil || len(s.ShardFiles) == 0 {
		return ""
	}
	return s.ShardFiles[0]
}
