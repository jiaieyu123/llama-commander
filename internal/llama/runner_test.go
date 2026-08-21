package llama

import (
	"bytes"
	"os/exec"
	"runtime"
	"strings"
	"testing"
	"time"
)

// TestRunnerStartStop starts a harmless long-running command and stops it,
// verifying the lifecycle helpers behave.
func TestRunnerStartStop(t *testing.T) {
	var exe, arg string
	if runtime.GOOS == "windows" {
		exe = "ping"
		arg = "-t" // infinite ping on Windows
	} else {
		exe = "sleep"
		arg = "30"
	}
	if _, err := exec.LookPath(exe); err != nil {
		t.Skipf("%s not available", exe)
	}
	var buf bytes.Buffer
	r := New(Options{
		BinaryPath: exe,
		Args:       []string{arg},
		Stdout:     &buf,
		Stderr:     &buf,
	})
	if err := r.Start(); err != nil {
		t.Fatalf("Start: %v", err)
	}
	if r.PID() == 0 {
		t.Fatal("PID is 0 after start")
	}
	if !r.Running() {
		t.Fatal("Runner reports not running after start")
	}
	if err := r.Stop(3 * time.Second); err != nil {
		t.Fatalf("Stop: %v", err)
	}
	if r.Running() {
		t.Fatal("Runner still running after Stop")
	}
	r.Close()
}

// TestRunnerBadBinary verifies a missing binary yields a clean error.
func TestRunnerBadBinary(t *testing.T) {
	r := New(Options{BinaryPath: "definitely-not-a-real-binary-xyz"})
	if err := r.Start(); err == nil {
		r.Kill()
		t.Fatal("expected start error for missing binary")
	} else if !strings.Contains(err.Error(), "start llama-server") {
		t.Fatalf("unexpected error: %v", err)
	}
}
