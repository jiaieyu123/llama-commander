package gguf

import (
	"math"
	"strings"
)

// KVShape describes the real per-layer KV-cache structure of a model, derived
// from raw GGUF metadata following llama.cpp semantics (see src/llama-hparams.cpp
// / llama-model.cpp / llama-kv-cache.cpp):
//
//   - *.attention.head_count_kv   → n_head_kv per layer (scalar broadcasts; array = per layer)
//   - *.attention.key_length / value_length           → per-head KV dim of full(non-SWA) layers
//   - *.attention.key_length_swa / value_length_swa   → per-head KV dim of sliding-window layers
//     (both default to n_embd/n_head when the keys are absent, as llama.cpp does)
//   - *.attention.sliding_window_pattern              → per-layer is_swa flag (array of bool)
//   - *.attention.sliding_window                      → window size for the fixed SWA cache
//
// Sliding-window layers do NOT grow with ctx in llama.cpp (they keep a fixed
// window cache); only non-SWA layers contribute to "KV bytes per token".
type KVShape struct {
	Architecture    string `json:"architecture"`
	Layers          int    `json:"layers"`
	EmbeddingLength uint64 `json:"embedding_length"`
	HeadCount       uint64 `json:"head_count"`
	HeadDimDefault  uint32 `json:"head_dim_default"` // n_embd/n_head fallback (per head)
	SlidingWindow   uint32 `json:"sliding_window,omitempty"`

	HeadCountKVPerLayer []uint32 `json:"head_count_kv_per_layer,omitempty"`
	HeadDimKPerLayer    []uint32 `json:"head_dim_k_per_layer,omitempty"`
	HeadDimVPerLayer    []uint32 `json:"head_dim_v_per_layer,omitempty"`
	IsSWAPerLayer       []bool   `json:"is_swa_per_layer,omitempty"`

	// KVPerTokenBytesF16 is the K+V bytes per token that grows linearly with ctx,
	// measured on f16 cache. Multiply by (bK+bV)/4 to scale to other cache types.
	KVPerTokenBytesF16 float64 `json:"kv_per_token_bytes_f16"`
	// FixedSWACacheMB is an approximate one-time allocation for sliding-window
	// layers (window-sized), independent of ctx.
	FixedSWACacheMB float64 `json:"fixed_swa_cache_mb,omitempty"`
	// FullLayers / SWALayers counts for diagnostics.
	FullLayers int `json:"full_layers"`
	SWALayers  int `json:"swa_layers"`
	// Source is a human-readable note of which keys were used.
	Source string `json:"source"`
}

// ---- tiny typed helpers over raw gguf metadata values ----

func metaU64(v any) uint64 {
	switch x := v.(type) {
	case uint64:
		return x
	case uint32:
		return uint64(x)
	case uint16:
		return uint64(x)
	case uint8:
		return uint64(x)
	case int64:
		if x > 0 {
			return uint64(x)
		}
	case int32:
		if x > 0 {
			return uint64(x)
		}
	case float64:
		if x > 0 {
			return uint64(x)
		}
	case float32:
		if x > 0 {
			return uint64(x)
		}
	}
	return 0
}

func metaU32(v any) uint32 {
	return uint32(metaU64(v))
}

func metaF64(v any) float64 {
	switch x := v.(type) {
	case float64:
		return x
	case float32:
		return float64(x)
	case uint64:
		return float64(x)
	case uint32:
		return float64(x)
	case int64:
		return float64(x)
	}
	return 0
}

func firstSuffix(meta map[string]any, suffix string) (any, bool) {
	for k, v := range meta {
		if strings.HasSuffix(k, suffix) {
			return v, true
		}
	}
	return nil, false
}

// perLayerKV expands a head_count_kv raw value (scalar or array) into one entry
// per layer. When absent returns nil.
func perLayerKV(raw any, nLayer int) []uint32 {
	if raw == nil {
		return nil
	}
	if arr, ok := raw.([]any); ok {
		out := make([]uint32, nLayer)
		for i := 0; i < nLayer; i++ {
			if i < len(arr) {
				out[i] = metaU32(arr[i])
			}
		}
		return out
	}
	v := metaU32(raw)
	if v == 0 {
		return nil
	}
	out := make([]uint32, nLayer)
	for i := range out {
		out[i] = v
	}
	return out
}

func perLayerBool(raw any, nLayer int) []bool {
	out := make([]bool, nLayer)
	if raw == nil {
		return out
	}
	if arr, ok := raw.([]any); ok {
		for i := 0; i < nLayer && i < len(arr); i++ {
			if b, ok := arr[i].(bool); ok {
				out[i] = b
			}
		}
	}
	return out
}

// KVShapeFromMetadata derives the authoritative per-token KV cache size from
// raw GGUF metadata. It never guesses: every number either comes from a GGUF
// key or from llama.cpp's documented default (head dim = n_embd/n_head).
func KVShapeFromMetadata(meta map[string]any) *KVShape {
	sh := &KVShape{Source: "GGUF"}

	if v, ok := meta["general.architecture"]; ok {
		sh.Architecture = toString(v)
	}
	if v, ok := firstSuffix(meta, ".block_count"); ok {
		sh.Layers = int(metaU64(v))
	}
	if v, ok := firstSuffix(meta, ".embedding_length"); ok {
		sh.EmbeddingLength = metaU64(v)
	}
	if v, ok := firstSuffix(meta, ".head_count"); ok {
		sh.HeadCount = metaU64(v)
	}
	if sh.Layers <= 0 {
		return sh
	}
	// head dim default = n_embd / n_head (llama.cpp default when no explicit key)
	hdDefault := uint32(0)
	if sh.HeadCount > 0 && sh.EmbeddingLength > 0 {
		hdDefault = uint32(math.Round(float64(sh.EmbeddingLength) / float64(sh.HeadCount)))
	}
	sh.HeadDimDefault = hdDefault

	kvRaw, hasKV := firstSuffix(meta, ".attention.head_count_kv")
	keyL, hasKL := firstSuffix(meta, ".attention.key_length")
	valL, hasVL := firstSuffix(meta, ".attention.value_length")
	keySwa, hasKS := firstSuffix(meta, ".attention.key_length_swa")
	valSwa, hasVS := firstSuffix(meta, ".attention.value_length_swa")
	patRaw, hasPat := firstSuffix(meta, ".attention.sliding_window_pattern")
	winRaw, hasWin := firstSuffix(meta, ".attention.sliding_window")

	// per-layer kv heads
	nkv := perLayerKV(kvRaw, sh.Layers)
	// per-layer is_swa (llama.cpp marks window layers via sliding_window_pattern)
	isSwa := make([]bool, sh.Layers)
	if hasPat {
		isSwa = perLayerBool(patRaw, sh.Layers)
	}
	if hasWin {
		sh.SlidingWindow = metaU32(winRaw)
	}

	// per-head dims: full vs swa
	dkFull := hdDefault
	if hasKL {
		dkFull = metaU32(keyL)
	}
	dvFull := dkFull
	if hasVL {
		dvFull = metaU32(valL)
	}
	dkSwa := dkFull
	if hasKS {
		dkSwa = metaU32(keySwa)
	}
	dvSwa := dvFull
	if hasVS {
		dvSwa = metaU32(valSwa)
	}
	sh.Source = "GGUF 键(key_length/value_length, head_count_kv" +
		boolNote(hasKV, "数组/标量") + ")" +
		boolNote(hasPat, " sliding_window_pattern") +
		boolNote(hasKL, " key_length")

	sh.HeadCountKVPerLayer = make([]uint32, sh.Layers)
	sh.HeadDimKPerLayer = make([]uint32, sh.Layers)
	sh.HeadDimVPerLayer = make([]uint32, sh.Layers)
	sh.IsSWAPerLayer = make([]bool, sh.Layers)

	var perTok float64
	var fixedBytes float64
	for il := 0; il < sh.Layers; il++ {
		var kv uint32
		if nkv != nil {
			kv = nkv[il]
		}
		if kv == 0 {
			kv = uint32(sh.HeadCount) // default: n_head_kv = n_head
		}
		sw := isSwa[il]
		sh.IsSWAPerLayer[il] = sw
		sh.HeadCountKVPerLayer[il] = kv
		var dk, dv uint32
		if sw {
			dk, dv = dkSwa, dvSwa
		} else {
			dk, dv = dkFull, dvFull
		}
		sh.HeadDimKPerLayer[il] = dk
		sh.HeadDimVPerLayer[il] = dv
		// bytes per layer per token (K+V, f16) = kv*(dk+dv)*2
		layerBytes := float64(kv) * float64(dk+dv) * 2
		if sw {
			sh.SWALayers++
			if sh.SlidingWindow > 0 {
				fixedBytes += layerBytes * float64(sh.SlidingWindow)
			}
		} else {
			sh.FullLayers++
			perTok += layerBytes
		}
	}
	sh.KVPerTokenBytesF16 = perTok
	sh.FixedSWACacheMB = math.Round(fixedBytes/1024/1024*10) / 10
	if sh.SWALayers > 0 && sh.FixedSWACacheMB <= 0 {
		sh.FixedSWACacheMB = 0
	}
	return sh
}

func boolNote(ok bool, label string) string {
	if ok {
		return label
	}
	return ""
}

func toString(v any) string {
	if s, ok := v.(string); ok {
		return s
	}
	return ""
}
