//go:build !windows

package config

// systemRAMMB returns total physical RAM in MB on non-Windows platforms.
// The real-time monitor only needs it on Windows; other OSes report 0.
func systemRAMMB() uint64 {
	return 0
}
