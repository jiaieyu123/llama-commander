package config

// auto.go implements the auto-configuration engine: hardware detection,
// VRAM estimation and one-click parameter recommendation.

import (
	"context"
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
	FileSizeMB    float64 // approximate weight size in MB
	BlockCount    uint64
	ContextLength uint64
	HeadCountKV   uint64
	EmbeddingLength uint64
	Architecture  string
	IsMoE         bool
	NumExperts    uint64
}

// Recommendation is the output of the one-click optimizer.
type Recommendation struct {
	NGPULayers     int      `json:"n_gpu_layers"` // -1 == auto
	CtxSize        int      `json:"ctx_size"`
	FlashAttn      string   `json:"flash_attn"` // on/off/auto
	Threads        int      `json:"threads"`
	KVCacheK       string   `json:"kv_cache_k"`
	KVCacheV       string   `json:"kv_cache_v"`
	LoadMode       string   `json:"load_mode"`
	CPUMoE         bool     `json:"cpu_moe"`
	Parallel       int      `json:"parallel"` // -1 == auto
	EstimatedVRAMGB float64 `json:"estimated_vram_gb"`
	Notes          []string `json:"notes"`
}

// Recommend computes parameters for the requested scene preset.
// scene ∈ {"speed", "context", "lowvram", "creative"}.
func (h *HardwareInfo) Recommend(spec ModelSpec, scene string) *Recommendation {
	rec := &Recommendation{
		Threads:   h.CPUCores,
		LoadMode:  "mmap",
		KVCacheK:  "f16",
		KVCacheV:  "f16",
		FlashAttn: "auto",
		Parallel:  -1, // auto (llama 默认按并发自动分配槽位)
	}
	if spec.IsMoE && spec.NumExperts > 2 {
		rec.CPUMoE = true
		rec.Notes = append(rec.Notes, "检测到 MoE 模型，建议 --cpu-moe 节省显存")
	}

	// context
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

	// GPU layers
	if h.GPUCount > 0 && h.TotalVRAMMB > 0 {
		rec.NGPULayers = h.estimateLayers(spec, ctx, scene)
		rec.EstimatedVRAMGB = EstimateVRAM(spec, rec.NGPULayers, rec.CtxSize, h)
	} else {
		rec.NGPULayers = 0
		rec.Notes = append(rec.Notes, "未检测到 GPU，将使用纯 CPU 推理")
	}
	return rec
}

// estimateLayers iterates candidate layer counts to find the largest one that
// fits within available VRAM (leaving a 1.5GB safety margin, 2GB in lowvram).
func (h *HardwareInfo) estimateLayers(spec ModelSpec, ctx uint64, scene string) int {
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
	weightPerLayer := spec.FileSizeMB / float64(spec.BlockCount)
	_ = weightPerLayer // full computation uses EstimateVRAM below
	best := 0
	for l := uint64(0); l <= spec.BlockCount; l++ {
		est := EstimateVRAM(spec, int(l), int(ctx), h)
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

// EstimateVRAM returns the estimated VRAM footprint in GB for a given
// GPU-layer count and context. It accounts for offloaded weights + KV cache.
func EstimateVRAM(spec ModelSpec, ngl int, ctx int, h *HardwareInfo) float64 {
	weightGB := 0.0
	if spec.BlockCount > 0 {
		frac := float64(ngl) / float64(spec.BlockCount)
		if ngl < 0 || ngl >= int(spec.BlockCount) {
			frac = 1.0
		}
		weightGB = spec.FileSizeMB / 1024.0 * frac
	}
	kvBytesPerToken := float64(spec.HeadCountKV) * float64(spec.EmbeddingLength) * 2.0 // ~2 bytes per element
	kvGB := (float64(ctx) * kvBytesPerToken) / (1024 * 1024 * 1024)
	overhead := 0.5 // buffers / compute workspace (GB)
	return weightGB + kvGB + overhead
}

// systemRAMMB returns total physical RAM in MB (Windows only).
func systemRAMMB() uint64 {
	// Kept simple for the skeleton; wired to sysinfo in a later phase.
	return 0
}

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
