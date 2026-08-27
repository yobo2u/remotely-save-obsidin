module github.com/yobo2u/remotely-save-obsidin/vaultsync

// Go 1.22. Avoid `go mod tidy` on a newer toolchain: gowebdav's tests
// import golang.org/x/net/webdav, and latest x/net requires Go 1.25+.

go 1.22.0

require (
	github.com/fsnotify/fsnotify v1.7.0
	github.com/studio-b12/gowebdav v0.9.0
	golang.org/x/oauth2 v0.23.0
)

require (
	cloud.google.com/go/compute/metadata v0.3.0 // indirect
	golang.org/x/sys v0.25.0 // indirect
)
