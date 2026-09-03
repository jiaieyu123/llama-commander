package config

// auto.go implements the auto-configuration engine: hardware detection,
// VRAM estimation and one-click parameter recommendation.

import (
	"context"
	"fmt"
	"os/exec"
	"runtime"
	"strconv"
	"strings"
	"time"
)

// HardwareInfo describes the detected machine capabilities.
type HardwareInfo struct {
	GPUModels   []string `json:"gpu_models"`
	TotalVRAMMB uint64   `json:"total_vram_mb"`
	FreeVRAMMB  uint64   `json:"free_vram_mb"`
	GPUCount    int      `json:"gpu_count"`
	CPUCores    int      `json:"cpu_cores"`
	SystemRAMMB uint64   `json:"system_ram_mb"`
	CUDAMajor   int      `json:"cuda_major"`
	Backend     string   `json:"backend"` // cuda | vulkan | metal | cpu
}

// DraftSpec describes the draft model's spec and VRAM configuration.
type DraftSpec struct {
	ModelSpec
	NGPULayers int    `json:"n_gpu_layers"`
	CacheTypeK string `json:"cache_type_k"`
	CacheTypeV string `json:"cache_type_v"`
	CPUMoE     bool   `json:"cpu_moe"`
}

// DetectHardware probes the machine. On NVIDIA GPUs it shells out to
// nvidia-smi; otherwise it falls back to CPU-only information.
func DetectHardware(ctx context.Context) (*HardwareInfo, error) {
	hw := &HardwareInfo{
		CPUCores: runtime.NumCPU(),
		Backend:  "cpu",
	}
	if runtime.GOOS == "windows" {
		hw.SystemRAMMB = systemRAMMB()
	}
	if nvidia, err := queryNvidiaSMI(ctx); err == nil {
		hw.GPUModels = nvidia.models
		hw.TotalVRAMMB = nvidia.totalVRAMMB
		hw.FreeVRAMMB = nvidia.freeVRAMMB
		hw.GPUCount = len(nvidia.models)
		hw.CUDAMajor = nvidia.cudaMajor
		if hw.GPUCount > 0 {
			hw.Backend = "cuda"
		}
	}
	return hw, nil
}

// ModelSpec is the minimum model information required by the estimator.
type ModelSpec struct {
	FileSizeMB      float64 // approximate weight size in MB
	BlockCount      uint64
	ContextLength   uint64
	HeadCountKV     uint64
	EmbeddingLength uint64
	Architecture    string
	IsMoE           bool
	NumExperts      uint64
	MMProjSizeMB    float64 // vision projector size in MB (0 = none)
}

// Recommendation is the output of the one-click optimizer.
type Recommendation struct {
	NGPULayers      int      `json:"n_gpu_layers"` // -1 == auto
	CtxSize         int      `json:"ctx_size"`
	FlashAttn       string   `json:"flash_attn"` // on/off/auto
	Threads         int      `json:"threads"`
	KVCacheK        string   `json:"kv_cache_k"`
	KVCacheV        string   `json:"kv_cache_v"`
	LoadMode        string   `json:"load_mode"`
	CPUMoE          bool     `json:"cpu_moe"`
	Parallel        int      `json:"parallel"` // -1 == auto
	EstimatedVRAMGB float64  `json:"estimated_vram_gb"`
	MMProjCPU       bool     `json:"mmproj_cpu"` // run vision projector on CPU
	Notes           []string `json:"notes"`
}

// Recommend computes parameters for the requested scene preset.
// scene ∈ {"speed", "context", "lowvram", "creative"}.
func (h *HardwareInfo) Recommend(spec ModelSpec, scene string, draft *DraftSpec) *Recommendation {
	rec := &Recommendation{
		Threads:   h.CPUCores,
		LoadMode:  "mmap",
		KVCacheK:  "f16",
		KVCacheV:  "f16",
		FlashAttn: "auto",
		Parallel:  -1,
	}
	if spec.IsMoE && spec.NumExperts > 2 {
		rec.CPUMoE = true
		rec.Notes = append(rec.Notes, "检测到 MoE 模型，建议 --cpu-moe 节省显存")
	}

	ctx := spec.ContextLength
	if ctx == 0 {
		ctx = 4096
	}
	switch scene {
	case "speed":
		if ctx > 2048 {
			ctx = 2048
		}
		rec.FlashAttn = "on"
		rec.Notes = append(rec.Notes, "极速模式：低上下文 + FA 全开")
	case "context":
		rec.FlashAttn = "on"
		rec.KVCacheV = "q8_0"
		rec.Notes = append(rec.Notes, "长文本模式：KV 缓存降级为 q8_0")
	case "lowvram":
		if ctx > 4096 {
			ctx = 4096
		}
		rec.KVCacheK = "q8_0"
		rec.KVCacheV = "q4_0"
		rec.Notes = append(rec.Notes, "低显存模式：保守 GPU 层数，KV 降为 q4_0")
	case "creative":
		rec.FlashAttn = "on"
		rec.Notes = append(rec.Notes, "创意写作：高质量采样")
	}
	rec.CtxSize = int(ctx)

	mmprojCPU := false
	if spec.MMProjSizeMB > 0 {
		switch scene {
		case "speed", "lowvram":
			mmprojCPU = true
			rec.Notes = append(rec.Notes,
				fmt.Sprintf("检测到视觉投影 mmproj (%.0f MB)，建议勾选「mmproj 走 CPU」以把显存让给主模型层（纯文本场景）", spec.MMProjSizeMB))
		}
	}
	rec.MMProjCPU = mmprojCPU

	// ---- 草稿显存计算 ----
	var draftVRAMGB float64
	if draft != nil && draft.FileSizeMB > 0 {
		draftVRAMGB = EstimateVRAMEx(draft.ModelSpec, draft.NGPULayers, rec.CtxSize, h, draft.CacheTypeK, draft.CacheTypeV, false)
		rec.Notes = append(rec.Notes, fmt.Sprintf("草稿模型额外占用 %.1f GB 显存", draftVRAMGB))
	}

	if h.GPUCount > 0 && h.TotalVRAMMB > 0 {
		rec.NGPULayers = h.estimateLayersWithDraft(spec, ctx, scene, rec.KVCacheK, rec.KVCacheV, mmprojCPU, draftVRAMGB)
		rec.EstimatedVRAMGB = EstimateVRAMEx(spec, rec.NGPULayers, rec.CtxSize, h, rec.KVCacheK, rec.KVCacheV, mmprojCPU) + draftVRAMGB
	} else {
		rec.NGPULayers = 0
		rec.Notes = append(rec.Notes, "未检测到 GPU，将使用纯 CPU 推理")
	}

	if draft != nil && rec.NGPULayers == 0 {
		rec.Notes = append(rec.Notes, "草稿模型在 CPU 上运行（主模型纯 CPU 模式）")
	}
	return rec
}

// estimateLayersWithDraft iterates candidate layer counts to find the largest
// one that fits within available VRAM after deducting the draft model's VRAM
// usage. Returns -1 if the model cannot be split (should stay on GPU), 0 if
// nothing fits.
func (h *HardwareInfo) estimateLayersWithDraft(spec ModelSpec, ctx uint64, scene, kvK, kvV string, mmprojCPU bool, draftVRAMGB float64) int {
	if spec.BlockCount == 0 || spec.FileSizeMB <= 0 {
		return -1
	}
	marginMB := 1536.0
	if scene == "lowvram" {
		marginMB = 2048.0
	}
	budget := float64(h.FreeVRAMMB)
	if budget <= 0 {
		budget = float64(h.TotalVRAMMB) - marginMB
	}
	budget -= marginMB
	budget -= draftVRAMGB * 1024.0
	if budget <= 0 {
		return 0
	}
	best := 0
	for l := uint64(0); l <= spec.BlockCount; l++ {
		est := EstimateVRAMEx(spec, int(l), int(ctx), h, kvK, kvV, mmprojCPU)
		if est*1024.0 <= budget {
			best = int(l)
		} else {
			break
		}
	}
	if best == int(spec.BlockCount) {
		return -1
	}
	return best
}

// estimateLayers iterates candidate layer counts to find the largest one that
// fits within available VRAM (leaving a 1.5GB safety margin, 2GB in lowvram).
// It accounts for KV cache type and mmproj placement so the result matches
// what the launch command will actually consume.
func (h *HardwareInfo) estimateLayers(spec ModelSpec, ctx uint64, scene, kvK, kvV string, mmprojCPU bool) int {
	if spec.BlockCount == 0 || spec.FileSizeMB <= 0 {
		return -1 // unknown → auto
	}
	marginMB := 1536.0
	if scene == "lowvram" {
		marginMB = 2048.0
	}
	budget := float64(h.FreeVRAMMB)
	if budget <= 0 {
		budget = float64(h.TotalVRAMMB) - marginMB
	}
	budget -= marginMB
	if budget <= 0 {
		return 0
	}
	best := 0
	for l := uint64(0); l <= spec.BlockCount; l++ {
		est := EstimateVRAMEx(spec, int(l), int(ctx), h, kvK, kvV, mmprojCPU)
		if est*1024.0 <= budget { // est is in GB
			best = int(l)
		} else {
			break
		}
	}
	if best == int(spec.BlockCount) {
		return -1 // full offload → auto/all
	}
	return best
}

// kvBytesPerElement returns the bytes per KV-cache element for a cache type.
func kvBytesPerElement(kind string) float64 {
	switch kind {
	case "f32":
		return 4.0
	case "bf16", "f16":
		return 2.0
	case "q8_0":
		return 1.0
	case "q4_0", "q4_1", "iq4_nl":
		return 0.5
	case "q5_0", "q5_1":
		return 0.625
	default:
		return 2.0
	}
}

// EstimateVRAMEx returns the estimated VRAM footprint in GB for a given
// GPU-layer count, context, KV cache types and mmproj placement. It accounts
// for offloaded weights + KV cache + vision projector (when GPU-offloaded).
func EstimateVRAMEx(spec ModelSpec, ngl int, ctx int, h *HardwareInfo, kvK, kvV string, mmprojCPU bool) float64 {
	weightGB := 0.0
	if spec.BlockCount > 0 {
		frac := float64(ngl) / float64(spec.BlockCount)
		if ngl < 0 || ngl >= int(spec.BlockCount) {
			frac = 1.0
		}
		weightGB = spec.FileSizeMB / 1024.0 * frac
	}
	if !mmprojCPU && spec.MMProjSizeMB > 0 {
		weightGB += spec.MMProjSizeMB / 1024.0
	}
	kvBytesPerToken := float64(spec.HeadCountKV) * float64(spec.EmbeddingLength) *
		(kvBytesPerElement(kvK) + kvBytesPerElement(kvV))
	kvGB := (float64(ctx) * kvBytesPerToken) / (1024 * 1024 * 1024)
	overhead := 0.5 // buffers / compute workspace (GB)
	return weightGB + kvGB + overhead
}

// EstimateVRAM keeps the legacy signature (f16 KV, mmproj on GPU) for callers
// that do not have the full parameter context.
func EstimateVRAM(spec ModelSpec, ngl int, ctx int, h *HardwareInfo) float64 {
	return EstimateVRAMEx(spec, ngl, ctx, h, "f16", "f16", false)
}

// systemRAMMB 由平台文件提供：auto_windows.go（GlobalMemoryStatusEx）/
// auto_other.go（非 Windows 占位 0）。

// ---- nvidia-smi integration ----

type nvidiaInfo struct {
	models      []string
	totalVRAMMB uint64
	freeVRAMMB  uint64
	cudaMajor   int
}

func queryNvidiaSMI(ctx context.Context) (*nvidiaInfo, error) {
	exe, err := exec.LookPath("nvidia-smi")
	if err != nil {
		return nil, err
	}
	cctx, cancel := context.WithTimeout(ctx, 3*time.Second)
	defer cancel()

	out, err := exec.CommandContext(cctx, exe,
		"--query-gpu=name,memory.total,memory.free",
		"--format=csv,noheader,nounits").Output()
	if err != nil {
		return nil, err
	}
	info := &nvidiaInfo{}
	for _, line := range strings.Split(strings.TrimSpace(string(out)), "\n") {
		parts := strings.Split(line, ",")
		if len(parts) < 3 {
			continue
		}
		name := strings.TrimSpace(parts[0])
		total, _ := strconv.ParseUint(strings.TrimSpace(parts[1]), 10, 64)
		free, _ := strconv.ParseUint(strings.TrimSpace(parts[2]), 10, 64)
		info.models = append(info.models, name)
		info.totalVRAMMB += total
		info.freeVRAMMB += free
	}
	if len(info.models) == 0 {
		return nil, errNvidiaNoGPU
	}
	return info, nil
}

var errNvidiaNoGPU = &nvidiaQueryError{}

type nvidiaQueryError struct{}

func (e *nvidiaQueryError) Error() string { return "nvidia-smi: no GPU found" }
