package config

// registry.go defines the complete llama-server parameter matrix (2026).
// Each ParamDef maps a canonical key to its CLI flags, control kind and
// default value. This is the single source of truth used by:
//   - the CLI command generator (Chain.ArgList)
//   - the web UI form renderer
//   - the config health audit

// ParamKind describes how a parameter is rendered/validated.
type ParamKind string

const (
	KindInt     ParamKind = "int"     // integer with optional min/max
	KindFloat   ParamKind = "float"   // float with optional min/max
	KindBool    ParamKind = "bool"    // flag only, no value
	KindString  ParamKind = "string"  // free text
	KindEnum    ParamKind = "enum"    // dropdown
	KindMulti   ParamKind = "multi"   // multi-select
	KindRange   ParamKind = "range"   // "lo-hi" style string
	KindSecret  ParamKind = "secret"  // password field
	KindFile    ParamKind = "file"    // file picker
)

// ParamGroup is a UI grouping for the parameter matrix.
type ParamGroup string

const (
	GroupBasic   ParamGroup = "basic"   // 📁 基础设置
	GroupPerf    ParamGroup = "perf"    // ⚡ 性能调优
	GroupMemory  ParamGroup = "memory"  // 🧠 内存与加载
	GroupCPU     ParamGroup = "cpu"     // 🔧 CPU 与调度
	GroupSample  ParamGroup = "sample"  // 🎨 生成控制
	GroupSpec    ParamGroup = "spec"    // 🧩 投机解码
	GroupSource  ParamGroup = "source"  // 📥 模型来源
	GroupNetwork ParamGroup = "network" // 🌐 网络与安全
	GroupChat    ParamGroup = "chat"    // 🧩 模板与推理
	GroupLog     ParamGroup = "log"     // 📝 日志与调试
)

// ParamDef describes a single parameter.
type ParamDef struct {
	Key          string     // canonical key, e.g. "n_gpu_layers"
	Flag         string     // short flag, e.g. "-ngl" ("" if none)
	LongFlag     string     // long flag, e.g. "--n-gpu-layers"
	Kind         ParamKind  // control kind
	Group        ParamGroup // UI group
	Label        string     // Chinese label for the UI
	Default      any        // default value
	Enum         []string   // choices for KindEnum / KindMulti
	Min, Max     float64    // bounds for numeric kinds
	RequiresValue bool      // false => boolean style flag without "=value"
	AlwaysEmit   bool       // true => always emit even when default
}

// Registry holds all known parameters.
type Registry struct {
	defs map[string]*ParamDef
}

// NewRegistry builds the 2026 parameter matrix.
func NewRegistry() *Registry {
	r := &Registry{defs: make(map[string]*ParamDef, len(paramMatrix))}
	for i := range paramMatrix {
		d := &paramMatrix[i]
		r.defs[d.Key] = d
	}
	return r
}

// Get returns the definition for a canonical key.
func (r *Registry) Get(key string) (*ParamDef, bool) {
	d, ok := r.defs[key]
	return d, ok
}

// All returns definitions ordered by group.
func (r *Registry) All() []*ParamDef {
	out := make([]*ParamDef, 0, len(r.defs))
	seen := make(map[string]bool, len(r.defs))
	for i := range paramMatrix {
		d := &paramMatrix[i]
		if !seen[d.Key] {
			out = append(out, d)
			seen[d.Key] = true
		}
	}
	return out
}

// ParamInfo is a serializable parameter definition with help text.
type ParamInfo struct {
	Key      string   `json:"key"`
	Flag     string   `json:"flag"`
	LongFlag string   `json:"long_flag"`
	Label    string   `json:"label"`
	Group    string   `json:"group"`
	Kind     string   `json:"kind"`
	Default  any      `json:"default"`
	Enum     []string `json:"enum,omitempty"`
	Min      float64  `json:"min,omitempty"`
	Max      float64  `json:"max,omitempty"`
	Help     string   `json:"help"`
}

// Params returns all definitions ordered by group, with help text merged in.
func (r *Registry) Params() []ParamInfo {
	out := make([]ParamInfo, 0, len(r.defs))
	for _, d := range r.All() {
		out = append(out, ParamInfo{
			Key:      d.Key,
			Flag:     d.Flag,
			LongFlag: d.LongFlag,
			Label:    d.Label,
			Group:    string(d.Group),
			Kind:     string(d.Kind),
			Default:  d.Default,
			Enum:     d.Enum,
			Min:      d.Min,
			Max:      d.Max,
			Help:     paramHelp[d.Key],
		})
	}
	return out
}

// paramMatrix is the full 2026 parameter set, grouped per the product spec.
var paramMatrix = []ParamDef{
	// ── 📁 基础设置 ─────────────────────────────────────────────
	{Key: "model", LongFlag: "--model", Flag: "-m", Kind: KindString, Group: GroupBasic, Label: "模型路径", Default: "", RequiresValue: true},
	{Key: "host", LongFlag: "--host", Kind: KindString, Group: GroupBasic, Label: "监听地址", Default: "127.0.0.1", RequiresValue: true},
	{Key: "port", LongFlag: "--port", Kind: KindInt, Group: GroupBasic, Label: "端口", Default: 8080, Min: 1, Max: 65535, RequiresValue: true},
	{Key: "api_key", LongFlag: "--api-key", Kind: KindSecret, Group: GroupBasic, Label: "API Key", Default: "", RequiresValue: true},
	{Key: "api_key_file", LongFlag: "--api-key-file", Kind: KindFile, Group: GroupBasic, Label: "API Key 文件", Default: "", RequiresValue: true},

	// ── ⚡ 性能调优 ─────────────────────────────────────────────
	{Key: "n_gpu_layers", LongFlag: "--n-gpu-layers", Flag: "-ngl", Kind: KindInt, Group: GroupPerf, Label: "GPU 层数", Default: 0, Min: -1, Max: 200, RequiresValue: true},
	{Key: "device", LongFlag: "--device", Flag: "-dev", Kind: KindMulti, Group: GroupPerf, Label: "GPU 设备", Default: nil, RequiresValue: true},
	{Key: "main_gpu", LongFlag: "--main-gpu", Flag: "-mg", Kind: KindInt, Group: GroupPerf, Label: "主 GPU", Default: 0, Min: 0, RequiresValue: true},
	{Key: "split_mode", LongFlag: "--split-mode", Flag: "-sm", Kind: KindEnum, Group: GroupPerf, Label: "张量拆分模式", Default: "layer", Enum: []string{"none", "layer", "row", "tensor"}, RequiresValue: true},
	{Key: "tensor_split", LongFlag: "--tensor-split", Flag: "-ts", Kind: KindString, Group: GroupPerf, Label: "张量分配", Default: "", RequiresValue: true},
	{Key: "fit", LongFlag: "--fit", Kind: KindBool, Group: GroupPerf, Label: "自动适配显存", Default: false},
	{Key: "threads", LongFlag: "--threads", Flag: "-t", Kind: KindInt, Group: GroupPerf, Label: "线程数", Default: 0, Min: 1, Max: 1024, RequiresValue: true},
	{Key: "threads_batch", LongFlag: "--threads-batch", Flag: "-tb", Kind: KindInt, Group: GroupPerf, Label: "批处理线程数", Default: 0, Min: 1, Max: 1024, RequiresValue: true},
	{Key: "ctx_size", LongFlag: "--ctx-size", Flag: "-c", Kind: KindInt, Group: GroupPerf, Label: "上下文长度", Default: 4096, Min: 128, Max: 262144, RequiresValue: true},
	{Key: "batch_size", LongFlag: "--batch-size", Flag: "-b", Kind: KindInt, Group: GroupPerf, Label: "批大小", Default: 2048, Min: 1, Max: 65536, RequiresValue: true},
	{Key: "ubatch_size", LongFlag: "--ubatch-size", Flag: "-ub", Kind: KindInt, Group: GroupPerf, Label: "微批大小", Default: 512, Min: 1, Max: 65536, RequiresValue: true},
	{Key: "flash_attn", LongFlag: "--flash-attn", Flag: "-fa", Kind: KindEnum, Group: GroupPerf, Label: "Flash Attention", Default: "on", Enum: []string{"on", "off", "auto"}, RequiresValue: true},
	{Key: "cache_type_k", LongFlag: "--cache-type-k", Flag: "-ctk", Kind: KindEnum, Group: GroupPerf, Label: "K 缓存类型", Default: "f16", Enum: []string{"f32", "f16", "bf16", "q8_0", "q4_0", "q4_1", "iq4_nl", "q5_0", "q5_1"}, RequiresValue: true},
	{Key: "cache_type_v", LongFlag: "--cache-type-v", Flag: "-ctv", Kind: KindEnum, Group: GroupPerf, Label: "V 缓存类型", Default: "f16", Enum: []string{"f32", "f16", "bf16", "q8_0", "q4_0", "q4_1", "iq4_nl", "q5_0", "q5_1"}, RequiresValue: true},
	{Key: "cpu_moe", LongFlag: "--cpu-moe", Kind: KindBool, Group: GroupPerf, Label: "MoE 专家驻留 CPU", Default: false},
	{Key: "n_cpu_moe", LongFlag: "--n-cpu-moe", Kind: KindInt, Group: GroupPerf, Label: "CPU 专家数", Default: 0, Min: 0, RequiresValue: true},
	{Key: "fit_target", LongFlag: "--fit-target", Kind: KindString, Group: GroupPerf, Label: "每设备显存余量", Default: "", RequiresValue: true},
	{Key: "fit_ctx", LongFlag: "--fit-ctx", Kind: KindInt, Group: GroupPerf, Label: "--fit 最小上下文", Default: 0, Min: 0, RequiresValue: true},
	{Key: "check_tensors", LongFlag: "--check-tensors", Kind: KindBool, Group: GroupPerf, Label: "启动校验张量", Default: false},
	{Key: "rope_scaling", LongFlag: "--rope-scaling", Kind: KindEnum, Group: GroupPerf, Label: "RoPE 缩放方式", Default: "", Enum: []string{"", "none", "linear", "yarn"}, RequiresValue: true},
	{Key: "rope_scale", LongFlag: "--rope-scale", Kind: KindFloat, Group: GroupPerf, Label: "RoPE 缩放因子", Default: 0.0, Min: 0, Max: 1000, RequiresValue: true},
	{Key: "mmproj", LongFlag: "--mmproj", Flag: "-mm", Kind: KindFile, Group: GroupPerf, Label: "多模态投影文件", Default: "", RequiresValue: true},
	{Key: "parallel", LongFlag: "--parallel", Flag: "-np", Kind: KindInt, Group: GroupPerf, Label: "并行槽位数", Default: -1, Min: -1, Max: 1024, RequiresValue: true},
	{Key: "cont_batching", LongFlag: "--cont-batching", Kind: KindBool, Group: GroupPerf, Label: "连续批处理", Default: false},
	{Key: "slot_prompt_similarity", LongFlag: "--slot-prompt-similarity", Kind: KindFloat, Group: GroupPerf, Label: "槽位复用相似度", Default: 0.10, Min: 0, Max: 1, RequiresValue: true},
	{Key: "rope_freq_base", LongFlag: "--rope-freq-base", Kind: KindFloat, Group: GroupPerf, Label: "RoPE 基础频率", Default: 0.0, Min: 0, RequiresValue: true},
	{Key: "yarn_orig_ctx", LongFlag: "--yarn-orig-ctx", Kind: KindInt, Group: GroupPerf, Label: "YaRN 原始上下文", Default: 0, Min: 0, RequiresValue: true},
	{Key: "yarn_ext_factor", LongFlag: "--yarn-ext-factor", Kind: KindFloat, Group: GroupPerf, Label: "YaRN 外推因子", Default: -1.0, RequiresValue: true},
	{Key: "yarn_attn_factor", LongFlag: "--yarn-attn-factor", Kind: KindFloat, Group: GroupPerf, Label: "YaRN 注意力因子", Default: -1.0, RequiresValue: true},
	{Key: "yarn_beta_fast", LongFlag: "--yarn-beta-fast", Kind: KindFloat, Group: GroupPerf, Label: "YaRN 快端校正", Default: -1.0, RequiresValue: true},
	{Key: "yarn_beta_slow", LongFlag: "--yarn-beta-slow", Kind: KindFloat, Group: GroupPerf, Label: "YaRN 慢端校正", Default: -1.0, RequiresValue: true},
	{Key: "mmproj_url", LongFlag: "--mmproj-url", Flag: "-mmu", Kind: KindString, Group: GroupPerf, Label: "mmproj 下载 URL", Default: "", RequiresValue: true},
	{Key: "mmproj_device", LongFlag: "--mmproj-device", Flag: "-mmdev", Kind: KindString, Group: GroupPerf, Label: "mmproj 设备", Default: "", RequiresValue: true},
	{Key: "image_min_tokens", LongFlag: "--image-min-tokens", Kind: KindInt, Group: GroupPerf, Label: "图像最小 token", Default: 0, Min: 0, RequiresValue: true},
	{Key: "image_max_tokens", LongFlag: "--image-max-tokens", Kind: KindInt, Group: GroupPerf, Label: "图像最大 token", Default: 0, Min: 0, RequiresValue: true},
	{Key: "mtmd_batch_max_tokens", LongFlag: "--mtmd-batch-max-tokens", Kind: KindInt, Group: GroupPerf, Label: "多模态批最大 token", Default: 1024, Min: 0, RequiresValue: true},
	{Key: "embedding", LongFlag: "--embedding", Kind: KindBool, Group: GroupPerf, Label: "嵌入模式", Default: false},
	{Key: "pooling", LongFlag: "--pooling", Kind: KindEnum, Group: GroupPerf, Label: "嵌入池化", Default: "", Enum: []string{"", "none", "mean", "cls", "last", "rank"}, RequiresValue: true},
	{Key: "embd_normalize", LongFlag: "--embd-normalize", Kind: KindInt, Group: GroupPerf, Label: "嵌入归一化", Default: 2, Min: -1, RequiresValue: true},
	{Key: "rerank", LongFlag: "--rerank", Kind: KindBool, Group: GroupPerf, Label: "重排模式", Default: false},

	// ── 🧠 内存与加载 ───────────────────────────────────────────
	{Key: "load_mode", LongFlag: "--load-mode", Kind: KindEnum, Group: GroupMemory, Label: "加载模式", Default: "mmap", Enum: []string{"none", "mmap", "mlock", "mmap+mlock", "dio"}, RequiresValue: true},
	{Key: "kv_offload", LongFlag: "--kv-offload", Kind: KindBool, Group: GroupMemory, Label: "KV 缓存卸载 GPU", Default: false},
	{Key: "repack", LongFlag: "--repack", Kind: KindBool, Group: GroupMemory, Label: "权重重打包", Default: false},
	{Key: "no_host", LongFlag: "--no-host", Kind: KindBool, Group: GroupMemory, Label: "绕过主机缓冲区", Default: false},
	{Key: "numa", LongFlag: "--numa", Kind: KindEnum, Group: GroupMemory, Label: "NUMA 策略", Default: "", Enum: []string{"", "distribute", "isolate", "numactl"}, RequiresValue: true},
	{Key: "op_offload", LongFlag: "--op-offload", Kind: KindBool, Group: GroupMemory, Label: "张量操作卸载", Default: false},
	{Key: "cache_ram", LongFlag: "--cache-ram", Flag: "-cram", Kind: KindInt, Group: GroupMemory, Label: "提示缓存内存(MiB)", Default: 8192, Min: -1, Max: 1048576, RequiresValue: true},
	{Key: "ctx_checkpoints", LongFlag: "--ctx-checkpoints", Flag: "-ctxcp", Kind: KindInt, Group: GroupMemory, Label: "上下文检查点", Default: 32, Min: 0, RequiresValue: true},
	{Key: "checkpoint_min_step", LongFlag: "--checkpoint-min-step", Kind: KindInt, Group: GroupMemory, Label: "检查点最小间隔", Default: 8192, Min: 0, RequiresValue: true},
	{Key: "keep", LongFlag: "--keep", Kind: KindInt, Group: GroupMemory, Label: "保留初始 token", Default: 0, Min: 0, RequiresValue: true},
	{Key: "grp_attn_n", LongFlag: "--grp-attn-n", Kind: KindInt, Group: GroupMemory, Label: "分组注意力 n", Default: 0, Min: 0, RequiresValue: true},
	{Key: "grp_attn_w", LongFlag: "--grp-attn-w", Kind: KindInt, Group: GroupMemory, Label: "分组注意力 w", Default: 0, Min: 0, RequiresValue: true},
	{Key: "kv_unified", LongFlag: "--kv-unified", Flag: "-kvu", Kind: KindBool, Group: GroupMemory, Label: "统一 KV 缓冲", Default: false},
	{Key: "cache_idle_slots", LongFlag: "--cache-idle-slots", Kind: KindBool, Group: GroupMemory, Label: "缓存空闲槽位", Default: false},
	{Key: "cache_reuse", LongFlag: "--cache-reuse", Kind: KindInt, Group: GroupMemory, Label: "KV 复用最小块", Default: 0, Min: 0, RequiresValue: true},
	{Key: "cache_prompt", LongFlag: "--cache-prompt", Kind: KindBool, Group: GroupMemory, Label: "提示缓存", Default: false},
	{Key: "context_shift", LongFlag: "--context-shift", Kind: KindBool, Group: GroupMemory, Label: "上下文移位", Default: false},
	{Key: "swa_full", LongFlag: "--swa-full", Kind: KindBool, Group: GroupMemory, Label: "全尺寸 SWA 缓存", Default: false},
	{Key: "slot_save_path", LongFlag: "--slot-save-path", Kind: KindString, Group: GroupMemory, Label: "槽位保存目录", Default: "", RequiresValue: true},

	// ── 🔧 CPU 与调度 ───────────────────────────────────────────
	{Key: "cpu_mask", LongFlag: "--cpu-mask", Kind: KindString, Group: GroupCPU, Label: "CPU 亲和掩码", Default: "", RequiresValue: true},
	{Key: "cpu_range", LongFlag: "--cpu-range", Kind: KindRange, Group: GroupCPU, Label: "CPU 范围", Default: "", RequiresValue: true},
	{Key: "cpu_strict", LongFlag: "--cpu-strict", Kind: KindBool, Group: GroupCPU, Label: "严格 CPU 放置", Default: false},
	{Key: "prio", LongFlag: "--prio", Kind: KindInt, Group: GroupCPU, Label: "进程优先级", Default: 0, Min: -1, Max: 3, RequiresValue: true},
	{Key: "poll", LongFlag: "--poll", Kind: KindInt, Group: GroupCPU, Label: "轮询级别", Default: 50, Min: 0, Max: 100, RequiresValue: true},
	{Key: "cpu_mask_batch", LongFlag: "--cpu-mask-batch", Kind: KindString, Group: GroupCPU, Label: "批阶段掩码", Default: "", RequiresValue: true},
	{Key: "cpu_range_batch", LongFlag: "--cpu-range-batch", Kind: KindRange, Group: GroupCPU, Label: "批阶段 CPU 范围", Default: "", RequiresValue: true},
	{Key: "prio_batch", LongFlag: "--prio-batch", Kind: KindInt, Group: GroupCPU, Label: "批阶段优先级", Default: 0, Min: -1, Max: 3, RequiresValue: true},
	{Key: "poll_batch", LongFlag: "--poll-batch", Kind: KindInt, Group: GroupCPU, Label: "批阶段轮询", Default: 50, Min: 0, Max: 100, RequiresValue: true},

	// ── 🎨 生成控制 ─────────────────────────────────────────────
	{Key: "samplers", LongFlag: "--samplers", Kind: KindString, Group: GroupSample, Label: "采样器链", Default: "penalties;dry;top_k;top_p;min_p;temperature", RequiresValue: true},
	{Key: "temperature", LongFlag: "--temperature", Flag: "--temp", Kind: KindFloat, Group: GroupSample, Label: "温度", Default: 0.80, Min: 0, Max: 2, RequiresValue: true},
	{Key: "top_k", LongFlag: "--top-k", Kind: KindInt, Group: GroupSample, Label: "Top-K", Default: 40, Min: 0, Max: 100000, RequiresValue: true},
	{Key: "top_p", LongFlag: "--top-p", Kind: KindFloat, Group: GroupSample, Label: "Top-P", Default: 0.95, Min: 0, Max: 1, RequiresValue: true},
	{Key: "min_p", LongFlag: "--min-p", Kind: KindFloat, Group: GroupSample, Label: "Min-P", Default: 0.05, Min: 0, Max: 1, RequiresValue: true},
	{Key: "seed", LongFlag: "--seed", Flag: "-s", Kind: KindInt, Group: GroupSample, Label: "随机种子", Default: -1, RequiresValue: true},
	{Key: "predict", LongFlag: "--predict", Flag: "-n", Kind: KindInt, Group: GroupSample, Label: "最大预测数", Default: -1, Min: -1, RequiresValue: true},
	{Key: "dry_multiplier", LongFlag: "--dry-multiplier", Kind: KindFloat, Group: GroupSample, Label: "DRY 乘数", Default: 0.0, Min: 0, Max: 10, RequiresValue: true},
	{Key: "dry_base", LongFlag: "--dry-base", Kind: KindFloat, Group: GroupSample, Label: "DRY 基数", Default: 1.75, Min: 0, Max: 10, RequiresValue: true},
	{Key: "dry_allowed_length", LongFlag: "--dry-allowed-length", Kind: KindInt, Group: GroupSample, Label: "DRY 允许长度", Default: 2, Min: 0, RequiresValue: true},
	{Key: "dry_penalty_last_n", LongFlag: "--dry-penalty-last-n", Kind: KindInt, Group: GroupSample, Label: "DRY 惩罚窗口", Default: -1, Min: -1, RequiresValue: true},
	{Key: "xtc_probability", LongFlag: "--xtc-probability", Kind: KindFloat, Group: GroupSample, Label: "XTC 概率", Default: 0.0, Min: 0, Max: 1, RequiresValue: true},
	{Key: "xtc_threshold", LongFlag: "--xtc-threshold", Kind: KindFloat, Group: GroupSample, Label: "XTC 阈值", Default: 0.1, Min: 0, Max: 1, RequiresValue: true},
	{Key: "top_nsigma", LongFlag: "--top-nsigma", Kind: KindFloat, Group: GroupSample, Label: "Top-N-Sigma", Default: -1, Min: -1, Max: 10, RequiresValue: true},
	{Key: "adaptive_target", LongFlag: "--adaptive-target", Kind: KindFloat, Group: GroupSample, Label: "Adaptive-P 目标", Default: 0.0, Min: 0, Max: 1, RequiresValue: true},
	{Key: "adaptive_decay", LongFlag: "--adaptive-decay", Kind: KindFloat, Group: GroupSample, Label: "Adaptive-P 衰减", Default: 0.0, Min: 0, Max: 1, RequiresValue: true},
	{Key: "typical", LongFlag: "--typical", Kind: KindFloat, Group: GroupSample, Label: "Locally Typical", Default: 1.0, Min: 0, Max: 1, RequiresValue: true},
	{Key: "dynatemp_range", LongFlag: "--dynatemp-range", Kind: KindFloat, Group: GroupSample, Label: "动态温度范围", Default: 0.0, Min: 0, Max: 5, RequiresValue: true},
	{Key: "dynatemp_exp", LongFlag: "--dynatemp-exp", Kind: KindFloat, Group: GroupSample, Label: "动态温度指数", Default: 1.0, Min: 0, Max: 5, RequiresValue: true},
	{Key: "mirostat", LongFlag: "--mirostat", Kind: KindEnum, Group: GroupSample, Label: "Mirostat", Default: 0, Enum: []string{"0", "1", "2"}, RequiresValue: true},
	{Key: "mirostat_lr", LongFlag: "--mirostat-lr", Kind: KindFloat, Group: GroupSample, Label: "Mirostat 学习率", Default: 0.1, Min: 0, Max: 1, RequiresValue: true},
	{Key: "mirostat_ent", LongFlag: "--mirostat-ent", Kind: KindFloat, Group: GroupSample, Label: "Mirostat 熵目标", Default: 5.0, Min: 0, Max: 10, RequiresValue: true},
	{Key: "grammar", LongFlag: "--grammar", Kind: KindString, Group: GroupSample, Label: "BNF 语法", Default: "", RequiresValue: true},
	{Key: "grammar_file", LongFlag: "--grammar-file", Kind: KindFile, Group: GroupSample, Label: "BNF 语法文件", Default: "", RequiresValue: true},
	{Key: "json_schema", LongFlag: "--json-schema", Kind: KindString, Group: GroupSample, Label: "JSON Schema", Default: "", RequiresValue: true},
	{Key: "json_schema_file", LongFlag: "--json-schema-file", Kind: KindFile, Group: GroupSample, Label: "JSON Schema 文件", Default: "", RequiresValue: true},
	{Key: "repeat_penalty", LongFlag: "--repeat-penalty", Kind: KindFloat, Group: GroupSample, Label: "重复惩罚", Default: 1.00, Min: 0, Max: 10, RequiresValue: true},
	{Key: "repeat_last_n", LongFlag: "--repeat-last-n", Kind: KindInt, Group: GroupSample, Label: "惩罚回溯长度", Default: 64, Min: 0, RequiresValue: true},
	{Key: "presence_penalty", LongFlag: "--presence-penalty", Kind: KindFloat, Group: GroupSample, Label: "存在惩罚", Default: 0.0, Min: -2, Max: 2, RequiresValue: true},
	{Key: "frequency_penalty", LongFlag: "--frequency-penalty", Kind: KindFloat, Group: GroupSample, Label: "频率惩罚", Default: 0.0, Min: -2, Max: 2, RequiresValue: true},
	{Key: "logit_bias", LongFlag: "--logit-bias", Flag: "-l", Kind: KindString, Group: GroupSample, Label: "Logit 偏置", Default: "", RequiresValue: true},

	// ── 🧩 投机解码 ─────────────────────────────────────────────
	{Key: "spec_type", LongFlag: "--spec-type", Kind: KindEnum, Group: GroupSpec, Label: "投机解码类型", Default: "", Enum: []string{"", "draft-simple", "draft-eagle3", "draft-mtp", "draft-dflash", "draft-dspark", "ngram-simple", "ngram-map-k", "ngram-map-k4v", "ngram-mod", "ngram-cache"}, RequiresValue: true},
	{Key: "model_draft", LongFlag: "--model-draft", Flag: "-md", Kind: KindFile, Group: GroupSpec, Label: "草稿模型路径", Default: "", RequiresValue: true},
	{Key: "n_gpu_layers_draft", LongFlag: "--n-gpu-layers-draft", Flag: "-ngld", Kind: KindInt, Group: GroupSpec, Label: "草稿 GPU 层数", Default: 0, Min: 0, RequiresValue: true},
	{Key: "spec_draft_threads", LongFlag: "--spec-draft-threads", Kind: KindInt, Group: GroupSpec, Label: "草稿线程数", Default: 0, Min: 0, RequiresValue: true},
	{Key: "spec_draft_cpu_mask", LongFlag: "--spec-draft-cpu-mask", Kind: KindString, Group: GroupSpec, Label: "草稿 CPU 掩码", Default: "", RequiresValue: true},
	{Key: "spec_draft_prio", LongFlag: "--spec-draft-prio", Kind: KindInt, Group: GroupSpec, Label: "草稿优先级", Default: 0, Min: -1, Max: 3, RequiresValue: true},
	{Key: "spec_draft_device", LongFlag: "--spec-draft-device", Kind: KindMulti, Group: GroupSpec, Label: "草稿设备", Default: nil, RequiresValue: true},
	{Key: "spec_draft_cache_type_k", LongFlag: "--spec-draft-cache-type-k", Kind: KindEnum, Group: GroupSpec, Label: "草稿 K 缓存", Default: "f16", Enum: []string{"f32", "f16", "bf16", "q8_0", "q4_0", "q4_1", "iq4_nl", "q5_0", "q5_1"}, RequiresValue: true},
	{Key: "spec_draft_cache_type_v", LongFlag: "--spec-draft-cache-type-v", Kind: KindEnum, Group: GroupSpec, Label: "草稿 V 缓存", Default: "f16", Enum: []string{"f32", "f16", "bf16", "q8_0", "q4_0", "q4_1", "iq4_nl", "q5_0", "q5_1"}, RequiresValue: true},
	{Key: "spec_draft_n_max", LongFlag: "--spec-draft-n-max", Kind: KindInt, Group: GroupSpec, Label: "草稿最大 token", Default: 3, Min: 1, RequiresValue: true},
	{Key: "spec_draft_n_min", LongFlag: "--spec-draft-n-min", Kind: KindInt, Group: GroupSpec, Label: "草稿最小 token", Default: 0, Min: 0, RequiresValue: true},
	{Key: "spec_draft_p_split", LongFlag: "--spec-draft-p-split", Kind: KindFloat, Group: GroupSpec, Label: "分裂概率", Default: 0.10, Min: 0, Max: 1, RequiresValue: true},
	{Key: "spec_draft_p_min", LongFlag: "--spec-draft-p-min", Kind: KindFloat, Group: GroupSpec, Label: "最小概率", Default: 0.00, Min: 0, Max: 1, RequiresValue: true},
	{Key: "spec_ngram_mod_n_min", LongFlag: "--spec-ngram-mod-n-min", Kind: KindInt, Group: GroupSpec, Label: "ngram-mod n 最小", Default: 0, Min: 0, RequiresValue: true},
	{Key: "spec_ngram_mod_n_max", LongFlag: "--spec-ngram-mod-n-max", Kind: KindInt, Group: GroupSpec, Label: "ngram-mod n 最大", Default: 4, Min: 0, RequiresValue: true},
	{Key: "spec_ngram_simple_size_n", LongFlag: "--spec-ngram-simple-size-n", Kind: KindInt, Group: GroupSpec, Label: "ngram-simple n", Default: 4, Min: 0, RequiresValue: true},
	{Key: "spec_ngram_simple_size_m", LongFlag: "--spec-ngram-simple-size-m", Kind: KindInt, Group: GroupSpec, Label: "ngram-simple m", Default: 4, Min: 0, RequiresValue: true},
	{Key: "spec_default", LongFlag: "--spec-default", Kind: KindBool, Group: GroupSpec, Label: "启用默认投机配置", Default: false},
	{Key: "spec_draft_backend_sampling", LongFlag: "--spec-draft-backend-sampling", Kind: KindBool, Group: GroupSpec, Label: "草稿后端采样", Default: false},
	{Key: "spec_draft_override_tensor", LongFlag: "--spec-draft-override-tensor", Flag: "-otd", Kind: KindString, Group: GroupSpec, Label: "草稿张量覆盖", Default: "", RequiresValue: true},
	{Key: "spec_draft_cpu_moe", LongFlag: "--spec-draft-cpu-moe", Flag: "-cmoed", Kind: KindBool, Group: GroupSpec, Label: "草稿 MoE 留 CPU", Default: false},
	{Key: "spec_draft_n_cpu_moe", LongFlag: "--n-cpu-moe-draft", Kind: KindInt, Group: GroupSpec, Label: "草稿 CPU MoE 层", Default: 0, Min: 0, RequiresValue: true},
	{Key: "spec_draft_hf", LongFlag: "--hf-repo-draft", Flag: "-hfd", Kind: KindString, Group: GroupSpec, Label: "草稿 HF 仓库", Default: "", RequiresValue: true},
	{Key: "spec_ngram_mod_n_match", LongFlag: "--spec-ngram-mod-n-match", Kind: KindInt, Group: GroupSpec, Label: "ngram-mod 匹配长度", Default: 24, Min: 0, RequiresValue: true},
	{Key: "spec_ngram_simple_min_hits", LongFlag: "--spec-ngram-simple-min-hits", Kind: KindInt, Group: GroupSpec, Label: "ngram-simple 最少命中", Default: 1, Min: 0, RequiresValue: true},
	{Key: "spec_ngram_map_k_size_n", LongFlag: "--spec-ngram-map-k-size-n", Kind: KindInt, Group: GroupSpec, Label: "ngram-map-k n", Default: 12, Min: 1, RequiresValue: true},
	{Key: "spec_ngram_map_k_size_m", LongFlag: "--spec-ngram-map-k-size-m", Kind: KindInt, Group: GroupSpec, Label: "ngram-map-k m", Default: 48, Min: 1, RequiresValue: true},
	{Key: "spec_ngram_map_k_min_hits", LongFlag: "--spec-ngram-map-k-min-hits", Kind: KindInt, Group: GroupSpec, Label: "ngram-map-k 最少命中", Default: 1, Min: 0, RequiresValue: true},
	{Key: "spec_ngram_map_k4v_size_n", LongFlag: "--spec-ngram-map-k4v-size-n", Kind: KindInt, Group: GroupSpec, Label: "ngram-map-k4v n", Default: 12, Min: 1, RequiresValue: true},
	{Key: "spec_ngram_map_k4v_size_m", LongFlag: "--spec-ngram-map-k4v-size-m", Kind: KindInt, Group: GroupSpec, Label: "ngram-map-k4v m", Default: 48, Min: 1, RequiresValue: true},
	{Key: "spec_ngram_map_k4v_min_hits", LongFlag: "--spec-ngram-map-k4v-min-hits", Kind: KindInt, Group: GroupSpec, Label: "ngram-map-k4v 最少命中", Default: 1, Min: 0, RequiresValue: true},

	// ── 📥 模型来源 ─────────────────────────────────────────────
	{Key: "hf_repo", LongFlag: "--hf-repo", Flag: "-hf", Kind: KindString, Group: GroupSource, Label: "HF 仓库", Default: "", RequiresValue: true},
	{Key: "hf_file", LongFlag: "--hf-file", Flag: "-hff", Kind: KindString, Group: GroupSource, Label: "HF 文件名覆盖", Default: "", RequiresValue: true},
	{Key: "hf_token", LongFlag: "--hf-token", Flag: "-hft", Kind: KindSecret, Group: GroupSource, Label: "HF 令牌", Default: "", RequiresValue: true},
	{Key: "model_url", LongFlag: "--model-url", Flag: "-mu", Kind: KindString, Group: GroupSource, Label: "模型 URL", Default: "", RequiresValue: true},
	{Key: "docker_repo", LongFlag: "--docker-repo", Flag: "-dr", Kind: KindString, Group: GroupSource, Label: "Docker 仓库", Default: "", RequiresValue: true},
	{Key: "no_mmproj", LongFlag: "--no-mmproj", Kind: KindBool, Group: GroupSource, Label: "禁用 mmproj 自动下载", Default: false},
	{Key: "offline", LongFlag: "--offline", Kind: KindBool, Group: GroupSource, Label: "强制使用缓存", Default: false},
	{Key: "lora", LongFlag: "--lora", Kind: KindString, Group: GroupSource, Label: "LoRA 适配器", Default: "", RequiresValue: true},
	{Key: "lora_init_without_apply", LongFlag: "--lora-init-without-apply", Kind: KindBool, Group: GroupSource, Label: "LoRA 仅加载不应用", Default: false},
	{Key: "override_tensor", LongFlag: "--override-tensor", Flag: "-ot", Kind: KindString, Group: GroupSource, Label: "张量缓冲覆盖", Default: "", RequiresValue: true},
	{Key: "override_kv", LongFlag: "--override-kv", Kind: KindString, Group: GroupSource, Label: "元数据 KV 覆盖", Default: "", RequiresValue: true},
	{Key: "models_dir", LongFlag: "--models-dir", Kind: KindString, Group: GroupSource, Label: "多模型目录", Default: "", RequiresValue: true},
	{Key: "models_preset", LongFlag: "--models-preset", Kind: KindString, Group: GroupSource, Label: "多模型预设文件", Default: "", RequiresValue: true},
	{Key: "models_max", LongFlag: "--models-max", Kind: KindInt, Group: GroupSource, Label: "同时加载最大模型数", Default: 4, Min: 1, RequiresValue: true},
	{Key: "models_autoload", LongFlag: "--models-autoload", Kind: KindBool, Group: GroupSource, Label: "多模型自动加载", Default: false},

	// ── 🌐 网络与安全 ───────────────────────────────────────────
	{Key: "ssl_key_file", LongFlag: "--ssl-key-file", Kind: KindFile, Group: GroupNetwork, Label: "SSL 密钥", Default: "", RequiresValue: true},
	{Key: "ssl_cert_file", LongFlag: "--ssl-cert-file", Kind: KindFile, Group: GroupNetwork, Label: "SSL 证书", Default: "", RequiresValue: true},
	{Key: "cors_origins", LongFlag: "--cors-origins", Kind: KindString, Group: GroupNetwork, Label: "CORS 来源", Default: "", RequiresValue: true},
	{Key: "cors_methods", LongFlag: "--cors-methods", Kind: KindString, Group: GroupNetwork, Label: "CORS 方法", Default: "", RequiresValue: true},
	{Key: "timeout", LongFlag: "--timeout", Kind: KindInt, Group: GroupNetwork, Label: "读写超时(秒)", Default: 600, Min: 0, RequiresValue: true},
	{Key: "threads_http", LongFlag: "--threads-http", Kind: KindInt, Group: GroupNetwork, Label: "HTTP 线程数", Default: -1, Min: -1, Max: 1024, RequiresValue: true},
	{Key: "metrics", LongFlag: "--metrics", Kind: KindBool, Group: GroupNetwork, Label: "Prometheus 指标端点", Default: false},
	{Key: "props", LongFlag: "--props", Kind: KindBool, Group: GroupNetwork, Label: "运行时改参数", Default: false},
	{Key: "sse_ping_interval", LongFlag: "--sse-ping-interval", Kind: KindInt, Group: GroupNetwork, Label: "SSE 心跳间隔(秒)", Default: 30, Min: 0, RequiresValue: true},
	{Key: "api_prefix", LongFlag: "--api-prefix", Kind: KindString, Group: GroupNetwork, Label: "API 前缀路径", Default: "", RequiresValue: true},
	{Key: "reuse_port", LongFlag: "--reuse-port", Kind: KindBool, Group: GroupNetwork, Label: "端口复用", Default: false},
	{Key: "cors_headers", LongFlag: "--cors-headers", Kind: KindString, Group: GroupNetwork, Label: "CORS 允许头", Default: "*", RequiresValue: true},
	{Key: "cors_credentials", LongFlag: "--cors-credentials", Kind: KindBool, Group: GroupNetwork, Label: "CORS 携带凭据", Default: false},
	{Key: "no_webui", LongFlag: "--no-webui", Kind: KindBool, Group: GroupNetwork, Label: "禁用内置 Web UI", Default: false},
	{Key: "path", LongFlag: "--path", Kind: KindString, Group: GroupNetwork, Label: "静态文件目录", Default: "", RequiresValue: true},
	{Key: "media_path", LongFlag: "--media-path", Kind: KindString, Group: GroupNetwork, Label: "媒体文件目录", Default: "", RequiresValue: true},
	{Key: "alias", LongFlag: "--alias", Flag: "-a", Kind: KindString, Group: GroupNetwork, Label: "模型别名", Default: "", RequiresValue: true},
	{Key: "tags", LongFlag: "--tags", Kind: KindString, Group: GroupNetwork, Label: "模型标签", Default: "", RequiresValue: true},
	{Key: "tools", LongFlag: "--tools", Kind: KindString, Group: GroupNetwork, Label: "内置工具列表", Default: "", RequiresValue: true},
	{Key: "tools_runtime", LongFlag: "--tools-runtime", Kind: KindEnum, Group: GroupNetwork, Label: "工具运行环境", Default: "", Enum: []string{"", "none", "docker", "podman", "ssh"}, RequiresValue: true},
	{Key: "agent", LongFlag: "--agent", Kind: KindBool, Group: GroupNetwork, Label: "Agent 模式", Default: false},
	{Key: "mcp_servers_config", LongFlag: "--mcp-servers-config", Kind: KindString, Group: GroupNetwork, Label: "MCP 配置 JSON 文件", Default: "", RequiresValue: true},
	{Key: "mcp_servers_json", LongFlag: "--mcp-servers-json", Kind: KindString, Group: GroupNetwork, Label: "MCP 内联 JSON", Default: "", RequiresValue: true},
	{Key: "ui_mcp_proxy", LongFlag: "--ui-mcp-proxy", Kind: KindBool, Group: GroupNetwork, Label: "MCP CORS 代理", Default: false},
	{Key: "rpc", LongFlag: "--rpc", Kind: KindString, Group: GroupNetwork, Label: "RPC 设备列表", Default: "", RequiresValue: true},

	// ── 🧩 模板与推理 ───────────────────────────────────────────
	{Key: "jinja", LongFlag: "--jinja", Kind: KindBool, Group: GroupChat, Label: "Jinja 模板引擎", Default: false},
	{Key: "chat_template", LongFlag: "--chat-template", Kind: KindEnum, Group: GroupChat, Label: "对话模板", Default: "", Enum: []string{"", "llama2", "llama3", "qwen", "mistral", "vicuna", "chatml", "deepseek", "gemma"}, RequiresValue: true},
	{Key: "chat_template_file", LongFlag: "--chat-template-file", Kind: KindFile, Group: GroupChat, Label: "模板文件", Default: "", RequiresValue: true},
	{Key: "reasoning", LongFlag: "--reasoning", Flag: "-rea", Kind: KindEnum, Group: GroupChat, Label: "思维链控制", Default: "auto", Enum: []string{"on", "off", "auto"}, RequiresValue: true},
	{Key: "reasoning_format", LongFlag: "--reasoning-format", Kind: KindEnum, Group: GroupChat, Label: "思维链格式", Default: "auto", Enum: []string{"auto", "thought", "deepseek", "qwen"}, RequiresValue: true},
	{Key: "reasoning_effort", LongFlag: "--reasoning-effort", Kind: KindEnum, Group: GroupChat, Label: "推理努力级别", Default: "", Enum: []string{"", "low", "medium", "high"}, RequiresValue: true},
	{Key: "reasoning_budget", LongFlag: "--reasoning-budget", Kind: KindInt, Group: GroupChat, Label: "思维链预算", Default: 0, Min: 0, RequiresValue: true},
	{Key: "chat_template_kwargs", LongFlag: "--chat-template-kwargs", Kind: KindString, Group: GroupChat, Label: "模板额外参数", Default: "", RequiresValue: true},
	{Key: "skip_chat_parsing", LongFlag: "--skip-chat-parsing", Kind: KindBool, Group: GroupChat, Label: "跳过对话解析", Default: false},
	{Key: "prefill_assistant", LongFlag: "--prefill-assistant", Kind: KindBool, Group: GroupChat, Label: "预填充助手回复", Default: false},
	{Key: "reasoning_preserve", LongFlag: "--reasoning-preserve", Kind: KindBool, Group: GroupChat, Label: "保留推理轨迹", Default: false},
	{Key: "reasoning_budget_message", LongFlag: "--reasoning-budget-message", Kind: KindString, Group: GroupChat, Label: "预算耗尽提示消息", Default: "", RequiresValue: true},

	// ── 📝 日志与调试 ───────────────────────────────────────────
	{Key: "log_file", LongFlag: "--log-file", Kind: KindFile, Group: GroupLog, Label: "日志文件", Default: "", RequiresValue: true},
	{Key: "log_colors", LongFlag: "--log-colors", Kind: KindBool, Group: GroupLog, Label: "彩色日志", Default: false},
	{Key: "log_verbosity", LongFlag: "--log-verbosity", Kind: KindInt, Group: GroupLog, Label: "日志详细度", Default: 1, Min: 0, Max: 5, RequiresValue: true},
	{Key: "log_prefix", LongFlag: "--log-prefix", Kind: KindBool, Group: GroupLog, Label: "日志前缀", Default: false},
	{Key: "log_timestamps", LongFlag: "--log-timestamps", Kind: KindBool, Group: GroupLog, Label: "日志时间戳", Default: false},
	{Key: "log_disable", LongFlag: "--log-disable", Kind: KindBool, Group: GroupLog, Label: "禁用日志", Default: false},
	{Key: "perf", LongFlag: "--perf", Kind: KindBool, Group: GroupLog, Label: "内部性能计时", Default: false},
	{Key: "reverse_prompt", LongFlag: "--reverse-prompt", Flag: "-r", Kind: KindString, Group: GroupLog, Label: "反向提示词", Default: "", RequiresValue: true},
	{Key: "special", LongFlag: "--special", Flag: "-sp", Kind: KindBool, Group: GroupLog, Label: "特殊 token 输出", Default: false},
	{Key: "warmup", LongFlag: "--warmup", Kind: KindBool, Group: GroupLog, Label: "启动预热", Default: false},
	{Key: "spm_infill", LongFlag: "--spm-infill", Kind: KindBool, Group: GroupLog, Label: "SPM 填充模式", Default: false},
	{Key: "sleep_idle_seconds", LongFlag: "--sleep-idle-seconds", Kind: KindInt, Group: GroupLog, Label: "空闲休眠秒数", Default: -1, Min: -1, RequiresValue: true},
	{Key: "log_prompts_dir", LongFlag: "--log-prompts-dir", Kind: KindString, Group: GroupLog, Label: "Prompt 日志目录", Default: "", RequiresValue: true},
}
