//go:build windows

package llama

import (
	"unsafe"

	"golang.org/x/sys/windows"
)

// jobObject wraps a Windows Job Object. When the manager exits or crashes,
// JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE makes the kernel terminate every child
// process bound to the job — preventing orphan llama-server processes.
type jobObject struct {
	handle windows.Handle
}

func newJobObject() (*jobObject, error) {
	h, err := windows.CreateJobObject(nil, nil)
	if err != nil {
		return nil, err
	}
	info := windows.JOBOBJECT_EXTENDED_LIMIT_INFORMATION{
		BasicLimitInformation: windows.JOBOBJECT_BASIC_LIMIT_INFORMATION{
			LimitFlags: windows.JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE,
		},
	}
	if _, err := windows.SetInformationJobObject(
		h,
		windows.JobObjectExtendedLimitInformation,
		uintptr(unsafe.Pointer(&info)),
		uint32(unsafe.Sizeof(info)),
	); err != nil {
		windows.CloseHandle(h)
		return nil, err
	}
	return &jobObject{handle: h}, nil
}

// assign binds an already-started child process (by PID) to the job.
func (j *jobObject) assign(pid int) error {
	if j == nil || j.handle == 0 {
		return windows.ERROR_INVALID_HANDLE
	}
	// AssignProcessToJobObject requires PROCESS_SET_QUOTA | PROCESS_TERMINATE.
	h, err := windows.OpenProcess(
		windows.PROCESS_SET_QUOTA|windows.PROCESS_TERMINATE,
		false,
		uint32(pid),
	)
	if err != nil {
		return err
	}
	defer windows.CloseHandle(h)
	return windows.AssignProcessToJobObject(j.handle, h)
}

func (j *jobObject) close() {
	if j != nil && j.handle != 0 {
		_ = windows.CloseHandle(j.handle)
		j.handle = 0
	}
}
