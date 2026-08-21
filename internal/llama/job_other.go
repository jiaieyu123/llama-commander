//go:build !windows

package llama

// jobObject is a no-op on non-Windows platforms. Process supervision relies
// on the OS (SIGTERM/process groups) instead.
type jobObject struct{}

func newJobObject() (*jobObject, error) { return &jobObject{}, nil }

func (j *jobObject) assign(pid int) error { return nil }

func (j *jobObject) close() {}
