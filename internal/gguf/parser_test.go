package gguf

import (
	"bytes"
	"encoding/binary"
	"fmt"
	"os"
	"path/filepath"
	"testing"
)

// buildGGUF synthesizes a minimal in-memory GGUF v3 file with the given
// metadata map, suitable for unit tests.
func buildGGUF(t *testing.T, meta map[string]any) []byte {
	t.Helper()
	var buf bytes.Buffer
	buf.Write(magic[:])
	writeU32(&buf, 3) // version
	writeU64(&buf, 0) // tensor count
	writeU64(&buf, uint64(len(meta)))
	for k, v := range meta {
		writeString(&buf, k)
		writeTyped(&buf, v)
	}
	return buf.Bytes()
}

func writeU32(buf *bytes.Buffer, v uint32) { _ = binary.Write(buf, binary.LittleEndian, v) }
func writeU64(buf *bytes.Buffer, v uint64) { _ = binary.Write(buf, binary.LittleEndian, v) }
func writeString(buf *bytes.Buffer, s string) {
	writeU64(buf, uint64(len(s)))
	buf.WriteString(s)
}
func writeTyped(buf *bytes.Buffer, v any) {
	switch x := v.(type) {
	case string:
		writeU32(buf, TypeString)
		writeString(buf, x)
	case uint64:
		writeU32(buf, TypeUint64)
		writeU64(buf, x)
	case uint32:
		writeU32(buf, TypeUint32)
		writeU32(buf, x)
	case bool:
		writeU32(buf, TypeBool)
		if x {
			buf.WriteByte(1)
		} else {
			buf.WriteByte(0)
		}
	case []string:
		writeU32(buf, TypeArray)
		writeU32(buf, TypeString) // element type
		writeU64(buf, uint64(len(x)))
		for _, s := range x {
			writeString(buf, s)
		}
	case []uint32:
		writeU32(buf, TypeArray)
		writeU32(buf, TypeUint32) // element type
		writeU64(buf, uint64(len(x)))
		for _, v := range x {
			writeU32(buf, v)
		}
	case []uint64:
		writeU32(buf, TypeArray)
		writeU32(buf, TypeUint64) // element type
		writeU64(buf, uint64(len(x)))
		for _, v := range x {
			writeU64(buf, v)
		}
	default:
		panic("unsupported test value " + fmt.Sprintf("%T", v))
	}
}

// TestStringArray verifies parsing a real-world model with a string-array
// metadata value (tokenizer.ggml.tokens).
func TestStringArray(t *testing.T) {
	meta := map[string]any{
		"general.architecture":      "llama",
		"llama.context_length":      uint64(2048),
		"llama.block_count":         uint64(32),
		"tokenizer.ggml.tokens":     []string{"<unk>", "<s>", "hello", "world"},
		"tokenizer.ggml.scores":     []uint32{0, 1, 2, 3},
		"tokenizer.ggml.token_type": []uint32{3, 3, 1, 1},
	}
	data := buildGGUF(t, meta)
	info, err := ParseReader(bytes.NewReader(data), int64(len(data)), "/fake/tiny.gguf")
	if err != nil {
		t.Fatalf("ParseReader (string array): %v", err)
	}
	tokens, ok := info.Metadata["tokenizer.ggml.tokens"].([]any)
	if !ok || len(tokens) != 4 || tokens[0] != "<unk>" {
		t.Errorf("tokenizer.ggml.tokens = %#v, want []any{\"<unk>\",...}", info.Metadata["tokenizer.ggml.tokens"])
	}
}

func TestParseReader(t *testing.T) {
	meta := map[string]any{
		"general.architecture":   "llama",
		"llama.context_length":   uint64(4096),
		"llama.block_count":      uint64(60),
		"llama.head_count":       uint64(64),
		"llama.head_count_kv":    uint64(8),
		"llama.embedding_length": uint64(8192),
		"general.file_type":      uint32(17), // Q4_K_M
	}
	data := buildGGUF(t, meta)

	info, err := ParseReader(bytes.NewReader(data), int64(len(data)), "/fake/model.gguf")
	if err != nil {
		t.Fatalf("ParseReader: %v", err)
	}
	if info.Architecture != "llama" {
		t.Errorf("Architecture = %q, want llama", info.Architecture)
	}
	if info.ContextLength != 4096 {
		t.Errorf("ContextLength = %d, want 4096", info.ContextLength)
	}
	if info.BlockCount != 60 {
		t.Errorf("BlockCount = %d, want 60", info.BlockCount)
	}
	if info.HeadCountKV != 8 {
		t.Errorf("HeadCountKV = %d, want 8", info.HeadCountKV)
	}
	if info.FileType != 17 {
		t.Errorf("FileType = %d, want 17", info.FileType)
	}
	if got := FileTypeName(17); got != "Q4_K_M" {
		t.Errorf("FileTypeName(17) = %q, want Q4_K_M", got)
	}
	if info.Metadata["llama.block_count"] != uint64(60) {
		t.Errorf("raw metadata missing key")
	}
}

func TestParseFile(t *testing.T) {
	data := buildGGUF(t, map[string]any{
		"general.architecture": "qwen2",
		"qwen2.context_length": uint64(32768),
	})
	dir := t.TempDir()
	path := filepath.Join(dir, "qwen.gguf")
	if err := os.WriteFile(path, data, 0o644); err != nil {
		t.Fatal(err)
	}
	info, err := Parse(path)
	if err != nil {
		t.Fatalf("Parse: %v", err)
	}
	if info.Architecture != "qwen2" || info.ContextLength != 32768 {
		t.Errorf("unexpected parse result: %+v", info)
	}
	if info.Filename() != "qwen.gguf" {
		t.Errorf("Filename = %q, want qwen.gguf", info.Filename())
	}
}

func TestRejectBadMagic(t *testing.T) {
	_, err := ParseReader(bytes.NewReader([]byte("NOTG")), 4, "x")
	if err == nil {
		t.Fatal("expected error for bad magic")
	}
}

// TestLargeMetadata verifies that metadata larger than 1 MiB (e.g. a huge
// tokenizer vocab, 150k+ tokens) still parses. The parser streams from disk
// rather than relying on a fixed-size buffer — the old fixed 1 MiB buffer
// failed with io.ErrUnexpectedEOF on such files, causing models to be
// silently skipped during directory scanning.
func TestLargeMetadata(t *testing.T) {
	// ~32k tokens × ~42 bytes ≈ 1.35 MiB of metadata (> 1 MiB old cap).
	tokens := make([]string, 32000)
	for i := range tokens {
		tokens[i] = fmt.Sprintf("token_%05d_abcdefghijklmnopqrstuvwxyz012345", i)
	}
	meta := map[string]any{
		"general.architecture":  "llama",
		"llama.context_length":  uint64(8192),
		"llama.block_count":     uint64(32),
		"tokenizer.ggml.tokens": tokens,
	}
	data := buildGGUF(t, meta)
	if len(data) < 1<<20 {
		t.Fatalf("test data only %d bytes; need > 1 MiB to exercise the large-metadata path", len(data))
	}
	info, err := ParseReader(bytes.NewReader(data), int64(len(data)), "/fake/big.gguf")
	if err != nil {
		t.Fatalf("ParseReader (large metadata): %v", err)
	}
	toks, ok := info.Metadata["tokenizer.ggml.tokens"].([]any)
	if !ok || len(toks) != len(tokens) {
		t.Fatalf("token array length = %d, want %d", len(toks), len(tokens))
	}
	if info.Architecture != "llama" || info.ContextLength != 8192 || info.BlockCount != 32 {
		t.Errorf("known fields lost: arch=%q ctx=%d blocks=%d", info.Architecture, info.ContextLength, info.BlockCount)
	}
}

// buildGGUFWithTensors is like buildGGUF but also appends a tensor metadata
// table with the given names (each with dims=[1], type=F32, offset=0).
func buildGGUFWithTensors(t *testing.T, meta map[string]any, tensors []string) []byte {
	t.Helper()
	var buf bytes.Buffer
	buf.Write(magic[:])
	writeU32(&buf, 3) // version
	writeU64(&buf, uint64(len(tensors)))
	writeU64(&buf, uint64(len(meta)))
	for k, v := range meta {
		writeString(&buf, k)
		writeTyped(&buf, v)
	}
	for _, name := range tensors {
		writeString(&buf, name)
		writeU32(&buf, 1) // n_dims
		writeU64(&buf, 4) // dim[0]
		writeU32(&buf, 0) // type F32
		writeU64(&buf, 0) // data offset
	}
	return buf.Bytes()
}

// TestHasMTPHead verifies MTP heads are detected from the header tensor table
// (blk.*.nextn.* / mtp.*), independent of the file name — the case where a
// model like "Qwen3.8-27B-UD-IQ2_XXS.gguf" embeds an MTP head without saying so.
func TestHasMTPHead(t *testing.T) {
	dir := t.TempDir()
	mustParse := func(name string, tensors []string) *ModelInfo {
		t.Helper()
		p := filepath.Join(dir, name)
		if err := os.WriteFile(p, buildGGUFWithTensors(t, map[string]any{
			"general.architecture": "qwen35",
		}, tensors), 0o644); err != nil {
			t.Fatal(err)
		}
		info, err := Parse(p)
		if err != nil {
			t.Fatalf("Parse(%s): %v", name, err)
		}
		return info
	}

	if info := mustParse("mystery.gguf", []string{"blk.65.nextn.attn_q.weight"}); !info.HasMTPHead() {
		t.Error("blk.*.nextn.* tensor should be detected as MTP head")
	}
	if info := mustParse("mystery.gguf", []string{"mtp.proj.weight"}); !info.HasMTPHead() {
		t.Error("mtp.* tensor should be detected as MTP head")
	}
	if info := mustParse("mystery.gguf", []string{"blk.0.attn_q.weight", "blk.1.attn_k.weight"}); info.HasMTPHead() {
		t.Error("plain tensors should not be flagged as MTP")
	}
	if info := mustParse("mystery.gguf", []string{"output.weight"}); info.HasMTPHead() {
		t.Error("output.weight should not be flagged as MTP")
	}
}
