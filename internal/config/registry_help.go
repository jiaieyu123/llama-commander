package config

// registry_help.go holds per-parameter tuning guidance (Chinese).
// 现在改为 map[string]ParamGuidance，包含完整的结构化建议。
// 这些数据会被前端用于渲染说明卡片（📖）。

var paramGuidance = map[string]ParamGuidance{
	// ── 📁 基础设置 ─────────────────────────────────────────
	"model": {
		Description:    "模型 GGUF 文件路径（必填）。由左侧模型库选择自动填入，也可手动指定。",
		Recommendation: "从模型库选择，或拖拽 GGUF 文件到此处。",
		Related:        []string{"hf_repo", "model_url"},
	},
	"host": {
		Description:    "监听地址。默认 127.0.0.1 仅本机可访问；改成 0.0.0.0 可让局域网/其他程序调用（务必配合设置 API Key）。",
		Recommendation: "127.0.0.1（本机）或 0.0.0.0（局域网）",
		Related:        []string{"port", "api_key"},
	},
	"port": {
		Description:    "服务端口（1-65535）。启动多个实例时请用不同端口。默认 8080。",
		Recommendation: "8080（单实例）或 8081、8082...（多实例）",
		Related:        []string{"host"},
	},
	"api_key": {
		Description:    "OpenAI 兼容 API 的访问密钥。设置后调用 /v1/* 接口需在请求头带 `Authorization: Bearer <key>`。留空=不校验。推荐在 ⚙️设置 里配置全局 Key（AES-256 加密存储），此处可临时覆盖。",
		Recommendation: "留空（用全局 Key）或生成随机 256 位 Key",
		Related:        []string{},
		Note:           "全局 Key 在 ⚙️设置 → 🔑 全局 API 中配置",
	},
	"api_key_file": {
		Description:    "从文件读取 API Key（明文文件，替代在命令行传 Key，更安全）。与 api_key 二选一。",
		Recommendation: "通常不用，全局 Key 更安全",
		Related:        []string{"api_key"},
	},

	// ── ⚡ 性能调优 ─────────────────────────────────────────
	"n_gpu_layers": {
		Description:    "卸载到 GPU 的层数。0=纯 CPU；-1=自动；-2 及以上=全部。显存充足时加大可显著提速，显存不足会 OOM——可配合“一键优化”自动估算。",
		Recommendation: "RTX 3060 8GB 推荐 33；RTX 4090 24GB 推荐 80；显存不足时先减半",
		Related:        []string{"ctx_size", "cache_type_k", "cache_type_v"},
		SeeAlso:        "一键优化按钮会基于当前显存自动计算",
	},
	"device": {
		Description:    "参与计算的 GPU 设备（如 0、1）。多卡时可指定多块。",
		Recommendation: "0（单卡）或 0,1（双卡）",
		Related:        []string{"main_gpu", "split_mode", "tensor_split"},
	},
	"main_gpu": {
		Description:    "主 GPU 编号，负责小张量与临时缓冲（默认 0）。",
		Recommendation: "0",
		Related:        []string{"device", "split_mode"},
	},
	"split_mode": {
		Description:    "多卡张量拆分方式：none=不拆分、layer=按层、row=按行、tensor=按张量。多卡推理常用 layer。",
		Recommendation: "layer（多卡）或 none（单卡）",
		Related:        []string{"device", "tensor_split"},
	},
	"tensor_split": {
		Description:    "手动指定各 GPU 的权重分配比例，逗号分隔（如 0.5,0.5）。一般用 split-mode 即可，无需手动设置。",
		Recommendation: "通常留空，用 split_mode 替代",
		Related:        []string{"split_mode"},
	},
	"fit": {
		Description:    "自动适配显存：启动时按空闲显存自动调整上下文/层数等。开启后配合 fit-target/fit-ctx。",
		Recommendation: "一般不开启，用一键优化更精确",
		Related:        []string{"fit_target", "fit_ctx"},
	},
	"threads": {
		Description:    "计算线程数。0=自动（CPU 核心数）。CPU 推理可手动调大，但超过物理核数反而变慢。",
		Recommendation: "0（自动）或物理核心数（如 16）",
		Related:        []string{"threads_batch"},
	},
	"threads_batch": {
		Description:    "批处理阶段线程数。0=跟随 threads。调大可加速长 prompt 的首 token 生成。",
		Recommendation: "0（跟随）或与 threads 相同",
		Related:        []string{"threads"},
	},
	"ctx_size": {
		Description:    "上下文长度（token）。越大占用显存/内存越多。默认 4096；长对话或长文档可加大（如 8192/16384）。",
		Recommendation: "4096（标准）或 8192（长对话）或 16384（长文档）",
		Related:        []string{"n_gpu_layers", "cache_type_k", "cache_type_v"},
	},
	"batch_size": {
		Description:    "逻辑批大小。默认 2048。GPU 推理通常保持默认即可。",
		Recommendation: "2048（GPU）或 512（CPU/显存紧张）",
		Related:        []string{"ubatch_size"},
	},
	"ubatch_size": {
		Description:    "物理批大小（默认 512）。一般无需改动。",
		Recommendation: "512（默认）",
		Related:        []string{"batch_size"},
	},
	"flash_attn": {
		Description:    "Flash Attention 加速：on=强制开、off=关闭、auto=自动。开启可省显存并提速；量化 KV 缓存（非 f16）强烈建议保持 on。",
		Recommendation: "on（推荐）",
		Related:        []string{"cache_type_k", "cache_type_v"},
	},
	"cache_type_k": {
		Description:    "K 缓存数据类型。f32/f16/bf16=浮点（精度高）；q8_0/q4_0/q4_1/iq4_nl/q5_0/q5_1=量化（省显存，精度略降）。量化后建议开启 Flash Attention。默认 f16。",
		Recommendation: "f16（平衡）或 q8_0（省显存）",
		Related:        []string{"cache_type_v", "flash_attn"},
	},
	"cache_type_v": {
		Description:    "V 缓存数据类型，同 K 缓存。通常与 cache-type-k 保持一致。",
		Recommendation: "f16（平衡）或 q8_0（省显存）",
		Related:        []string{"cache_type_k", "flash_attn"},
	},
	"cpu_moe": {
		Description:    "MoE 模型的专家层驻留 CPU，节省显存（速度略降）。MoE 模型显存紧张时建议开启。",
		Recommendation: "MoE 模型且显存 < 16GB 时开启",
		Related:        []string{"n_cpu_moe"},
		Note:           "仅对 MoE 架构模型有效",
	},
	"n_cpu_moe": {
		Description:    "指定驻留 CPU 的 MoE 专家层数（0=自动/不指定）。",
		Recommendation: "0（自动）",
		Related:        []string{"cpu_moe"},
	},
	"fit_target": {
		Description:    "每块设备预留的空闲显存余量（如 1024MiB），配合 --fit 使用。",
		Recommendation: "1024（默认）",
		Related:        []string{"fit"},
	},
	"fit_ctx": {
		Description:    "--fit 模式下允许缩减到的最小上下文（0=不限制）。",
		Recommendation: "0（不限制）",
		Related:        []string{"fit"},
	},
	"check_tensors": {
		Description:    "启动时校验模型张量完整性，发现损坏时报错。排查模型文件是否损坏时开启。",
		Recommendation: "off（默认）",
		Related:        []string{},
	},
	"rope_scaling": {
		Description:    "RoPE 位置编码缩放方式：none=不缩放、linear=线性外推、yarn=YaRN（长上下文效果更好）。留空=自动（跟随模型元数据）。扩长上下文时优先选 yarn。",
		Recommendation: "yarn（长上下文）或 none（标准）",
		Related:        []string{"rope_scale", "yarn_orig_ctx"},
	},
	"rope_scale": {
		Description:    "RoPE 上下文缩放因子：填 N 表示把上下文扩展 N 倍（如 2 = 2 倍）。留空=自动（不额外缩放）。与 rope-scaling 搭配使用，填 yarn 时此值即外推倍数。",
		Recommendation: "2（2倍）或 4（4倍）",
		Related:        []string{"rope_scaling"},
	},
	"mmproj": {
		Description:    "多模态视觉投影文件（mmproj*.gguf）。留空=自动使用模型库中检测绑定的 mmproj；填写可手动覆盖为指定文件。",
		Recommendation: "留空（自动）",
		Related:        []string{"no_mmproj_offload", "mmproj_device"},
	},

	// ── 🧠 内存与加载 ───────────────────────────────────────
	"load_mode": {
		Description:    "模型加载模式。✅ 推荐：mmap（默认，启动快且省内存）。mlock=锁定到 RAM 防换页（模型被系统换出导致变慢时用，但会占满物理内存）；mmap+mlock=两者结合；dio=直接 IO；none=一次性读入（最慢）。内存特别紧张才考虑 none。",
		Recommendation: "mmap（默认）",
		Related:        []string{"no_host", "repack"},
	},
	"kv_offload": {
		Description:    "KV 缓存卸载到 GPU，加速长上下文。✅ 推荐：显存充足时开启，显存紧张保持关闭（默认关闭）。",
		Recommendation: "off（默认）或 on（显存充足）",
		Related:        []string{"n_gpu_layers", "ctx_size"},
	},
	"repack": {
		Description:    "权重重打包：启动时重排低效数据类型以提升算力利用率。✅ 推荐：CUDA 卡开启（略增启动时间）；纯 CPU 推理可关闭。",
		Recommendation: "on（CUDA）或 off（CPU）",
		Related:        []string{},
	},
	"no_host": {
		Description:    "绕过主机缓冲区。✅ 推荐：保持关闭（默认），一般不需要开启。",
		Recommendation: "off（默认）",
		Related:        []string{},
	},
	"numa": {
		Description:    "NUMA 策略（多路 CPU 服务器用）。✅ 推荐：留空/自动（不设置，普通单路/消费级机器）；多路 CPU 服务器用 distribute 把层均匀分布到各节点。注意：新版 llama.cpp 不接受 none 值，留空即不启用。",
		Recommendation: "留空（不启用）",
		Related:        []string{},
	},
	"op_offload": {
		Description:    "把张量运算（如归一化）也卸载到设备。✅ 推荐：保持关闭（默认），一般不需要开启。",
		Recommendation: "off（默认）",
		Related:        []string{},
	},
	"cache_ram": {
		Description:    "提示缓存（prompt cache）最大内存，单位 MiB。✅ 推荐：保持默认 8192；内存紧张可调小（如 2048）；0=禁用缓存。跨请求复用已处理 prompt 时可加速重复输入。",
		Recommendation: "8192（默认）或 2048（内存紧张）",
		Related:        []string{"cache_reuse", "cache_idle_slots"},
	},
	"ctx_checkpoints": {
		Description:    "每个槽位最多创建的上下文检查点数（长文本/投机解码回滚用）。✅ 推荐：保持默认 32，一般不需要改。",
		Recommendation: "32（默认）",
		Related:        []string{"checkpoint_min_step"},
	},
	"checkpoint_min_step": {
		Description:    "上下文检查点之间的最小间隔（token 数）。✅ 推荐：保持默认 8192；值越小检查点越密、回滚越精确但更耗内存。",
		Recommendation: "8192（默认）",
		Related:        []string{"ctx_checkpoints"},
	},
	"keep": {
		Description:    "保留初始 prompt 的前 N 个 token 不被上下文截断丢弃（长对话保护关键指令）。默认 0。",
		Recommendation: "0（不保留）或 48（保留系统提示）",
		Related:        []string{"ctx_size"},
	},
	"grp_attn_n": {
		Description:    "Grouped Attention 因子 n（0=模型默认）。配合 ctx-size 压长上下文内存。",
		Recommendation: "0（默认）",
		Related:        []string{"grp_attn_w", "ctx_size"},
	},
	"grp_attn_w": {
		Description:    "Grouped Attention 宽度 w（0=模型默认）。",
		Recommendation: "0（默认）",
		Related:        []string{"grp_attn_n"},
	},
	"kv_unified": {
		Description:    "统一 KV 缓冲：所有 slot 共享一块 KV 缓存，省内存。auto slots 时默认开启。",
		Recommendation: "on（省内存）",
		Related:        []string{"parallel", "cache_ram"},
	},
	"cache_idle_slots": {
		Description:    "新任务时将空闲 slot 存入提示缓存并清空，需开启 cache-ram。默认启用。",
		Recommendation: "on（默认）",
		Related:        []string{"cache_ram"},
	},
	"cache_reuse": {
		Description:    "通过 KV 移位复用提示缓存的最小块大小（0=禁用）。需开启提示缓存。",
		Recommendation: "0（禁用）或 256（启用）",
		Related:        []string{"cache_ram"},
	},
	"cache_prompt": {
		Description:    "提示缓存开关（默认启用）。关闭可省内存但重复 prompt 会重复计算。",
		Recommendation: "on（默认）",
		Related:        []string{"cache_ram"},
	},
	"context_shift": {
		Description:    "无限生成时上下文自动移位（超出 context 时丢弃旧 token）。长文本生成用。",
		Recommendation: "off（默认）或 on（长文本）",
		Related:        []string{"ctx_size"},
	},
	"swa_full": {
		Description:    "使用全尺寸滑动窗口注意力（SWA）缓存，替代自动缩减。长上下文更稳但更耗内存。",
		Recommendation: "off（默认）",
		Related:        []string{"ctx_size"},
	},
	"slot_save_path": {
		Description:    "槽位 KV 缓存保存目录（配合 /slots/{id}?action=save/restore API 实现会话持久化）。",
		Recommendation: "留空（不保存）",
		Related:        []string{},
	},

	// ── 🔧 CPU 与调度 ───────────────────────────────────────
	"cpu_mask": {
		Description:    "CPU 亲和掩码（如 0x3 绑定前两个核）。追求低延迟时可绑定特定核。留空=不绑定。",
		Recommendation: "留空（不绑定）",
		Related:        []string{"cpu_range", "cpu_strict"},
	},
	"cpu_range": {
		Description:    "CPU 亲和范围（如 0-3 或 4,5）。与 cpu-mask 二选一，写法更直观。",
		Recommendation: "留空（不绑定）",
		Related:        []string{"cpu_mask"},
	},
	"cpu_strict": {
		Description:    "严格 CPU 放置：未绑定范围内的线程报错而非降级。调试线程调度问题时用。",
		Recommendation: "off（默认）",
		Related:        []string{"cpu_mask", "cpu_range"},
	},
	"prio": {
		Description:    "进程优先级（-1~3，越高越优先）。实时性要求高时调高。",
		Recommendation: "0（默认）",
		Related:        []string{},
	},
	"poll": {
		Description:    "忙轮询级别（0-100），降低调度延迟但更耗电。默认 50。",
		Recommendation: "50（默认）",
		Related:        []string{},
	},
	"cpu_mask_batch": {
		Description:    "批处理阶段的 CPU 掩码（与 threads-batch 对应）。",
		Recommendation: "留空（跟随 cpu_mask）",
		Related:        []string{"cpu_mask", "threads_batch"},
	},
	"cpu_range_batch": {
		Description:    "批处理阶段的 CPU 范围。",
		Recommendation: "留空（跟随 cpu_range）",
		Related:        []string{"cpu_range"},
	},
	"prio_batch": {
		Description:    "批处理阶段的进程优先级。",
		Recommendation: "0（默认）",
		Related:        []string{"prio"},
	},
	"poll_batch": {
		Description:    "批处理阶段的忙轮询级别。",
		Recommendation: "50（默认）",
		Related:        []string{"poll"},
	},

	// ── 🎨 生成控制 ─────────────────────────────────────────
	"samplers": {
		Description:    "采样器链：按分号分隔依次执行，格式 `sampler1;sampler2;...`。每个采样器按顺序过滤/调整候选 token，最终从剩余候选中随机挑一个。llama.cpp 默认：penalties;dry;top_n_sigma;top_k;typ_p;top_p;min_p;xtc;temperature。调整方法：①只保留你需要的采样器；②越靠前优先级越高；③不需要的可从链中删掉。",
		Recommendation: "保持默认，除非你清楚每个采样器的作用",
		Related:        []string{"sampler_seq", "temperature", "top_p", "top_k"},
	},
	"sampler_seq": {
		Description:    "简化采样器序列（与采样器链二选一）：用单字符缩写描述采样顺序，如 `edskypmxt`（e=top-k、d=DRY、s=top-n-sigma、k=top-k、y=typ-p、p=top-p、m=min-p、x=XTC、t=温度）。填了它就不再需要写完整的采样器链。",
		Recommendation: "留空（用完整链）",
		Related:        []string{"samplers"},
	},
	"ignore_eos": {
		Description:    "忽略 EOS 结束符：模型不会因遇到结束 token 停止，会持续生成（等价于 --logit-bias EOS-inf）。用于强制长输出。",
		Recommendation: "off（默认）",
		Related:        []string{"predict"},
	},
	"temperature": {
		Description:    "温度（0-2）：越高输出越随机发散，越低越确定。创意写作可调 0.8-1.2；代码/事实类任务调 0.2-0.6。默认 0.8。",
		Recommendation: "0.8（创意）或 0.2（代码/事实）",
		Related:        []string{"top_p", "top_k"},
	},
	"top_k": {
		Description:    "Top-K：只从概率最高的前 K 个 token 中采样。40 是常用值；0=禁用（交给 top_p）。",
		Recommendation: "40（默认）",
		Related:        []string{"top_p"},
	},
	"top_p": {
		Description:    "Top-P（核采样）：从累积概率达到 P 的最小 token 集合中采样。0.95 常见；越低越保守。",
		Recommendation: "0.95（默认）或 0.9（更保守）",
		Related:        []string{"top_k"},
	},
	"min_p": {
		Description:    "Min-P：过滤掉概率低于“最高概率×P”的 token。0.05 常用；0=禁用。可与 top_k/top_p 叠加。",
		Recommendation: "0.05（默认）或 0（禁用）",
		Related:        []string{"top_p"},
	},
	"seed": {
		Description:    "随机种子：-1=每次随机；固定整数=结果可复现。调参对比时固定 seed 便于对照。",
		Recommendation: "-1（随机）或 42（固定）",
		Related:        []string{},
	},
	"predict": {
		Description:    "最多生成多少 token。默认 -1=不限制（直到结束符/上下文满）。防止无限生成时设置上限。",
		Recommendation: "-1（不限制）或 2048（上限）",
		Related:        []string{"ctx_size"},
	},
	"dry_multiplier": {
		Description:    "DRY 重复惩罚乘数（0=禁用）。惩罚重复序列，减少复读。配合 dry-base 使用。",
		Recommendation: "0（禁用）或 0.5-1.0",
		Related:        []string{"dry_base", "dry_allowed_length"},
	},
	"dry_base": {
		Description:    "DRY 惩罚基数（默认 1.75）。值越大对重复惩罚越强。",
		Recommendation: "1.75（默认）",
		Related:        []string{"dry_multiplier"},
	},
	"dry_allowed_length": {
		Description:    "DRY 允许的重复长度（默认 2）：低于此长度的重复不惩罚。",
		Recommendation: "2（默认）",
		Related:        []string{"dry_multiplier"},
	},
	"dry_penalty_last_n": {
		Description:    "DRY 回溯窗口（默认 -1=整个上下文）。只统计最近 N 个 token 的重复。",
		Recommendation: "-1（全部）",
		Related:        []string{"dry_multiplier"},
	},
	"xtc_probability": {
		Description:    "XTC 随机截断概率（0-1，0=禁用）：按概率移除概率最高的候选，强制探索次优 token，减少陈词滥调。",
		Recommendation: "0（禁用）或 0.1-0.3",
		Related:        []string{"xtc_threshold"},
	},
	"xtc_threshold": {
		Description:    "XTC 截断阈值（默认 0.1）：候选概率低于此值才参与截断。",
		Recommendation: "0.1（默认）",
		Related:        []string{"xtc_probability"},
	},
	"top_nsigma": {
		Description:    "Top-N-Sigma（默认 -1=禁用）：按标准差阈值过滤尾部候选，兼顾质量与多样性。",
		Recommendation: "-1（禁用）",
		Related:        []string{},
	},
	"adaptive_target": {
		Description:    "Adaptive-P 目标熵（0-1，0=禁用）：动态调整 top_p 使输出熵接近目标。",
		Recommendation: "0（禁用）",
		Related:        []string{"adaptive_decay"},
	},
	"adaptive_decay": {
		Description:    "Adaptive-P 衰减系数（0=禁用）：控制 top_p 调整速度。",
		Recommendation: "0（禁用）",
		Related:        []string{"adaptive_target"},
	},
	"typical": {
		Description:    "Locally Typical（1.0=禁用）：偏向“典型”的 token，抑制意外输出。",
		Recommendation: "1.0（禁用）",
		Related:        []string{},
	},
	"dynatemp_range": {
		Description:    "动态温度范围（0=禁用）：在 [temp-range, temp+range] 间按困惑度波动。",
		Recommendation: "0（禁用）",
		Related:        []string{"temperature", "dynatemp_exp"},
	},
	"dynatemp_exp": {
		Description:    "动态温度指数（默认 1.0）：调整波动曲线的敏感度。",
		Recommendation: "1.0（默认）",
		Related:        []string{"dynatemp_range"},
	},
	"mirostat": {
		Description:    "Mirostat 自适应采样（0=禁用、1/2=启用）：自动调整温度维持目标熵，输出更稳定。",
		Recommendation: "0（禁用）或 2（稳定）",
		Related:        []string{"mirostat_lr", "mirostat_ent"},
	},
	"mirostat_lr": {
		Description:    "Mirostat 学习率（默认 0.1）：越大调节越快但越抖。",
		Recommendation: "0.1（默认）",
		Related:        []string{"mirostat"},
	},
	"mirostat_ent": {
		Description:    "Mirostat 目标熵（默认 5.0）：越低输出越保守。",
		Recommendation: "5.0（默认）",
		Related:        []string{"mirostat"},
	},
	"grammar": {
		Description:    "BNF 文法约束：把输出限制为指定语法格式（如 JSON、代码）。适合结构化输出。",
		Recommendation: "留空（不约束）或 json",
		Related:        []string{"grammar_file", "json_schema"},
	},
	"grammar_file": {
		Description:    "从 .gbnf 文件读取文法规则（与 grammar 二选一）。",
		Recommendation: "留空（不约束）",
		Related:        []string{"grammar"},
	},
	"json_schema": {
		Description:    "JSON Schema 约束：直接贴 schema，让输出符合该 JSON 结构（比 grammar 更省事）。",
		Recommendation: "留空（不约束）",
		Related:        []string{"json_schema_file"},
	},
	"json_schema_file": {
		Description:    "从文件读取 JSON Schema（与 json_schema 二选一）。",
		Recommendation: "留空（不约束）",
		Related:        []string{"json_schema"},
	},
	"repeat_penalty": {
		Description:    "重复惩罚（≥1）：对已出现 token 的概率打折，抑制复读。1.0=禁用；1.1-1.3 常用。",
		Recommendation: "1.0（禁用）或 1.1-1.3",
		Related:        []string{"repeat_last_n"},
	},
	"repeat_last_n": {
		Description:    "重复惩罚回溯窗口：只看最近 N 个 token 的重复（默认 64）。",
		Recommendation: "64（默认）",
		Related:        []string{"repeat_penalty"},
	},
	"presence_penalty": {
		Description:    "存在惩罚（-2~2）：对出现过的 token 一律减去固定值，鼓励引入新话题。0=禁用。",
		Recommendation: "0（禁用）或 0.3-0.6",
		Related:        []string{"frequency_penalty"},
	},
	"frequency_penalty": {
		Description:    "频率惩罚（-2~2）：按出现次数递减概率，抑制高频词。0=禁用。",
		Recommendation: "0（禁用）或 0.3-0.6",
		Related:        []string{"presence_penalty"},
	},
	"logit_bias": {
		Description:    "Logit 偏置：直接调整指定 token 的得分，格式 `ID(+/-)BIAS`（如 42+3.0），逗号分隔多个。",
		Recommendation: "留空",
		Related:        []string{},
	},

	// ── 🧩 投机解码 ─────────────────────────────────────────
	"spec_type": {
		Description:    "投机解码类型：draft-simple=独立小草稿模型、draft-eagle3=EAGLE-3、draft-mtp=多 token 预测（主模型自带 MTP 头时直接用，如 Qwen3-MTP/Qwopus-MTP）、draft-dflash/draft-dspark=扩散式草稿、ngram-*=无模型 n-gram 草稿。用小模型或专用头预猜输出，大幅提速。",
		Recommendation: "draft-mtp（MTP 模型）或 draft-simple（外部草稿）",
		Related:        []string{"model_draft", "n_gpu_layers_draft"},
	},
	"model_draft": {
		Description:    "草稿模型路径（投机解码用）。选择一个小而快的模型。",
		Recommendation: "同目录下带 draft 的 GGUF 文件，或同架构小模型",
		Related:        []string{"spec_type"},
	},
	"n_gpu_layers_draft": {
		Description:    "草稿模型卸载到 GPU 的层数（默认 0=全 CPU）。草稿模型小，可全放 GPU 加速。",
		Recommendation: "全部层数（-1）或 0（CPU）",
		Related:        []string{"spec_type", "model_draft"},
	},
	"spec_draft_threads": {
		Description:    "草稿模型线程数（0=自动）。",
		Recommendation: "0（自动）",
		Related:        []string{"spec_type"},
	},
	"spec_draft_poll": {
		Description:    "草稿模型轮询模式（0/1，0=等待通知、1=轮询忙等）。CPU 草稿时偶尔能提速。",
		Recommendation: "0（默认）",
		Related:        []string{},
	},
	"spec_draft_cpu_mask_batch": {
		Description:    "草稿模型批处理阶段的 CPU 亲和掩码（默认跟随草稿掩码）。",
		Recommendation: "留空（跟随）",
		Related:        []string{"spec_draft_cpu_mask"},
	},
	"spec_draft_prio_batch": {
		Description:    "草稿模型批处理阶段优先级（-1..3）。",
		Recommendation: "0（默认）",
		Related:        []string{"spec_draft_prio"},
	},
	"spec_draft_poll_batch": {
		Description:    "草稿模型批处理阶段轮询（0/1，默认跟随 --spec-draft-poll）。",
		Recommendation: "0（跟随）",
		Related:        []string{"spec_draft_poll"},
	},
	"spec_draft_cpu_mask": {
		Description:    "草稿模型 CPU 亲和掩码。",
		Recommendation: "留空（不绑定）",
		Related:        []string{"spec_draft_cpu_mask_batch"},
	},
	"spec_draft_prio": {
		Description:    "草稿模型进程优先级（-1~3）。",
		Recommendation: "0（默认）",
		Related:        []string{"spec_draft_prio_batch"},
	},
	"spec_draft_device": {
		Description:    "草稿模型使用的 GPU 设备。",
		Recommendation: "留空（自动）",
		Related:        []string{"spec_type"},
	},
	"spec_draft_cache_type_k": {
		Description:    "草稿模型 K 缓存类型（默认 f16）。",
		Recommendation: "f16（默认）",
		Related:        []string{"spec_draft_cache_type_v"},
	},
	"spec_draft_cache_type_v": {
		Description:    "草稿模型 V 缓存类型（默认 f16）。",
		Recommendation: "f16（默认）",
		Related:        []string{"spec_draft_cache_type_k"},
	},
	"spec_draft_n_max": {
		Description:    "草稿最多预生成几个 token（默认 3）。越大加速越多但验证开销也大。",
		Recommendation: "3（默认）或 5",
		Related:        []string{"spec_draft_n_min"},
	},
	"spec_draft_n_min": {
		Description:    "草稿最少接受几个 token（默认 0）。",
		Recommendation: "0（默认）",
		Related:        []string{"spec_draft_n_max"},
	},
	"spec_draft_p_split": {
		Description:    "分裂概率（默认 0.1）：把部分计算分给目标模型，减少草稿错误。",
		Recommendation: "0.1（默认）",
		Related:        []string{},
	},
	"spec_draft_p_min": {
		Description:    "草稿最小接受概率（默认 0）。",
		Recommendation: "0（默认）",
		Related:        []string{},
	},
	"spec_ngram_mod_n_min": {
		Description:    "ngram-mod 的 n 最小（默认 0）。",
		Recommendation: "0（默认）",
		Related:        []string{"spec_ngram_mod_n_max"},
	},
	"spec_ngram_mod_n_max": {
		Description:    "ngram-mod 的 n 最大（默认 4）。",
		Recommendation: "4（默认）",
		Related:        []string{"spec_ngram_mod_n_min"},
	},
	"spec_ngram_simple_size_n": {
		Description:    "ngram-simple 的 n-gram 长度（默认 4）。",
		Recommendation: "4（默认）",
		Related:        []string{"spec_ngram_simple_size_m"},
	},
	"lookup_cache_static": {
		Description:    "静态查找缓存文件（lookup 解码用，生成时不更新）。配合 --spec-type ngram-cache。",
		Recommendation: "留空",
		Related:        []string{"lookup_cache_dynamic"},
	},
	"lookup_cache_dynamic": {
		Description:    "动态查找缓存文件（lookup 解码用，生成时持续更新）。配合 --spec-type ngram-cache。",
		Recommendation: "留空",
		Related:        []string{"lookup_cache_static"},
	},
	"spec_ngram_simple_size_m": {
		Description:    "ngram-simple 的查询长度（默认 4）。",
		Recommendation: "4（默认）",
		Related:        []string{"spec_ngram_simple_size_n"},
	},

	// ── 📥 模型来源 ─────────────────────────────────────────
	"hf_repo": {
		Description:    "从 HuggingFace 拉取模型：填仓库 ID（如 ggml-org/llama-3.2-1B-GGUF）。",
		Recommendation: "例如 ggml-org/Qwen2.5-7B-Instruct-GGUF",
		Related:        []string{"hf_file", "hf_token"},
	},
	"hf_file": {
		Description:    "HF 仓库内指定文件名（默认自动选最优量化）。",
		Recommendation: "留空（自动）",
		Related:        []string{"hf_repo"},
	},
	"hf_token": {
		Description:    "HF 访问令牌（私有/需授权仓库必填）。",
		Recommendation: "留空（公开模型）",
		Related:        []string{"hf_repo"},
	},
	"model_url": {
		Description:    "直接给模型下载 URL（HTTP 直链）。",
		Recommendation: "留空",
		Related:        []string{"hf_repo"},
	},
	"docker_repo": {
		Description:    "Docker 镜像仓库（容器部署场景）。",
		Recommendation: "留空",
		Related:        []string{},
	},
	"no_mmproj": {
		Description:    "禁用 mmproj 的自动下载（多模态场景不需要视觉时勾选）。",
		Recommendation: "off（默认）",
		Related:        []string{"mmproj"},
	},
	"offline": {
		Description:    "强制使用本地缓存，不联网。",
		Recommendation: "off（默认）",
		Related:        []string{"hf_repo"},
	},

	// ── 🌐 网络与安全 ───────────────────────────────────────
	"ssl_key_file": {
		Description:    "HTTPS 私钥文件路径（配合 ssl-cert-file 启用 HTTPS）。",
		Recommendation: "留空（HTTP）",
		Related:        []string{"ssl_cert_file"},
	},
	"ssl_cert_file": {
		Description:    "HTTPS 证书文件路径。启用后服务走 HTTPS。",
		Recommendation: "留空（HTTP）",
		Related:        []string{"ssl_key_file"},
	},
	"cors_origins": {
		Description:    "允许的跨域来源（逗号分隔，如 https://app.example.com）。网页前端跨域调用时设置。",
		Recommendation: "留空（不限制）或 *",
		Related:        []string{"cors_methods", "cors_headers"},
	},
	"cors_methods": {
		Description:    "允许的跨域方法（默认 GET,POST）。",
		Recommendation: "GET,POST（默认）",
		Related:        []string{"cors_origins"},
	},
	"timeout": {
		Description:    "HTTP 读写超时秒数（默认 3600）。长生成任务可调大。",
		Recommendation: "3600（默认）或 7200（长任务）",
		Related:        []string{},
	},
	"threads_http": {
		Description:    "处理 HTTP 请求的线程数。-1=自动。并发请求多时调大可降低排队延迟；一般保持自动。",
		Recommendation: "-1（自动）",
		Related:        []string{"parallel"},
	},

	// ── 🧩 模板与推理 ───────────────────────────────────────
	"jinja": {
		Description:    "强制使用 Jinja 对话模板引擎（部分新模型需要）。默认自动。",
		Recommendation: "off（默认）",
		Related:        []string{"chat_template"},
	},
	"chat_template": {
		Description:    "对话模板（可自由填任意内置模板名）：llama2/llama3/llama4/qwen/chatml/mistral/chatglm3/chatglm4/deepseek/deepseek2/deepseek3/command-r/falcon3/gemma/granite-4.1/grok-2/hunyuan-vl/kimi-k2/exaone4/gpt-oss 等。留空=自动从模型元数据读取。模板不匹配会乱码/角色混乱。",
		Recommendation: "留空（自动）或 qwen/llama3/deepseek",
		Related:        []string{"jinja", "chat_template_file"},
	},
	"chat_template_file": {
		Description:    "从文件加载自定义对话模板（Jinja2）。",
		Recommendation: "留空",
		Related:        []string{"chat_template"},
	},
	"reasoning": {
		Description:    "思维链（推理）控制：on=强制开启、off=关闭、auto=跟随模型。推理模型建议 auto/on。",
		Recommendation: "auto（默认）",
		Related:        []string{"reasoning_effort", "reasoning_format"},
	},
	"reasoning_format": {
		Description:    "思维链输出格式：auto/thought/deepseek/qwen。默认 auto 跟随模型。",
		Recommendation: "auto（默认）",
		Related:        []string{"reasoning"},
	},
	"reasoning_effort": {
		Description:    "推理努力级别（low/medium/high）：越高思考越久、答案越好但更慢。",
		Recommendation: "medium（平衡）或 high（质量）",
		Related:        []string{"reasoning"},
	},
	"reasoning_budget": {
		Description:    "思维链 token 预算（0=不限制）。限制思考长度用。",
		Recommendation: "0（不限制）或 2048",
		Related:        []string{"reasoning"},
	},

	// ── 📝 日志与调试 ───────────────────────────────────────
	"log_file": {
		Description:    "把日志写入文件（便于排查）。",
		Recommendation: "留空（输出到控制台）",
		Related:        []string{},
	},
	"log_colors": {
		Description:    "日志着色：auto=自动（输出到终端才着色）、on=强制开、off=关闭。",
		Recommendation: "auto（默认）",
		Related:        []string{},
	},
	"log_verbosity": {
		Description:    "日志详细度（默认 3）：0=常规、1=错误、2=警告、3=信息、4=跟踪、5=调试。排查问题时可临时调高。",
		Recommendation: "3（信息）或 4（调试）",
		Related:        []string{},
	},
	"log_prefix": {
		Description:    "日志带来源前缀。",
		Recommendation: "off（默认）",
		Related:        []string{},
	},
	"log_timestamps": {
		Description:    "日志带时间戳。",
		Recommendation: "off（默认）",
		Related:        []string{},
	},
	"log_disable": {
		Description:    "完全禁用日志输出。",
		Recommendation: "off（默认）",
		Related:        []string{},
	},
	"perf": {
		Description:    "输出内部性能计时（各阶段耗时）。调优时开启观察瓶颈。",
		Recommendation: "off（默认）",
		Related:        []string{},
	},
	"escape": {
		Description:    "在模型输出中启用转义序列，如将 \\n 渲染为换行、\\t 渲染为制表符。默认关闭（按原样输出反斜杠）。",
		Recommendation: "off（默认）",
		Related:        []string{},
	},
	"reverse_prompt": {
		Description:    "反向提示词：生成到该内容时结束/切换（多轮交互）。",
		Recommendation: "留空",
		Related:        []string{},
	},
	"special": {
		Description:    "输出特殊 token（如 <s>、</s>）。调试分词用。",
		Recommendation: "off（默认）",
		Related:        []string{},
	},
	"warmup": {
		Description:    "启动预热：加载后先跑一次小推理以初始化（默认启用）。",
		Recommendation: "on（默认）",
		Related:        []string{},
	},
	"spm_infill": {
		Description:    "SPM（SentencePiece）填充模式，用于代码补全。",
		Recommendation: "off（默认）",
		Related:        []string{},
	},
	"sleep_idle_seconds": {
		Description:    "空闲 N 秒后休眠（-1=禁用）。省电场景用。",
		Recommendation: "-1（禁用）",
		Related:        []string{},
	},
	"log_prompts_dir": {
		Description:    "把每个请求的 prompt 写入该目录（调试/审计）。",
		Recommendation: "留空（不记录）",
		Related:        []string{},
	},

	// ── 新增参数（registry 中已存在但 guidance 新补充） ────
	"parallel": {
		Description:    "并行槽位（并发客户端数）。-1=自动（默认约 4 槽 + 统一 KV）。多客户端同时请求时设为需要的并发数。✅ 推荐：-1 自动。",
		Recommendation: "-1（自动）",
		Related:        []string{"kv_unified", "cont_batching"},
	},
	"cont_batching": {
		Description:    "连续/动态批处理：请求到达即处理，无需等待整批。✅ 推荐：默认已启用，一般无需设置。",
		Recommendation: "on（默认）",
		Related:        []string{"parallel"},
	},
	"slot_prompt_similarity": {
		Description:    "slot 复用所需的提示词相似度阈值（0-1）。值越高越严格，相同前缀才能复用。默认 0.10。",
		Recommendation: "0.10（默认）",
		Related:        []string{"parallel"},
	},
	"rope_freq_base": {
		Description:    "RoPE 基础频率（0=跟随模型）。调低可扩展长上下文，一般由模型决定。",
		Recommendation: "0（跟随模型）",
		Related:        []string{"rope_scaling"},
	},
	"yarn_orig_ctx": {
		Description:    "YaRN 原始上下文长度（模型训练时的上下文，如 4096）。扩长上下文时填写。",
		Recommendation: "模型原生上下文（如 4096）",
		Related:        []string{"rope_scaling", "rope_scale"},
	},
	"yarn_ext_factor": {
		Description:    "YaRN 外推混合因子（负值=跟随模型）。通常用 rope-scaling=yarn + 该值。",
		Recommendation: "-1（跟随模型）",
		Related:        []string{"rope_scaling"},
	},
	"yarn_attn_factor": {
		Description:    "YaRN 注意力幅度因子（负值=跟随模型）。",
		Recommendation: "-1（跟随模型）",
		Related:        []string{"rope_scaling"},
	},
	"yarn_beta_fast": {
		Description:    "YaRN 快速端校正维度（负值=跟随模型）。",
		Recommendation: "-1（跟随模型）",
		Related:        []string{"rope_scaling"},
	},
	"yarn_beta_slow": {
		Description:    "YaRN 慢速端校正维度（负值=跟随模型）。",
		Recommendation: "-1（跟随模型）",
		Related:        []string{"rope_scaling"},
	},
	"mmproj_url": {
		Description:    "多模态投影文件下载 URL（配合 -hf 自动下载 mmproj）。",
		Recommendation: "留空（自动）",
		Related:        []string{"mmproj"},
	},
	"mmproj_device": {
		Description:    "mmproj 多模态模型使用的设备（auto=自动，或指定 GPU 编号）。",
		Recommendation: "auto（自动）",
		Related:        []string{"mmproj"},
	},
	"no_mmproj_offload": {
		Description:    "让视觉投影（mmproj）在 CPU 上运行以节省显存，把显存让给主模型层（提升生成速度）。纯文本场景推荐勾选；纯多模态高频编码场景不建议。",
		Recommendation: "纯文本场景勾选，多模态场景不勾选",
		Related:        []string{"mmproj", "n_gpu_layers"},
	},
	"image_min_tokens": {
		Description:    "图像输入动态分辨率的最小 token 数（0=读模型默认）。Qwen-VL 等建议 ≥1024。",
		Recommendation: "0（跟随模型）或 1024",
		Related:        []string{"image_max_tokens"},
	},
	"image_max_tokens": {
		Description:    "图像输入动态分辨率的最大 token 数（0=读模型默认）。",
		Recommendation: "0（跟随模型）",
		Related:        []string{"image_min_tokens"},
	},
	"mtmd_batch_max_tokens": {
		Description:    "多模态图像编码的单批最大 token 数（默认 1024）。",
		Recommendation: "1024（默认）",
		Related:        []string{},
	},
	"embedding": {
		Description:    "嵌入模式：加载专用嵌入模型后仅提供 /v1/embeddings（不生成文本）。RAG/检索场景用。",
		Recommendation: "off（默认）",
		Related:        []string{"pooling", "embd_normalize"},
	},
	"pooling": {
		Description:    "嵌入池化方式：mean=平均、cls=首 token、last=末 token、rank=排序得分。留空=跟随模型。",
		Recommendation: "留空（跟随模型）",
		Related:        []string{"embedding"},
	},
	"embd_normalize": {
		Description:    "嵌入向量归一化（-1=不归一化，0=最大绝对值 int16，1=taxicab，2=欧氏，>2=p-范数）。默认 2。",
		Recommendation: "2（默认）",
		Related:        []string{"embedding"},
	},
	"rerank": {
		Description:    "重排模式：启用 /v1/rerank 端点，用交叉编码器对文档重排。配 rerank 模型用。",
		Recommendation: "off（默认）",
		Related:        []string{},
	},
	"embd_output_format": {
		Description:    "嵌入输出格式（默认空=旧格式）：array=[[],[]...]、json=OpenAI 风格、json+=json+余弦相似度矩阵、raw=纯文本一行一个向量。",
		Recommendation: "留空（旧格式）",
		Related:        []string{"embedding"},
	},
	"embd_separator": {
		Description:    "嵌入向量分隔符（默认换行）。如 \"<#sep#>\"。",
		Recommendation: "留空（换行）",
		Related:        []string{"embedding"},
	},
	"cls_separator": {
		Description:    "分类序列分隔符（默认 Tab）。用于分类任务的序列切分。",
		Recommendation: "留空（Tab）",
		Related:        []string{},
	}, // ── 2026-09-01 新增参数 ───────────────────────────────
	"n_cpu_ffn": {
		Description:    "保留前 N 层的稠密 FFN 权重在 CPU（默认 0=全部 GPU）。显存紧张时把部分 FFN 留在 CPU，用少量性能换显存。",
		Recommendation: "0（全部 GPU）；显存不足可试 16 或 32",
		Related:        []string{"n_gpu_layers"},
	},
	"mmproj_auto": {
		Description:    "自动下载/匹配与主模型配套的多模态投影器（mmproj）。默认关闭；视觉模型可开启。",
		Recommendation: "off（手动指定 mmproj）",
		Related:        []string{"mmproj", "mmproj_url"},
	},
	"tensor_read_lazy": {
		Description:    "惰性读取张量（按需按层读取，如仅嵌入层）。模式：auto=自动、all=全部张量惰性、off=关闭。可降低加载峰值内存。",
		Recommendation: "留空（默认关闭）",
		Related:        []string{"load_mode"},
	},
	"video_fps": {
		Description:    "视频输入的目标帧率（默认 4.0）。帧率越高显存占用越大，越低越省。",
		Recommendation: "4.0（默认）",
		Related:        []string{"video_timestamp_interval"},
	},
	"video_timestamp_interval": {
		Description:    "视频文本时间戳间隔（毫秒，默认 5000）。",
		Recommendation: "5000（默认）",
		Related:        []string{"video_fps"},
	},
	"video_ffmpeg_dir": {
		Description:    "ffmpeg/ffprobe 所在目录。用于视频解码；留空自动在 PATH 中查找。",
		Recommendation: "留空（自动查找）",
		Related:        []string{},
	},
	"kv_unified_per_slot": {
		Description:    "统一 KV 缓冲时每个槽位的上下文上限（默认不设置=全部共享）。多槽位并行时限制单槽占用量。",
		Recommendation: "留空（共享全部）",
		Related:        []string{"kv_unified", "parallel"},
	},
	"dry_sequence_breaker": {
		Description:    "DRY 采样器的序列断路器字符串（覆盖默认断句）。用于防止特定重复模式。",
		Recommendation: "留空（用默认断路器）",
		Related:        []string{"dry_multiplier"},
	},
	"backend_sampling": {
		Description:    "后端采样（实验性）：把采样移交给后端（GPU）执行，绕过 CPU。个别模型/后端可用。",
		Recommendation: "off（默认，实验功能）",
		Related:        []string{"spec_draft_backend_sampling"},
	},
	"control_vector": {
		Description:    "控制向量文件路径。加载后按向量方向调整生成（如风格/情感控制）。",
		Recommendation: "留空（不启用）",
		Related:        []string{"control_vector_scaled", "control_vector_layer_range"},
	},
	"control_vector_layer_range": {
		Description:    "控制向量生效的层范围（起始层 结束层，空格分隔）。留空=全部层。",
		Recommendation: "留空（全部层）",
		Related:        []string{"control_vector"},
	},
	"lora_scaled": {
		Description:    "LoRA 适配器带缩放，格式 `lora.gguf:1.0`，多个逗号分隔。可逐适配器调权重。",
		Recommendation: "留空（用 --lora 即可）",
		Related:        []string{"lora"},
	},
	"spec_draft_threads_batch": {
		Description:    "草稿模型批处理阶段的线程数（默认 0=跟随草稿线程）。MTP/外部草稿吞吐不足时可调。",
		Recommendation: "0（跟随草稿线程）",
		Related:        []string{"spec_draft_threads"},
	},
	"spec_synth_len": {
		Description:    "投机解码合成序列的目标平均接受长度（含目标 token）。0=禁用合成（默认）；调高可提升小模型投机吞吐。",
		Recommendation: "0（禁用）；小模型可试 2-3",
		Related:        []string{"spec_synth_rates"},
	},
	"spec_synth_rates": {
		Description:    "合成序列的无条件逐位置接受率，逗号分隔（长度 = spec-synth-len+1）。配合合成投机使用。",
		Recommendation: "留空（用默认率）",
		Related:        []string{"spec_synth_len"},
	},
	"log_verbose": {
		Description:    "全量日志（-v）：输出所有消息（等价于 log-verbosity=无穷）。调试时开启。",
		Recommendation: "off（默认）",
		Related:        []string{"log_verbosity"},
	},
	// ── 提示缓存 ─────────────────────────────
	"no_cache_prompt": {
		Description:    "禁用提示词缓存（--no-cache-prompt）。默认是开启的：服务器缓存每个提示的计算结果，重复/相似请求秒回，连续多轮对话明显加速。勾选后每次请求都重新计算全部提示，内存占用降低但速度变慢。一般不建议启用，除非排查缓存导致的结果异常。",
		Recommendation: "保持不勾选（=开启缓存，加速重复请求）",
		Related:        []string{"cache_prompt", "cache_reuse"},
	},
	// ── 投机解码（无模型 / 草稿细节）──────────
	"spec_default": {
		Description:    "启用默认投机解码配置（--spec-default），自动套用内置的草稿/投机参数组合，无需手动填写 ngram 或草稿细节。适合不想深究投机参数、但想获得加速的用户。",
		Recommendation: "想省心加速可勾选；精细调参则留空手动设置",
		Related:        []string{"spec_type", "model_draft"},
	},
	"spec_draft_backend_sampling": {
		Description:    "让草稿模型用后端采样器（与主模型相同的采样链）生成草稿 token，而不是固定贪心采样。启用后草稿更贴近真实输出分布、主模型接受率更高，但草稿生成稍慢。",
		Recommendation: "草稿接受率偏低时可勾选尝试",
		Related:        []string{"spec_draft_threads", "backend_sampling"},
	},
	"spec_draft_override_tensor": {
		Description:    "覆盖草稿模型中的指定张量为新值，格式 `NAME=value`，多个逗号分隔。用于替换/微调草稿头中的张量（如强制使用某一层），属高级调试用途，正常不需要。",
		Recommendation: "默认留空；仅高级调试时使用",
		Related:        []string{"override_tensor"},
	},
	"spec_draft_cpu_moe": {
		Description:    "把草稿模型的 MoE 专家层放到 CPU 计算（--spec-draft-cpu-moe），为 GPU 腾出显存给主模型。启用后草稿推理变慢但显存占用下降，适合显存紧张且草稿是 MoE 模型时。",
		Recommendation: "显存不足且草稿是 MoE 时勾选",
		Related:        []string{"spec_draft_n_cpu_moe", "cpu_moe"},
	},
	"spec_draft_n_cpu_moe": {
		Description:    "指定草稿模型有多少层 MoE 专家放到 CPU（--n-cpu-moe-draft），配合「草稿 MoE 留 CPU」精确控制 CPU 承担的计算量。调大省显存、调小提速。",
		Recommendation: "默认 0；配合草稿 MoE 留 CPU 一起调层数",
		Related:        []string{"spec_draft_cpu_moe"},
	},
	"spec_draft_hf": {
		Description:    "从 HuggingFace 直接加载草稿模型（--hf-repo-draft），格式 `owner/repo`。无需本地下载草稿文件，首次启动自动下载，适合本地没有合适草稿时使用。",
		Recommendation: "填 HF 仓库名，如 `Qwen/Qwen2.5-0.5B`",
		Related:        []string{"hf_repo", "model_draft"},
	},
	"spec_ngram_mod_n_match": {
		Description:    "ngram-mod 无模型投机：从已生成文本中查找重复的 n-gram 来预测下一个 token，完全不需要草稿模型。此参数设匹配的 n-gram 长度（默认 24）。越长越精确但命中越少，越短越积极但误预测多。适合低延迟、不想加载草稿模型的场景。",
		Recommendation: "默认 24；命中少可调小，误预测多可调大",
		Related:        []string{"spec_type", "spec_ngram_simple_min_hits"},
	},
	"spec_ngram_simple_min_hits": {
		Description:    "ngram-simple 无模型投机的最少命中次数（默认 1）。已生成文本中某 n-gram 被命中的次数达到该值才作为草稿候选。调大减少误预测、接受率降低；调小更积极、加速更明显。",
		Recommendation: "默认 1；保守可调 2-3",
		Related:        []string{"spec_ngram_mod_n_match"},
	},
	"spec_ngram_map_k_size_n": {
		Description:    "ngram-map-k 无模型投机：记录已生成文本的 n 元组（大小为 n）到后续 token 的映射表。n 控制匹配粒度，调大更精确、占用略增。",
		Recommendation: "默认 12",
		Related:        []string{"spec_ngram_map_k_size_m", "spec_ngram_map_k_min_hits"},
	},
	"spec_ngram_map_k_size_m": {
		Description:    "ngram-map-k 无模型投机：一次投机能预测的最长后续序列长度（默认 48）。调大 m 可投机更长序列、加速更明显，但映射表占用更多内存。",
		Recommendation: "默认 48",
		Related:        []string{"spec_ngram_map_k_size_n"},
	},
	"spec_ngram_map_k_min_hits": {
		Description:    "ngram-map-k 无模型投机的最少命中次数（默认 1）。命中达到该值才作为草稿候选。调大减少误预测、调小更积极。",
		Recommendation: "默认 1",
		Related:        []string{"spec_ngram_map_k_size_n"},
	},
	"spec_ngram_map_k4v_size_n": {
		Description:    "ngram-map-k4v 无模型投机（比 map-k 更省显存的键值结构变体）的 n 元组大小（默认 12）。控制匹配粒度。",
		Recommendation: "默认 12",
		Related:        []string{"spec_ngram_map_k4v_size_m", "spec_ngram_map_k4v_min_hits"},
	},
	"spec_ngram_map_k4v_size_m": {
		Description:    "ngram-map-k4v 无模型投机一次预测的最长序列长度（默认 48）。调大投机更长、占用略增。",
		Recommendation: "默认 48",
		Related:        []string{"spec_ngram_map_k4v_size_n"},
	},
	"spec_ngram_map_k4v_min_hits": {
		Description:    "ngram-map-k4v 无模型投机的最少命中次数（默认 1）。命中达到才作为候选。",
		Recommendation: "默认 1",
		Related:        []string{"spec_ngram_map_k4v_size_n"},
	},
	// ── LoRA / 控制向量 ─────────────────────
	"lora": {
		Description:    "加载 LoRA 适配器（--lora），格式 `lora.gguf` 或 `lora.gguf:权重`，多个逗号分隔。LoRA 是小体积的微调补丁，可在基础模型上叠加特定风格/能力（如代码、角色扮演），不修改原模型文件。",
		Recommendation: "填 LoRA 文件路径；多个用逗号分隔",
		Related:        []string{"lora_scaled", "lora_init_without_apply"},
	},
	"lora_init_without_apply": {
		Description:    "只加载 LoRA 张量但不应用到模型（--lora-init-without-apply）。用于预热/测试 LoRA 能否加载，或配合后续手动应用。正常使用不需要启用。",
		Recommendation: "一般保持关闭",
		Related:        []string{"lora"},
	},
	"control_vector_scaled": {
		Description:    "加载控制向量并带缩放系数（--control-vector-scaled），格式 `vector.gguf:缩放值`。控制向量在推理时沿特定方向调整输出特征（如情绪、语气、风格偏移），缩放值控制强度。",
		Recommendation: "填向量文件:缩放值，如 `happy.gguf:1.0`",
		Related:        []string{"control_vector", "control_vector_layer_range"},
	},
	// ── 张量 / 元数据覆盖 ───────────────────
	"override_tensor": {
		Description:    "覆盖模型张量的缓冲类型（--override-tensor），格式 `NAME=type`，如 `blk.0.attn_q.weight=Q8_0`。用于强制某些张量用更低/更高精度以省显存或提精度，属高级优化。",
		Recommendation: "默认留空；显存优化时针对最大张量量化",
		Related:        []string{"override_kv"},
	},
	"override_kv": {
		Description:    "覆盖模型元数据中的键值（--override-kv），格式 `key=value`，多个逗号分隔。用于修正 GGUF 元数据（如 context_length、rope 参数）错误或实验性调整，正常情况不需要。",
		Recommendation: "默认留空",
		Related:        []string{"override_tensor"},
	},
	// ── 多模型 ──────────────────────────────
	"models_dir": {
		Description:    "多模型自动加载的搜索目录（--models-dir）。启用多模型功能后，服务器自动在该目录发现并加载多个模型，按请求切换模型，无需手动重启实例。",
		Recommendation: "填存放多个模型的目录路径",
		Related:        []string{"models_autoload", "models_max"},
	},
	"models_preset": {
		Description:    "多模型自动加载的预设配置文件（--models-preset）。通过 JSON 预设定义多个模型及其别名/参数，启动后按预设统一管理模型集合。",
		Recommendation: "填预设 JSON 文件路径",
		Related:        []string{"models_dir"},
	},
	"models_max": {
		Description:    "多模型自动加载模式下同时最多加载的模型数量（默认 4）。限制显存占用，避免一次加载过多模型导致 OOM。",
		Recommendation: "按显存设置，默认 4",
		Related:        []string{"models_dir"},
	},
	"models_autoload": {
		Description:    "启用多模型自动加载（--models-autoload，默认开）。服务器自动从 models-dir 加载模型并按需切换，不同请求路由到不同模型。",
		Recommendation: "需要多模型切换时保持开启",
		Related:        []string{"models_dir", "models_max"},
	},
	"no_models_autoload": {
		Description:    "禁用多模型自动加载（--no-models-autoload）。关闭后服务器只加载主模型，不自动调度其他模型，显存更可控但无法按请求切换模型。",
		Recommendation: "单模型场景可勾选省资源",
		Related:        []string{"models_autoload"},
	},
	// ── 指标 / 运行接口 ─────────────────────
	"metrics": {
		Description:    "开启 Prometheus 指标端点（--metrics）。启用后在 /metrics 暴露标准指标（token 速率、GPU 利用率、KV 缓存占用等），供 Prometheus/监控面板采集。本 launcher 默认自动开启。",
		Recommendation: "保持开启，供监控面板采集",
		Related:        []string{"props", "slots"},
	},
	"props": {
		Description:    "开启运行时属性修改接口（--props），允许在运行中通过 API 动态修改某些属性（如采样参数），无需重启实例。适合需要在线调参的场景。",
		Recommendation: "需要在线调参时开启",
		Related:        []string{"metrics"},
	},
	"sse_ping_interval": {
		Description:    "SSE 流式响应的心跳间隔秒数（默认 30）。流式输出时定期发送 ping 保持连接，防止代理/防火墙把空闲连接断开。调小更稳但产生更多空消息。",
		Recommendation: "代理频繁断流可调小到 5-10",
		Related:        []string{"timeout"},
	},
	// ── API / CORS ─────────────────────────
	"api_prefix": {
		Description:    "为 OpenAI 兼容 API 增加统一前缀路径（--api-prefix）。所有 /v1/* 接口变为 /前缀/v1/*，用于网关路由或同一端口多实例隔离。",
		Recommendation: "默认留空；网关场景填前缀",
		Related:        []string{"host", "port"},
	},
	"reuse_port": {
		Description:    "启用 SO_REUSEPORT 端口复用（--reuse-port），允许同一端口绑定多个进程做负载均衡（需操作系统支持）。一般单实例不需要。",
		Recommendation: "默认关闭",
		Related:        []string{"port"},
	},
	"cors_headers": {
		Description:    "CORS 允许的请求头列表（默认 * 全部），逗号分隔。控制浏览器跨域访问 API 时允许携带哪些请求头。",
		Recommendation: "默认 *；受限时按需列出",
		Related:        []string{"cors_credentials"},
	},
	"cors_credentials": {
		Description:    "允许 CORS 请求携带凭据（--cors-credentials，如 Cookie/Authorization）。配合浏览器跨域调用 API 时携带身份凭证使用。",
		Recommendation: "浏览器跨域带凭据时勾选",
		Related:        []string{"cors_headers", "api_key"},
	},
	// ── Web UI / 静态资源 ───────────────────
	"no_webui": {
		Description:    "禁用 llama.cpp 内置的 Web 聊天界面（--no-webui）。本 launcher 已自带界面，禁用内置 UI 可减少资源占用，也避免端口冲突。",
		Recommendation: "用 launcher 界面时可勾选",
		Related:        []string{"path"},
	},
	"ui_config": {
		Description:    "为 llama.cpp 内置 Web UI 提供默认配置 JSON（--ui-config），如默认模型、主题等。仅影响内置 UI，本 launcher 界面不受影响。",
		Recommendation: "默认留空",
		Related:        []string{"path", "no_webui"},
	},
	"slots": {
		Description:    "开启槽位（slots）监控端点（--slots，默认开）。暴露 /slots 接口查看每个并发槽位的状态（占用、token 数、进度），供监控/调试。",
		Recommendation: "保持默认开启",
		Related:        []string{"parallel", "metrics"},
	},
	"no_slots": {
		Description:    "禁用槽位监控端点（--no-slots）。关闭 /slots 接口，减少极少量开销。一般不需要。",
		Recommendation: "默认关闭",
		Related:        []string{"slots"},
	},
	"path": {
		Description:    "内置 Web UI 的静态文件目录（--path）。指定 llama.cpp 内置 UI 从该目录读取页面资源，用于自定义界面。",
		Recommendation: "默认留空（用内置）",
		Related:        []string{"no_webui"},
	},
	"media_path": {
		Description:    "内置 Web UI 的媒体文件目录（--media-path），存放上传的图片/音频等文件。",
		Recommendation: "默认留空",
		Related:        []string{"path"},
	},
	// ── 模型标识 / 工具 / Agent ─────────────
	"alias": {
		Description:    "给模型设置别名（--alias，可多个逗号分隔）。OpenAI API 的 /v1/models 会列出别名，客户端可用别名引用模型，便于多模型管理。",
		Recommendation: "填简短别名，如 `main`",
		Related:        []string{"tags", "models_dir"},
	},
	"tags": {
		Description:    "给模型打标签（--tags），用于分组/过滤管理，配合多模型功能使用。",
		Recommendation: "默认留空",
		Related:        []string{"alias"},
	},
	"tools": {
		Description:    "启用内置工具（--tools），逗号分隔列表，如 `weather,calculator`。让模型可通过 API 调用内置工具获取实时信息/计算，配合 Agent 使用。",
		Recommendation: "需要工具调用时填工具名",
		Related:        []string{"agent", "tools_runtime"},
	},
	"tools_runtime": {
		Description:    "工具运行时的环境配置（--tools-runtime），定义工具执行的沙箱/运行环境。高级配置，一般用默认。",
		Recommendation: "默认留空",
		Related:        []string{"tools"},
	},
	"agent": {
		Description:    "启用 Agent 模式（--agent），允许模型自动调用内置工具完成任务（多轮工具循环）。配合 tools 使用，让模型具备自主调用工具的能力。",
		Recommendation: "需要模型自动用工具时勾选",
		Related:        []string{"tools"},
	},
	// ── MCP ─────────────────────────────────
	"mcp_servers_config": {
		Description:    "通过 JSON 文件配置 MCP 服务器列表（--mcp-servers-config）。MCP 让模型调用外部工具/数据源（搜索、数据库、文件等）。本 launcher 有 MCP 管理界面，通常自动生成，无需手填。",
		Recommendation: "用 launcher 的 🧩MCP 管理界面配置",
		Related:        []string{"mcp_servers_json", "ui_mcp_proxy"},
	},
	"mcp_servers_json": {
		Description:    "以内联 JSON 直接提供 MCP 服务器配置（--mcp-servers-json），比文件方式更直接。本 launcher 会自动注入已绑定的 MCP 服务器。",
		Recommendation: "由 launcher 自动注入，一般不用手填",
		Related:        []string{"mcp_servers_config"},
	},
	"ui_mcp_proxy": {
		Description:    "为内置 UI 的 MCP 调用提供 CORS 代理（--ui-mcp-proxy），让浏览器端 UI 能跨域访问 MCP 服务。",
		Recommendation: "默认关闭",
		Related:        []string{"mcp_servers_json"},
	},
	// ── 分布式 / 模板 ───────────────────────
	"rpc": {
		Description:    "指定远端 RPC 计算设备（--rpc），格式如 `host:port`。把部分张量/层分发到远端 GPU 服务器计算，扩展显存，适合多机分布式推理。",
		Recommendation: "单机留空；多机填远端地址",
		Related:        []string{"n_gpu_layers"},
	},
	"no_jinja": {
		Description:    "禁用 Jinja 模板引擎（--no-jinja），改用简单聊天模板。若模型自带的 Jinja 模板兼容性有问题，可勾选回退到基础格式。",
		Recommendation: "模型模板异常时可勾选",
		Related:        []string{"chat_template_kwargs"},
	},
	"chat_template_kwargs": {
		Description:    "给聊天模板传递额外参数（--chat-template-kwargs，JSON 格式），如特殊标记、函数调用格式等。高级定制对话消息的构造方式。",
		Recommendation: "默认留空",
		Related:        []string{"chat_template", "no_jinja"},
	},
	// ── 对话 / 推理后处理 ───────────────────
	"skip_chat_parsing": {
		Description:    "跳过对 chat 消息的严格解析（--skip-chat-parsing）。对不符合标准格式的消息更宽容，但可能影响多轮上下文的正确构造。",
		Recommendation: "默认关闭",
		Related:        []string{"chat_template"},
	},
	"prefill_assistant": {
		Description:    "预填充助手回复片段（--prefill-assistant）。构造对话时预先注入一段助手文本，引导模型续写的风格/内容，如预设固定开场白或系统回复。",
		Recommendation: "默认关闭",
		Related:        []string{"chat_template"},
	},
	"reasoning_preserve": {
		Description:    "保留思维链推理轨迹（--reasoning-preserve）。让模型输出的思考过程（reasoning content）完整保留，可在结果中查看模型的推理步骤。",
		Recommendation: "需要查看思考过程时勾选",
		Related:        []string{"reasoning_budget", "reasoning_budget_message"},
	},
	"reasoning_budget_message": {
		Description:    "当推理预算（reasoning_budget）耗尽时使用的提示消息（--reasoning-budget-message），替换默认提示，可自定义引导模型后续行为。",
		Recommendation: "默认留空",
		Related:        []string{"reasoning_budget", "reasoning_preserve"},
	},
}
