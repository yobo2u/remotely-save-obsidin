package remote

import (
	"context"
	"crypto/tls"
	"net/http"
	"path"
	"strings"
	"time"

	"github.com/studio-b12/gowebdav"
)

type WebDAV struct {
	Client    *gowebdav.Client
	RemoteDir string
}

func NewWebDAV(address, user, pass, remoteDir string, insecureTLS bool) *WebDAV {
	c := gowebdav.NewClient(strings.TrimRight(address, "/"), user, pass)
	if insecureTLS {
		c.SetTransport(&http.Transport{
			TLSClientConfig: &tls.Config{InsecureSkipVerify: true}, //nolint:gosec
		})
	}
	return &WebDAV{Client: c, RemoteDir: strings.Trim(remoteDir, "/")}
}

func (w *WebDAV) Kind() string { return "webdav" }

func (w *WebDAV) full(rel string) string {
	rel = strings.TrimPrefix(strings.ReplaceAll(rel, "\\", "/"), "/")
	if w.RemoteDir == "" {
		return "/" + rel
	}
	if rel == "" {
		return "/" + w.RemoteDir
	}
	return "/" + w.RemoteDir + "/" + rel
}

func (w *WebDAV) List(ctx context.Context) ([]FileInfo, error) {
	_ = ctx
	if err := w.Client.MkdirAll(w.full(""), 0755); err != nil {
		_ = err
	}
	var out []FileInfo
	var walk func(dir, prefix string) error
	walk = func(dir, prefix string) error {
		entries, err := w.Client.ReadDir(dir)
		if err != nil {
			return err
		}
		for _, e := range entries {
			name := e.Name()
			rel := name
			if prefix != "" {
				rel = prefix + name
			}
			info := FileInfo{
				RelPath: rel,
				Size:    e.Size(),
				Mtime:   e.ModTime().UTC(),
				IsDir:   e.IsDir(),
			}
			if e.IsDir() {
				info.RelPath = rel + "/"
				info.Size = 0
				out = append(out, info)
				if err := walk(path.Join(dir, name), info.RelPath); err != nil {
					return err
				}
				continue
			}
			out = append(out, info)
		}
		return nil
	}
	root := w.full("")
	if err := walk(root, ""); err != nil {
		return nil, err
	}
	return out, nil
}

func (w *WebDAV) Read(ctx context.Context, relPath string) ([]byte, error) {
	_ = ctx
	return w.Client.Read(w.full(relPath))
}

func (w *WebDAV) Write(ctx context.Context, relPath string, data []byte, mtime time.Time) error {
	_ = ctx
	_ = mtime
	p := w.full(relPath)
	if err := w.Client.MkdirAll(path.Dir(p), 0755); err != nil {
		_ = err
	}
	return w.Client.Write(p, data, 0644)
}

func (w *WebDAV) Mkdir(ctx context.Context, relPath string) error {
	_ = ctx
	return w.Client.MkdirAll(w.full(relPath), 0755)
}

func (w *WebDAV) Remove(ctx context.Context, relPath string) error {
	_ = ctx
	return w.Client.Remove(w.full(relPath))
}
