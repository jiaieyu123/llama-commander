package secure

import (
	"path/filepath"
	"testing"
)

// TestRoundTrip verifies encrypt → decrypt returns the original value.
func TestRoundTrip(t *testing.T) {
	key := filepath.Join(t.TempDir(), ".secret")
	enc, err := Encrypt(key, "sk-test-12345")
	if err != nil {
		t.Fatalf("Encrypt: %v", err)
	}
	if enc == "sk-test-12345" {
		t.Fatal("ciphertext must not equal plaintext")
	}
	dec, err := Decrypt(key, enc)
	if err != nil {
		t.Fatalf("Decrypt: %v", err)
	}
	if dec != "sk-test-12345" {
		t.Fatalf("roundtrip mismatch: %q", dec)
	}
}

// TestEmptyDecrypt verifies empty input yields empty output (no key needed).
func TestEmptyDecrypt(t *testing.T) {
	key := filepath.Join(t.TempDir(), ".secret")
	dec, err := Decrypt(key, "")
	if err != nil || dec != "" {
		t.Fatalf("Decrypt('') = %q, %v", dec, err)
	}
}

// TestKeyIsReused verifies the key file persists across calls (deterministic
// decrypt for the same ciphertext).
func TestKeyIsReused(t *testing.T) {
	key := filepath.Join(t.TempDir(), ".secret")
	enc, _ := Encrypt(key, "value")
	if _, err := Encrypt(key, "value"); err != nil {
		t.Fatalf("second Encrypt: %v", err)
	}
	// a new Encrypt should have produced the same key file (decrypt still works)
	dec, err := Decrypt(key, enc)
	if err != nil || dec != "value" {
		t.Fatalf("decrypt after re-encrypt: %q, %v", dec, err)
	}
}
