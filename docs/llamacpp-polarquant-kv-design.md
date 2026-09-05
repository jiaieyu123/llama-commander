# llama.cpp 内核 Track：PolarQuant-KV 式 KV 量化 设计文档

> 状态：设计评审稿（Phase 0 之前）
> 目标仓库：llama.cpp（本机持有 b10819-6a1a922d2 二进制，需检出源码 + 建编译环境）
> 配套：llama launcher（H:\llama Qdgl）负责接入与验证闭环（预算向导 / monitor / 一键应用）
> 日期：2026-09-06

---

## 0. 为什么值得做（收益模型，全部用我们实测数字）

机器：RTX 3060 Ti 8GB。gemma-4-12b-Q3（权重实测占用 ≈6.3GB GPU，file 4.9GB）。

| KV 编码 | 每 token（K+V） | 64k ctx | 128k ctx | 能否全 GPU（剩 ~1.5GB） |
|---|---|---|---|---|
| f16（现状上限） | 16,384 B（实测 17,323） | ~1.07 GB ✅ | ~2.15 GB ❌ 掉速 | 128k 不行 |
| q8_0（llama 已有） | ≈8,704 B | 0.57 GB ✅ | 1.14 GB ✅（紧） | 勉强 |
| q4_0（llama 已有） | ≈4,608 B | 0.30 GB ✅ | 0.60 GB ✅ | 余量充裕 |
| **PolarQuant 式 K+V 双压缩（q4/q3+，本 track）** | ≈3~5 KB | 0.2~0.33 GB | 0.4~0.66 GB ✅ | 128k 全速 + 给草稿/更大层数腾显存 |

> 结论：**只要把 KV 压到 q4 档，128k ctx 的"层掉 CPU → 21 t/s"瓶颈即可消除**，且还能把省下的显存给更多层/草稿。这是我们这台机器上最直接的收益。

对比基准（PolarQuant-KV，hilllief/polarquant-kv，PyTorch+CUDA 参考实现）：
- PQ4 编码、K 与 V **分别**压缩、K 用比 V 更激进的压缩；声称 73~99% 省显存（需批判：其中含低秩投影的收益，纯块量化的收益以 2~4× 为现实量级）。
- 参考实现为 PyTorch/MLX，无 GGUF/llama.cpp —— 必须自己移植到 ggml/llama.cpp。

**本 track 的范围决策**：第一期只做"块状量化 K+V"（等价于把 llama 的 q4_0/q8_0 升级为**K/V 独立编码 + 每 128/64 块 scale + 可选逐 head 精度保护**），**不做低秩投影**（那会侵入注意力计算图，复杂度/风险过大，列为 Phase 4 可选增强）。

---

## 1. 现状盘点（要改的东西在哪）

### 1.1 llama.cpp KV cache 布局（b10819 视角）
- `src/llama-kv-cache.cpp` `llama_kv_cache_unified`：每个非 SWA 层建 K、V 两个 `ggml_tensor`：
  - `ne[0] = n_embd_k_gqa(il)`（= `n_head_kv(il) * head_dim_k(il)`），`ne[1] = kv_size`（cells），`ne[2] = n_stream`。
  - tensor type = `type_k` / `type_v`（来自 `--cache-type-k/v`，默认 f16）。
- V 转置路径（`v_trans`，非 flash-attn 默认）会用 `n_embd_v_gqa_max()`（各层顶到最大）→ 逐层 V 维不同的模型（gemma4：普通 2048 / 稀疏 512）会浪费。
- SWA 层（sliding_window_pattern=True）KV 是固定窗口缓存，不随 ctx 增长（我们已实测/源码确认）——压缩收益主要在非 SWA 层，但 SWA 层同样能压（省那 ~320MB 固定块）。
- KV 写入：`llama_kv_cache` 的拷贝/更新经 ggml graph（`ggml_cpy` / 或直接 tensor 视图写入 f32→type 在 kernel 解）。flash attn 在 CUDA kernel 内直接按 type 读 KV 做点积。

### 1.2 llama 现有的"量化 KV"已有实现（先吃干净再扩）
`--cache-type-k/v` 已支持：`f32/f16/bf16/q8_0/q4_0/q4_1/q5_0/q5_1/iq4_nl`。
- q8_0：1.0625 B/elem；q4_0/iq4_nl：0.5625 B/elem（均含 block scale）。
- 也就是说 **"K+V 双量化"的第一版其实已存在**（`--cache-type-k q8_0 --cache-type-v q4_0` 这类组合）。launcher 预算向导的 per-token 表已覆盖这些值并随档缩放。
- PolarQuant-KV 的**增量**在于：更细粒度的独立 K/V 编码 + 更低 bit（q4→q3/q2 级）+（可选）K 低秩 → 比 llama 现 q4_0 再省 30~60%，同时精度更好（per-128 block + 每头 scale / outlier 保护）。

### 1.3 建议先做的"零内核改动"基线验证（Phase -1，可选但便宜）
先用 `--cache-type-k q8_0 -v q4_0` 在 128k ctx 下实测：层是否不再掉 CPU、t/s 与质量回退多少。**如果 q8/q4 组合已满足你当前需求，Phase 2 之前的激进压缩可缓**；本设计文档把 q4/q8 组合作为"已验证下限"，PolarQuant 式作为"目标上限"。

---

### 1.4 Phase -1 实测结果（2026-09-06，已完成，假设成立 ✅）
机器 RTX 3060 Ti 8GB / gemma-4-12b-Q3 / ngl=99 / parallel=1 / 官方 b10819 / prompt 332tok + gen 140tok：

| 配置 | ctx | GPU 占用 | prompt pps | gen tps | 结论 |
|---|---|---|---|---|---|
| f16/f16 | 128k | 7970MB(挤满) | 126 | **16.4** | 层掉 CPU（基线掉速） |
| q8_0/q4_0 | 128k | 6652MB | 192 | 20.4 | K 需同降才够 |
| q4_0/q4_0 | 128k | 6673MB | 1029 | **33.2** | 层回 GPU，+102% |
| f16/f16 | 64k | 7217MB | 1063 | 34.0 | 同 ctx 基线 |
| q4_0/q4_0 | 64k | 6181MB | 1026 | 32.2 | **q4 几乎无损(-5%)** |

**结论**：①KV q4 在同 ctx 下仅 -5% 速度、省 ~1GB 显存；②128k+q4 ≈ 64k+f16（33 vs 34）→ **ctx 翻倍速度不掉**，直接验证收益模型；③launcher 端即时可用：`--cache-type-k q4_0 -v q4_0 --ctx-size 131072`（预算向导 KV 档已支持 q4_0）。

**对内核 track 的意义**：llama 现 q4_0 已达成"128k 不掉速"主目标 → kv_pq4 内核的增量变为：更省显存（0.53→0.35 B/elem，多给草稿/更大层数）+ K/V 不对称与 per-head scale 的质量增益。内核 track 从"必要"降为"锦上添花/极致显存"，优先级可后置，先把现成 q4 一键方案落地 launcher。

---

### 1.5 Phase 1/2 实测：q2_0 作为实验性 2bit KV（已完成并提交，2026-09-06）
- 🛠 代码改动已提交 llama.cpp 分支 `kv-pq4-q2_0`（commit 2d39a52）：①`common/arg.cpp` kv_cache_types 白名单放行 q2_0；②`ggml-cuda/cpy-utils.cuh` 新增 `quantize_f32_q2_0_block`（64/块、d=amax、2bit、round(w/d)+1∈0..3，与 CPU ref 一致）；③`set-rows.cu` SET_ROWS 量化写分支加 q2_0；④`ggml-cuda.cu` supports_op(SET_ROWS) 接受 q2_0。
- ✅ 端到端能跑（E4B/12B + flash-attn），2bit KV 正确解码（与 dequantize_q2_0 的 (c-1)*d 自洽）。
- ❌ **不达生产标准**（实测）：
  - 12B@128k：GPU 6086MB（比 q4 6673 省 ~600MB）但 pps 72、gen tps 14.5（q4_0=33.2）→ 慢 2~14×
  - E4B(296tok)：q2 pps184/tps31.6 vs q4 pps985/tps63.5 → prefill 5.4×慢（写端无快速 prefill 量化 kernel）、decode 2×慢（flash-attn vec 无 q2_0 KQ/V 特化）
  - 2bit KV 记忆质量退化（fact recall 时好时坏）
- 🔍 根因三层：参数白名单(已放行) / 非 fa 禁量化 V(llama 校验) / CUDA SET_ROWS 写 kernel + flash vec 读 kernel 都需 q2_0 特化（缺）。
- 📌 **工程结论：q2_0 性价比低（2~14×慢+质量退化只换 600MB），不再投入读/写双内核优化；q4_0 为甜点**。q2_0 改动保留作实验档与未来压缩算法代码基础。若未来要 q2 级质量需 PolarQuant 式 per-head scale/outlier 补偿（更多内核工作）。


---

## 2. 设计：新增 KV 编码类型

### 2.1 命名与语义（建议）
在 llama.cpp 注册两种新 ggml type（仅用于 KV cache，不进 GGUF 权重）：

| 新 type | 含义 | 目标 |
|---|---|---|
| `GGML_TYPE_KVQ4_PQ`（内部代号 `kv_pq4`） | K+V 都按 per-128 块量化，K 档位 4bit、V 档位 4bit，**带每 64 元素的轻 scale + 每层每头一个 fp16 偏置** | 目标默认 |
| `GGML_TYPE_KVQ4K3V`（`kv_pq4k3v`，PolarQuant 风格 K/V 不对称） | K 用 3bit 激进压缩（K 可容忍更多误差，未来加低秩更好），V 用 4bit | 显存极限档 |

> 简化第一版：**只做一个 `kv_pq4`**（对称 4bit K+V，per-128 block = 类似现有 `q4_0` 但 block 粒度/scale 设计不同 + 显式支持 flash attn 点积直读）。`kv_pq4k3v` 与低秩都放 Phase 4。

### 2.2 需要动的代码点（以 b10819 为准，检出源码后逐行核）

1. **ggml 类型注册**（CPU 正确性 + row size）：
   - `ggml/src/ggml.c`：`ggml_type_traits` 表加条目（block size / row size / 解量化函数 `to_float`），供 CPU fallback 与 `ggml_row_size`。
   - `src/llama-ftype` / kv cache type 解析（`--cache-type-k/v` 的字符串→ggml type 映射）放行新值。
   - server：`llama-server` 参数允许值列表 + `llama.cpp` 的 `llama_kv_cache_type` 校验。
   - `src/llama-hparams.cpp` 无需改（n_embd_k_gqa 不变；行大小由 type traits 决定）。

2. **写入路径**（f32 KV → kv_pq4）：
   - 现有 q4_0 KV 的写入走 ggml 内建（ggml 直接按 type 存？实际 llama_kv_cache 更新时对 type!=f16 走 `ggml_cpy`/量化 kernel）。实现 `to_fp32` 是必须的；从 f32 量化到 kv_pq4 需要一个 `quantize_row_kv_pq4`（放 ggml.c 的 row 量化表，与其它 quantize 一致）。这样 CPU 版即可端到端正确。
   - 每头偏置：在写入 kernel 按 head 段算 scale/offset —— 通过把 type 设计为纯 row 量化（不含逐头逻辑）规避，逐头保护先不做（Phase 4）。

3. **Flash attention / 点积 kernel（CUDA）—— 本 track 最大工作量**：
   - `ggml/src/ggml-cuda/` 下 KV flash attn kernel 目前按 `type_k/type_v` 的分支做点积。新增对 `kv_pq4` 的块级点积路径：读 block → 解量化到寄存器（每 block 32/128 元素 + scale）→ 与 Q 点积。**注意** llama 现有 KV 量化的 flash attn 已支持 q8_0/q4_0 等，最省力的移植 = 复用其 `q4_0` CUDA 点积内核结构，替换为 kv_pq4 的布局/scale。
   - 非 flash（转置 V）路径同理。

4. **llama launcher 接入**（本仓库）：
   - `internal/config/registry.go`：`cache_type_k/v` 允许值加新档（或经 `--cache-type` 传新字符串）。
   - 预算向导 per-token 表加 `kv_pq4` 的字节系数（f16 的 ~1/4）。
   - 一键"128k 高 ctx 方案"预置：`--cache-type-k kv_pq4 -v kv_pq4 --ctx-size 131072`。

### 2.3 布局草案（可调）
```
kv_pq4 block = 128 元素：
  scale fp16（1）      // 128 元素共用
  min   fp16（1，可选 outlier/偏移）
  q     : 128×4bit = 64B
  → 行大小 ≈ (2+2+64)/128 = 0.531 B/elem（含 scale）
```
对照：f16=2.0、q4_0=0.5625、本设计≈0.53（略优 + 更大 block 少 scale 开销）。若要更激进，V 保持 4bit、K 用 2/3bit（PolarQuant 风格非对称）到 ~0.35 B/elem。

---

## 3. 自编译与维护路线

### 3.1 环境（本机 Windows）
- 源码：`git clone https://github.com/ggml-org/llama.cpp`，`git checkout 6a1a922d2`（= b10819 对应 commit，与现二进制一致，便于 diff）。
- 工具链：VS 2022（MSVC x64）+ CMake ≥3.24 + CUDA 13.3（与现有运行时 DLL 同版：cublas64_13/cublasLt64_13/cudart64_13，可直接复用目录里那套）。
- 构建目标：`llama-server`（含 CUDA）。
- 产物替换：launcher `config.json` 的 `binary_path` 指向自编译 exe；保留官方 b10819 作回滚。

### 3.2 分支策略
- 本地维护分支 `feature/kv-pq4`（基于 6a1a922d2），只加增量 commit；上游 bump 时 rebase/重编。
- 每次构建产物打 tag（`llama-server-kvpq4-r1.exe`），launcher 可多 binary 共存、一键切换（现有 config.binary_path 已支持任意路径）→ 这就是"维护成本"的缓解。

### 3.3 验证矩阵（用我们已建的闭环）
1. **正确性**：CPU-only（`-ngl 0`）新 type vs f16，同一 prompt 贪心解码输出逐 token 一致（或 ≤0.1% 漂移）。
2. **KV 显存**：nvidia-smi 差分 ctx 小区间 per-token；应≈ f16×0.27（kv_pq4 理论）。
3. **预算向导**：per-token 显示与实测一致（回归我们 P2 的差分校准法）。
4. **目标场景**：gemma-4-12b-Q3 + 128k ctx + kv_pq4 → 层不再掉 CPU → t/s 回到 ~45+（对比 f16 时 21）。
5. **质量**：同一批 prompt 困惑度/接受率对比 f16、q8_0、q4_0、kv_pq4（量化为 KV 只影响长上下文记忆精度，短程质量应几乎不变）。
6. **回归**：llama-bench 跑 f16 基线确认没把上游搞坏。

---

## 4. 分阶段计划

| Phase | 内容 | 验收 | 工作量(估) |
|---|---|---|---|
| **0** | 检出源码=6a1a922d2，搭 VS+CUDA 构建，产出可复现 `llama-server`（先不改码，确认环境） | 自编译 exe 与官方同 commit 行为一致 | 0.5~1 天 |
| **-1**（便宜先做） | 用 llama 现成 `-k q8_0 -v q4_0` 在 128k 实测 | 确认 q8/q4 组合能否已解 128k 掉速；决定激进程度 | 0.5 天 |
| **1** | 加 `kv_pq4` ggml type（CPU 全链）：注册/量化/解量化/写入 | CPU 正确性测试通过 | 1~2 天 |
| **2** | CUDA flash-attn 点积 + 非 flash 路径支持 `kv_pq4` | GPU 正确 + 显存达标 + t/s 不倒退 | 2~4 天 |
| **3** | launcher 接入（registry 值 / 预算 per-token / 一键 128k 方案） | 向导显示 + 一键应用生效 | 0.5 天 |
| **4**（可选） | K/V 非对称（K 3bit）/ per-head scale / K 低秩（真 PolarQuant） | 显存再降 30~60%，质量达标 | 2~5 天 |

合计（Phase 1–3 核心）：约 4~7 个工作日 + Phase 0 环境。

---

## 5. 风险与缓解

| 风险 | 影响 | 缓解 |
|---|---|---|
| 与上游分叉，升级成本 | 每次 bump 要重编 | 分支只加独立 commit；launcher 支持多 binary 共存回滚 |
| flash-attn kernel bug → 生成错乱 | 严重 | Phase 1 先 CPU 正确性；Phase 2 逐 token 对照；小步提交 |
| 量化为 KV 的精度回退在长上下文 | 记忆/检索变差 | 选 4bit 保守档 + per-head scale(Phase4)；与 q8_0 对比决定可接受点 |
| 8GB 卡上 kernel 编译/显存压测难复现 | 调试难 | 用 E4B 小模型快速迭代；gemma-12b 只做最终验证 |
| ggml 类型系统牵一发动全身 | 编译面广 | 新 type 仅 KV 用途，不进 GGUF 权重序列化路径 |

---

## 6. 下一步（等待拍板）

A. **Phase -1 先行**：不写码，先用官方 b10819 + `-k q8_0 -v q4_0` + 128k 实测（0.5 天，验证"q4 档即可解掉速"的收益假设是否成立）。
B. **直接 Phase 0**：本机检出 llama.cpp 源码 + VS/CUDA 环境，产出可复现自编译（不改码）。
C. 先评审本文档/调整设计（如 K/V bit、是否要低秩）再动。
