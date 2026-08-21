// Package gguf implements a lightweight reader for the GGUF (GPT-Generated
// Unified Format) file header. It is intentionally dependency-free and only
// extracts the model metadata needed by Llama Commander (architecture, block
// count, context length, KV heads, etc.).
package gguf

import (
	"bufio"
	"bytes"
	"encoding/binary"
	"errors"
	"fmt"
	"io"
	"math"
	"os"
	"path/filepath"
	"strings"
)

// GGUF value types (see the GGUF specification).
const (
	TypeUint8   uint32 = 0
	TypeInt8    uint32 = 1
	TypeUint16  uint32 = 2
	TypeInt16   uint32 = 3
	TypeUint32  uint32 = 4
	TypeInt32   uint32 = 5
	TypeFloat32 uint32 = 6
	TypeBool    uint32 = 7
	TypeString  uint32 = 8
	TypeArray   uint32 = 9
	TypeUint64  uint32 = 10
	TypeInt64   uint32 = 11
	TypeFloat64 uint32 = 12
)

// magic is the 4-byte GGUF file signature.
var magic = [4]byte{'G', 'G', 'U', 'F'}

// ModelInfo holds the parsed metadata of a GGUF model file.
type ModelInfo struct {
	Path            string         `json:"path"`
	FileSizeMB      float64        `json:"file_size_mb"`
	Version         uint32         `json:"version"`
	Architecture    string         `json:"architecture"`
	ContextLength   uint64         `json:"context_length"`
	BlockCount      uint64         `json:"block_count"`
	HeadCount       uint64         `json:"head_count"`
	HeadCountKV     uint64         `json:"head_count_kv"`
	EmbeddingLength uint64         `json:"embedding_length"`
	VocabSize       uint64         `json:"vocab_size"`
	FileType        uint32         `json:"file_type"`
	FileTypeName    string         `json:"file_type_name"`
	Moe             bool           `json:"is_moe"`
	Metadata        map[string]any `json:"metadata"`
	RawKeys         []string       `json:"-"`
}

// Parse opens the GGUF file at path and parses its header.
func Parse(path string) (*ModelInfo, error) {
	f, err := os.Open(path)
	if err != nil {
		return nil, err
	}
	defer f.Close()
	fi, err := f.Stat()
	if err != nil {
		return nil, err
	}
	return ParseReader(f, fi.Size(), path)
}

// ParseReader parses a GGUF header from an io.ReaderAt. The metadata section
// is streamed from disk through a buffered reader, so it correctly handles
// models whose metadata exceeds 1 MiB (large tokenizer vocabs, e.g. 150k+
// tokens). Only the header is consumed — tensor data is never read.
func ParseReader(r io.ReaderAt, size int64, path string) (*ModelInfo, error) {
	sr := io.NewSectionReader(r, 0, size)
	g := &ggufReader{br: bufio.NewReaderSize(sr, 1<<20), rem: size}
	if err := g.checkMagic(); err != nil {
		return nil, err
	}
	version, err := g.u32()
	if err != nil {
		return nil, err
	}
	if _, err := g.u64(); err != nil { // tensor count, unused
		return nil, err
	}
	kvCount, err := g.u64()
	if err != nil {
		return nil, err
	}
	// Cap the number of KV entries to guard against corrupt files.
	if kvCount > 1<<20 {
		return nil, fmt.Errorf("gguf: implausible metadata KV count %d", kvCount)
	}

	info := &ModelInfo{
		Path:       path,
		Version:    version,
		FileSizeMB: float64(size) / (1024 * 1024),
		Metadata:   make(map[string]any, kvCount),
	}
	for i := uint64(0); i < kvCount; i++ {
		key, err := g.str()
		if err != nil {
			return nil, err
		}
		val, err := g.value()
		if err != nil {
			return nil, err
		}
		info.Metadata[key] = val
		info.RawKeys = append(info.RawKeys, key)
	}
	info.extractKnownFields()
	return info, nil
}

// extractKnownFields maps known metadata keys onto typed fields.
func (m *ModelInfo) extractKnownFields() {
	m.Architecture = str(m.Metadata["general.architecture"])
	m.FileType = ui32(m.Metadata["general.file_type"])
	if _, v := findBySuffix(m.Metadata, ".context_length"); v != nil {
		m.ContextLength = ui64(v)
	}
	if _, v := findBySuffix(m.Metadata, ".block_count"); v != nil {
		m.BlockCount = ui64(v)
	}
	if _, v := findBySuffix(m.Metadata, ".head_count"); v != nil {
		m.HeadCount = ui64(v)
	}
	if _, v := findBySuffix(m.Metadata, ".head_count_kv"); v != nil {
		m.HeadCountKV = ui64(v)
	}
	if _, v := findBySuffix(m.Metadata, ".embedding_length"); v != nil {
		m.EmbeddingLength = ui64(v)
	}
	if _, v := findBySuffix(m.Metadata, ".vocab_size"); v != nil {
		m.VocabSize = ui64(v)
	}
	m.FileTypeName = FileTypeName(m.FileType)
	m.Moe = m.ExpertCount() > 0
}

// ---- low-level reader ----

// ggufReader reads GGUF metadata from disk on demand, bounded by the file
// size. Unlike a fixed-size in-memory buffer, this handles arbitrarily large
// metadata sections (e.g. huge tokenizer vocabs) without failing.
type ggufReader struct {
	br  *bufio.Reader
	rem int64
}

func (g *ggufReader) readN(n int) ([]byte, error) {
	if int64(n) > g.rem {
		return nil, io.ErrUnexpectedEOF
	}
	b := make([]byte, n)
	if _, err := io.ReadFull(g.br, b); err != nil {
		return nil, err
	}
	g.rem -= int64(n)
	return b, nil
}

func (g *ggufReader) checkMagic() error {
	b, err := g.readN(4)
	if err != nil {
		return err
	}
	if !bytes.Equal(b, magic[:]) {
		return errors.New("gguf: not a GGUF file (bad magic)")
	}
	return nil
}

func (g *ggufReader) u8() (uint8, error) {
	b, err := g.readN(1)
	if err != nil {
		return 0, err
	}
	return b[0], nil
}

func (g *ggufReader) u16() (uint16, error) {
	b, err := g.readN(2)
	if err != nil {
		return 0, err
	}
	return binary.LittleEndian.Uint16(b), nil
}

func (g *ggufReader) u32() (uint32, error) {
	b, err := g.readN(4)
	if err != nil {
		return 0, err
	}
	return binary.LittleEndian.Uint32(b), nil
}

func (g *ggufReader) u64() (uint64, error) {
	b, err := g.readN(8)
	if err != nil {
		return 0, err
	}
	return binary.LittleEndian.Uint64(b), nil
}

func (g *ggufReader) i64() (int64, error) {
	v, err := g.u64()
	return int64(v), err
}

func (g *ggufReader) f32() (float32, error) {
	b, err := g.readN(4)
	if err != nil {
		return 0, err
	}
	return math.Float32frombits(binary.LittleEndian.Uint32(b)), nil
}

func (g *ggufReader) f64() (float64, error) {
	b, err := g.readN(8)
	if err != nil {
		return 0, err
	}
	return math.Float64frombits(binary.LittleEndian.Uint64(b)), nil
}

// str reads a GGUF string (uint64 length prefix + bytes).
func (g *ggufReader) str() (string, error) {
	n, err := g.u64()
	if err != nil {
		return "", err
	}
	b, err := g.readN(int(n))
	if err != nil {
		return "", err
	}
	return string(b), nil
}

// value reads a single GGUF metadata value.
func (g *ggufReader) value() (any, error) {
	t, err := g.u32()
	if err != nil {
		return nil, err
	}
	switch t {
	case TypeUint8:
		return g.u8()
	case TypeInt8:
		v, err := g.u8()
		return int8(v), err
	case TypeUint16:
		return g.u16()
	case TypeInt16:
		v, err := g.u16()
		return int16(v), err
	case TypeUint32:
		return g.u32()
	case TypeInt32:
		v, err := g.u32()
		return int32(v), err
	case TypeFloat32:
		return g.f32()
	case TypeBool:
		v, err := g.u8()
		return v != 0, err
	case TypeString:
		return g.str()
	case TypeArray:
		return g.array()
	case TypeUint64:
		return g.u64()
	case TypeInt64:
		return g.i64()
	case TypeFloat64:
		return g.f64()
	default:
		return nil, fmt.Errorf("gguf: unknown value type %d", t)
	}
}

// array reads a GGUF array value. Real-world models store vocab tokens as
// arrays of strings (tokenizer.ggml.tokens), so string arrays must be
// supported. Nested arrays are rare and still rejected.
func (g *ggufReader) array() ([]any, error) {
	etype, err := g.u32()
	if err != nil {
		return nil, err
	}
	if etype == TypeArray {
		return nil, fmt.Errorf("gguf: nested arrays are not supported")
	}
	count, err := g.u64()
	if err != nil {
		return nil, err
	}
	if count > 1<<24 {
		return nil, fmt.Errorf("gguf: implausible array length %d", count)
	}
	out := make([]any, 0, count)
	for i := uint64(0); i < count; i++ {
		if etype == TypeString {
			s, err := g.str()
			if err != nil {
				return nil, err
			}
			out = append(out, s)
			continue
		}
		val, err := g.typedValue(etype)
		if err != nil {
			return nil, err
		}
		out = append(out, val)
	}
	return out, nil
}

func (g *ggufReader) typedValue(t uint32) (any, error) {
	switch t {
	case TypeUint8:
		return g.u8()
	case TypeInt8:
		v, err := g.u8()
		return int8(v), err
	case TypeUint16:
		return g.u16()
	case TypeInt16:
		v, err := g.u16()
		return int16(v), err
	case TypeUint32:
		return g.u32()
	case TypeInt32:
		v, err := g.u32()
		return int32(v), err
	case TypeFloat32:
		return g.f32()
	case TypeBool:
		v, err := g.u8()
		return v != 0, err
	case TypeUint64:
		return g.u64()
	case TypeInt64:
		return g.i64()
	case TypeFloat64:
		return g.f64()
	default:
		return nil, fmt.Errorf("gguf: unsupported array element type %d", t)
	}
}

// ---- helpers ----

// findBySuffix searches metadata for the first key ending with suffix.
func findBySuffix(m map[string]any, suffix string) (string, any) {
	for k, v := range m {
		if strings.HasSuffix(k, suffix) {
			return k, v
		}
	}
	return "", nil
}

func str(v any) string {
	if s, ok := v.(string); ok {
		return s
	}
	return ""
}

func ui64(v any) uint64 {
	switch n := v.(type) {
	case uint8:
		return uint64(n)
	case uint16:
		return uint64(n)
	case uint32:
		return uint64(n)
	case uint64:
		return n
	case int8:
		return uint64(n)
	case int16:
		return uint64(n)
	case int32:
		return uint64(n)
	case int64:
		return uint64(n)
	}
	return 0
}

func ui32(v any) uint32 {
	return uint32(ui64(v))
}

// FileTypeName returns a human readable quantisation name for a GGUF
// general.file_type value, per llama.cpp's llama_ftype enum.
func FileTypeName(t uint32) string {
	names := [...]string{
		"F32", "F16", "Q4_0", "Q4_1", "Q4_1_SOME_F16", "FT5", "FT6",
		"Q8_0", "Q5_0", "Q5_1", "Q2_K", "Q2_K_S", "Q3_K_S", "Q3_K_M",
		"Q3_K_L", "Q3_K_XS", "Q4_K_S", "Q4_K_M", "Q4_K_L", "Q5_K_S",
		"Q5_K_M", "Q5_K_L", "Q6_K", "IQ1_S", "IQ1_M", "IQ2_XS",
		"IQ2_S", "IQ2_M", "IQ2_XXS", "IQ3_XS", "IQ3_XXS", "IQ3_S",
		"IQ3_M", "IQ3_L", "IQ4_XS", "IQ4_NL", "IQ5_XS", "IQ5_XXS",
		"IQ5_WQ", "IQ6_XS",
	}
	if int(t) < len(names) {
		return names[t]
	}
	return fmt.Sprintf("FT%d", t)
}

// Filename returns the base file name of the parsed model.
func (m *ModelInfo) Filename() string {
	if m == nil {
		return ""
	}
	return filepath.Base(m.Path)
}

// ExpertCount returns the number of experts in a MoE model (0 if not MoE).
func (m *ModelInfo) ExpertCount() uint64 {
	if m == nil {
		return 0
	}
	if _, v := findBySuffix(m.Metadata, ".expert_count"); v != nil {
		return ui64(v)
	}
	return 0
}

// IsMoE reports whether the model uses a Mixture-of-Experts architecture.
func (m *ModelInfo) IsMoE() bool {
	return m != nil && m.ExpertCount() > 0
}
