// Package webui embeds the compiled front-end assets so that the server can
// be distributed as a single binary. The canonical source of the front-end
// lives in ./dist (mirrored to web/dist for external serving).
package webui

import (
	"embed"
	"io/fs"
)

//go:embed all:dist
var distFS embed.FS

// FS returns the embedded web root.
func FS() (fs.FS, error) {
	return fs.Sub(distFS, "dist")
}
