package config

// audit.go implements the configuration health audit. It inspects a resolved
// parameter set plus model/hardware context and returns structured warnings
// and errors displayed in the web UI.

import "fmt"

// AuditLevel is the severity of an audit finding.
type AuditLevel int

const (
	AuditInfo  AuditLevel = iota // 💡 优化建议
	AuditWarn                    // 🟡 提示
	AuditError                   // 🔴 错误
)

func (l AuditLevel) String() string {
	switch l {
	case AuditInfo:
		return "info"
	case AuditWarn:
		return "warn"
	default:
		return "error"
	}
}

// AuditItem is a single finding.
type AuditItem struct {
	Code    string     `json:"code"`
	Level   AuditLevel `json:"level"`
	Message string     `json:"message"`
	Field   string     `json:"field,omitempty"`
}

// AuditConfig runs all audit checks against a resolved parameter map.
func AuditConfig(params map[string]any, spec ModelSpec, hw *HardwareInfo) []AuditItem {
	var items []AuditItem

	// VRAM budget
	ngl := intParam(params, "n_gpu_layers")
	ctx := intParam(params, "ctx_size")
	kvK := strParam(params, "cache_type_k")
	kvV := strParam(params, "cache_type_v")
	mmprojCPU := boolParam(params, "no_mmproj_offload")
	est := EstimateVRAMEx(spec, ngl, ctx, hw, kvK, kvV, mmprojCPU)
	if hw != nil && hw.TotalVRAMMB > 0 {
		avail := float64(hw.FreeVRAMMB) / 1024.0
		if est > avail {
			items = append(items, AuditItem{
				Code: "vram_over", Level: AuditError, Field: "n_gpu_layers",
				Message: fmt.Sprintf("VRAM 预算 %.1fGB 超过可用显存 %.1fGB，启动可能导致 OOM 崩溃", est, avail),
			})
		} else if avail-est < 0.5 {
			items = append(items, AuditItem{
				Code: "vram_tight", Level: AuditWarn, Field: "n_gpu_layers",
				Message: fmt.Sprintf("VRAM 余量仅 %.1fGB，建议降低 GPU 层数或上下文", avail-est),
			})
		}
	}

	// Vision projector: in pure-text usage it can run on CPU to free VRAM.
	if spec.MMProjSizeMB > 0 && !mmprojCPU {
		items = append(items, AuditItem{
			Code: "mmproj_vram", Level: AuditInfo, Field: "no_mmproj_offload",
			Message: fmt.Sprintf("已绑定视觉投影 mmproj (%.0f MB)，纯文本场景勾选「mmproj 走 CPU」可省显存给主模型层", spec.MMProjSizeMB),
		})
	}

	// Sampler conflicts: Mirostat + top-k/top-p
	if mirostat := strParam(params, "mirostat"); mirostat != "" && mirostat != "0" {
		if strParam(params, "top_k") != "" || strParam(params, "top_p") != "" {
			items = append(items, AuditItem{
				Code: "sampler_conflict", Level: AuditWarn, Field: "mirostat",
				Message: "Mirostat 与 Top-K/Top-P 同时启用可能导致采样行为异常",
			})
		}
	}

	// KV quantization + FA (only truly-quantized cache types; f32/f16/bf16 are not)
	if kv := strParam(params, "cache_type_v"); isQuantizedKV(kv) {
		if fa := strParam(params, "flash_attn"); fa == "off" {
			items = append(items, AuditItem{
				Code: "kvq_fa", Level: AuditWarn, Field: "cache_type_v",
				Message: "KV 缓存已量化但 Flash Attention 关闭，性能可能下降",
			})
		}
	}

	// MoE suggestion
	if spec.IsMoE && !boolParam(params, "cpu_moe") {
		items = append(items, AuditItem{
			Code: "moe_cpu", Level: AuditInfo, Field: "cpu_moe",
			Message: "MoE 模型建议启用 --cpu-moe 可节省显存",
		})
	}

	// Context vs metadata
	if spec.ContextLength > 0 && uint64(ctx) > spec.ContextLength {
		items = append(items, AuditItem{
			Code: "ctx_exceed", Level: AuditWarn, Field: "ctx_size",
			Message: fmt.Sprintf("上下文 %d 超过模型原生上下文 %d，可能超出训练范围", ctx, spec.ContextLength),
		})
	}
	return items
}

// ---- param access helpers (values come from a resolved map) ----

func intParam(m map[string]any, key string) int {
	switch v := m[key].(type) {
	case int:
		return v
	case int64:
		return int(v)
	case float64:
		return int(v)
	case string:
		var n int
		fmt.Sscanf(v, "%d", &n)
		return n
	}
	return 0
}

func strParam(m map[string]any, key string) string {
	if s, ok := m[key].(string); ok {
		return s
	}
	return ""
}

// isQuantizedKV reports whether a KV cache type is a quantized format.
// f32 / f16 / bf16 are floating point types and are NOT quantized.
func isQuantizedKV(kv string) bool {
	switch kv {
	case "q8_0", "q4_0", "q4_1", "iq4_nl", "q5_0", "q5_1":
		return true
	}
	return false
}

func boolParam(m map[string]any, key string) bool {
	b, _ := m[key].(bool)
	return b
}
