package config

import (
	"fmt"
	"sort"
	"strings"
)

// chain.go implements the three-level parameter inheritance chain:
//
//	Level 1 全局默认 (config.json → default_params)   🌐
//	Level 2 模型专属 (bundles.json → bundle.default_params) 📦
//	Level 3 会话级   (current form values)           ✏️
//
// Each value records its provenance so the UI can render a source badge and
// the command generator can emit the final merged argument list.

// SourceLevel identifies which layer a value came from.
type SourceLevel int

const (
	LevelGlobal  SourceLevel = iota // 🌐 全局默认
	LevelModel                      // 📦 模型专属
	LevelSession                    // ✏️ 会话级（用户）
)

// SourceLabel returns the emoji badge used by the UI.
func (s SourceLevel) SourceLabel() string {
	switch s {
	case LevelGlobal:
		return "🌐"
	case LevelModel:
		return "📦"
	default:
		return "✏️"
	}
}

func (s SourceLevel) String() string {
	switch s {
	case LevelGlobal:
		return "global"
	case LevelModel:
		return "model"
	default:
		return "session"
	}
}

// ParamValue couples a value with its origin.
type ParamValue struct {
	Value  any         `json:"value"`
	Source SourceLevel `json:"source"`
}

// Chain resolves parameters by merging the three levels (higher wins).
type Chain struct {
	reg    *Registry
	values map[string]ParamValue
	order  []string // insertion order for deterministic output
}

// NewChain creates an empty chain.
func NewChain(reg *Registry) *Chain {
	return &Chain{reg: reg, values: make(map[string]ParamValue)}
}

// Set stores a value at the given source level (overwrites).
func (c *Chain) Set(key string, val any, src SourceLevel) {
	if _, ok := c.values[key]; !ok {
		c.order = append(c.order, key)
	}
	c.values[key] = ParamValue{Value: val, Source: src}
}

// Merge three maps, each at its own level, higher levels win.
func (c *Chain) Merge(global, model, session map[string]any) {
	// order: global < model < session
	layers := []struct {
		m   map[string]any
		lev SourceLevel
	}{
		{global, LevelGlobal},
		{model, LevelModel},
		{session, LevelSession},
	}
	for _, layer := range layers {
		for k, v := range layer.m {
			if v == nil {
				continue
			}
			cur, ok := c.values[k]
			if ok && int(cur.Source) > int(layer.lev) {
				continue // higher level already set
			}
			c.Set(k, v, layer.lev)
		}
	}
}

// Get returns a resolved value and its source.
func (c *Chain) Get(key string) (ParamValue, bool) {
	v, ok := c.values[key]
	return v, ok
}

// Value returns the resolved value only.
func (c *Chain) Value(key string) any {
	if v, ok := c.values[key]; ok {
		return v.Value
	}
	if d, ok := c.reg.Get(key); ok {
		return d.Default
	}
	return nil
}

// Keys returns all resolved keys in stable order.
func (c *Chain) Keys() []string {
	out := make([]string, 0, len(c.order))
	for _, k := range c.order {
		if _, ok := c.values[k]; ok {
			out = append(out, k)
		}
	}
	sort.Strings(out)
	return out
}

// ArgList renders the resolved parameters as a CLI argument slice suitable
// for exec.Command (no shell interpolation — injection safe).
func (c *Chain) ArgList() []string {
	var args []string
	for _, k := range c.Keys() {
		pv, _ := c.Get(k)
		d, ok := c.reg.Get(k)
		if !ok {
			continue // unknown key — ignore
		}
		flag := d.LongFlag
		if flag == "" && d.Flag != "" {
			flag = d.Flag
		}
		if flag == "" {
			continue
		}
		if !d.RequiresValue {
			// Pure boolean flag:
			//   - bool=true  → 发射正向 flag（显式开启）
			//   - bool=false → 若该参数定义了 NegFlag，发射负向旗标以真正
			//     关闭官方“默认 enabled”的开关；否则不发射（跟随官方默认）
			if b, ok := pv.Value.(bool); ok {
				if b {
					args = append(args, flag)
				} else if d.NegFlag != "" {
					args = append(args, d.NegFlag)
				}
			}
			continue
		}
		// 值为空串/空数组的可选参数（"" 表示“跟随官方默认”）不发射，
		// 防止把空串当成非法枚举值传给 llama-server（如 --spec-type ""）。
		if isEmptyArgValue(pv.Value) {
			continue
		}
		args = append(args, flag)
		if d.Kind == KindMulti {
			// 多选设备类参数需逗号拼接后单次发射（官方 <dev1,dev2,..>），
			// 而不是经 %v 输出成 [GPU0 GPU1] 之类的非法值。
			if joined, ok := joinMulti(pv.Value); ok {
				args = append(args, joined)
			}
			continue
		}
		args = append(args, formatValue(pv.Value))
	}
	return args
}

// isEmptyArgValue reports whether a resolved value should be treated as
// "unset" and therefore skipped during emission.
func isEmptyArgValue(v any) bool {
	switch x := v.(type) {
	case nil:
		return true
	case string:
		return x == ""
	case []string:
		return len(x) == 0
	case []any:
		return len(x) == 0
	}
	return false
}

// joinMulti renders a KindMulti value as the official comma-separated list.
func joinMulti(v any) (string, bool) {
	switch x := v.(type) {
	case []string:
		if len(x) == 0 {
			return "", false
		}
		return strings.Join(x, ","), true
	case []any:
		if len(x) == 0 {
			return "", false
		}
		parts := make([]string, 0, len(x))
		for _, e := range x {
			parts = append(parts, fmt.Sprintf("%v", e))
		}
		return strings.Join(parts, ","), true
	}
	return "", false
}

// CommandLine returns a single-line string for preview.
func (c *Chain) CommandLine() string {
	return strings.Join(c.ArgList(), " ")
}

func formatValue(v any) string {
	switch x := v.(type) {
	case string:
		if x == "" {
			return `""`
		}
		return x
	case bool:
		if x {
			return "true"
		}
		return "false"
	case nil:
		return ""
	default:
		return fmt.Sprintf("%v", x)
	}
}
