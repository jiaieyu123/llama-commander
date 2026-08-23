package main

import (
	"fmt"
	"strings"
	"testing"

	"llama-launcher/internal/config"
)

// testAppWithRegistry builds an App that only has a registry populated, enough
// to exercise planSweep without touching disk/hardware.
func testAppWithRegistry() *App {
	return &App{registry: config.NewRegistry()}
}

func TestPlanSweepWithinCap(t *testing.T) {
	a := testAppWithRegistry()
	plan, err := a.planSweep([]sweepParamReq{
		{Key: "n_gpu_layers", Values: []string{"0", "33"}},
		{Key: "threads", Values: []string{"8", "16"}},
	})
	if err != nil {
		t.Fatalf("planSweep: %v", err)
	}
	if plan.Sampled {
		t.Errorf("2x2 within cap should not be sampled")
	}
	if plan.Total != 4 || len(plan.Combos) != 4 {
		t.Errorf("expected 4 combos, total=%d combos=%d", plan.Total, len(plan.Combos))
	}
}

func TestPlanSweepOversizeAutoSamples(t *testing.T) {
	a := testAppWithRegistry()
	// 8 params with many values → huge cartesian product, must be auto-sampled
	plan, err := a.planSweep([]sweepParamReq{
		{Key: "threads", Values: []string{"8", "16"}},
		{Key: "batch_size", Values: []string{"512", "1024", "2048"}},
		{Key: "cache_type_k", Values: []string{"bf16", "q8_0", "q4_0", "iq4_nl"}},
		{Key: "cache_type_v", Values: []string{"bf16", "q8_0", "q4_0", "iq4_nl"}},
		{Key: "rope_scaling", Values: []string{"yarn", "linear"}},
		{Key: "parallel", Values: []string{"1", "4"}},
		{Key: "kv_offload", Values: []string{"on", "off"}},
		{Key: "threads_batch", Values: []string{"0", "8", "16"}},
	})
	if err != nil {
		t.Fatalf("planSweep: %v", err)
	}
	if !plan.Sampled {
		t.Errorf("oversize sweep should be sampled")
	}
	if plan.Total <= sweepCap {
		t.Errorf("expected total > cap, got %d", plan.Total)
	}
	if len(plan.Combos) > sweepCap {
		t.Errorf("sampled combos must be <= cap, got %d", len(plan.Combos))
	}
	if len(plan.Combos) == 0 {
		t.Fatalf("sampled combos empty")
	}
	// 每个参数每个档位至少出现一次（覆盖保证）
	for _, p := range []struct {
		key  string
		vals []string
	}{{key: "threads", vals: []string{"8", "16"}}, {key: "batch_size", vals: []string{"512", "1024", "2048"}}, {key: "parallel", vals: []string{"1", "4"}}} {
		for _, want := range p.vals {
			found := false
			for _, c := range plan.Combos {
				if c[p.key] != nil && strings.Contains(fmt.Sprintf("%v", c[p.key]), want) {
					found = true
					break
				}
			}
			if !found {
				t.Errorf("coverage missing %s=%s", p.key, want)
			}
		}
	}
	// 标签非空且与组合数一致
	if len(plan.Labels) != len(plan.Combos) {
		t.Errorf("labels count %d != combos %d", len(plan.Labels), len(plan.Combos))
	}
	if strings.TrimSpace(plan.Labels[0]) == "" {
		t.Errorf("label empty")
	}
}

func TestPlanSweepFixedSingleValue(t *testing.T) {
	a := testAppWithRegistry()
	plan, err := a.planSweep([]sweepParamReq{
		{Key: "n_gpu_layers", Values: []string{"33"}},
		{Key: "threads", Values: []string{"8", "16"}},
	})
	if err != nil {
		t.Fatalf("planSweep: %v", err)
	}
	if plan.Total != 2 || len(plan.Combos) != 2 {
		t.Errorf("single-value param should be fixed: total=%d combos=%d", plan.Total, len(plan.Combos))
	}
}

func TestPlanSweepNoParams(t *testing.T) {
	a := testAppWithRegistry()
	if _, err := a.planSweep(nil); err == nil {
		t.Errorf("no params should error")
	}
}
