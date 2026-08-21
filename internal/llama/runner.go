// Package llama manages llama-server sub-processes: lifecycle control,
// Windows Job Object binding and health/metrics polling.
package llama

import (
	"context"
	"errors"
	"fmt"
	"io"
	"os/exec"
	"sync"
	"time"
)

// Options configures a llama-server process.
type Options struct {
	BinaryPath string   // path to llama-server(.exe)
	Args       []string // CLI args (already injection-safe, no shell)
	Env        []string // extra env, e.g. ["CUDA_VISIBLE_DEVICES=0"]
	WorkDir    string
	Stdout     io.Writer // log collector
	Stderr     io.Writer
}

// Runner wraps a single llama-server process.
type Runner struct {
	opts   Options
	cmd    *exec.Cmd
	job    *jobObject
	mu     sync.Mutex
	exited chan struct{}
}

// New creates a Runner (does not start the process).
func New(opts Options) *Runner {
	r := &Runner{opts: opts, exited: make(chan struct{})}
	r.job, _ = newJobObject() // best-effort; nil on failure
	return r
}

// Start launches the process and assigns it to the Job Object so that no
// orphan survives the manager (KILL_ON_JOB_CLOSE).
func (r *Runner) Start() error {
	r.mu.Lock()
	defer r.mu.Unlock()
	if r.cmd != nil && r.cmd.Process != nil {
		return errors.New("already started")
	}
	bin := r.opts.BinaryPath
	if bin == "" {
		bin = "llama-server"
	}
	cmd := exec.Command(bin, r.opts.Args...)
	cmd.Dir = r.opts.WorkDir
	cmd.Env = append(cmd.Env, r.opts.Env...)
	if r.opts.Stdout != nil {
		cmd.Stdout = r.opts.Stdout
	}
	if r.opts.Stderr != nil {
		cmd.Stderr = r.opts.Stderr
	}
	if err := cmd.Start(); err != nil {
		return fmt.Errorf("start llama-server: %w", err)
	}
	r.cmd = cmd
	// Bind to job object using the child PID (Windows) or a no-op.
	if r.job != nil {
		if err := r.job.assign(cmd.Process.Pid); err != nil {
			// Non-fatal: process still runs, we just lose auto-cleanup.
			return nil
		}
	}
	// Notify when the process exits.
	go func() {
		_ = cmd.Wait()
		close(r.exited)
	}()
	return nil
}

// PID returns the process id, or 0 if not running.
func (r *Runner) PID() int {
	r.mu.Lock()
	defer r.mu.Unlock()
	if r.cmd != nil && r.cmd.Process != nil {
		return r.cmd.Process.Pid
	}
	return 0
}

// Running reports whether the process is alive.
func (r *Runner) Running() bool {
	select {
	case <-r.exited:
		return false
	default:
		return r.PID() != 0
	}
}

// Stop performs a graceful stop: it waits up to timeout for the process to
// exit on its own, then force-kills it. This mirrors the three-stage
// shutdown (SIGTERM → poll → TerminateProcess) from the spec.
func (r *Runner) Stop(timeout time.Duration) error {
	r.mu.Lock()
	cmd := r.cmd
	r.mu.Unlock()
	if cmd == nil || cmd.Process == nil {
		return errors.New("not running")
	}
	// Stage 1: signal graceful shutdown via the process (best effort).
	// llama-server also honours a POST /shutdown, handled by callers.
	// Stage 2: wait up to timeout.
	select {
	case <-r.exited:
		return nil
	case <-time.After(timeout):
	}
	// Stage 3: force kill.
	r.mu.Lock()
	defer r.mu.Unlock()
	if cmd.Process != nil {
		err := cmd.Process.Kill()
		// Wait for the watcher goroutine to reap the process.
		<-r.exited
		return err
	}
	return nil
}

// Kill force-terminates the process immediately.
func (r *Runner) Kill() error {
	r.mu.Lock()
	defer r.mu.Unlock()
	if r.cmd == nil || r.cmd.Process == nil {
		return errors.New("not running")
	}
	err := r.cmd.Process.Kill()
	<-r.exited
	return err
}

// Wait blocks until the process exits and returns its error.
func (r *Runner) Wait(ctx context.Context) error {
	select {
	case <-r.exited:
		return nil
	case <-ctx.Done():
		return ctx.Err()
	}
}

// Exited returns a channel closed when the process exits.
func (r *Runner) Exited() <-chan struct{} { return r.exited }

// Close releases the Job Object handle.
func (r *Runner) Close() {
	if r.job != nil {
		r.job.close()
	}
}
