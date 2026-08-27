package remote

import (
	"context"
	"strings"
	"sync"
	"time"
)

// Memory is an in-process remote used by tests.
type Memory struct {
	mu    sync.Mutex
	files map[string]memFile
}

type memFile struct {
	Data  []byte
	Mtime time.Time
	IsDir bool
}

func NewMemory() *Memory {
	return &Memory{files: map[string]memFile{}}
}

func (m *Memory) Kind() string { return "memory" }

func (m *Memory) List(ctx context.Context) ([]FileInfo, error) {
	_ = ctx
	m.mu.Lock()
	defer m.mu.Unlock()
	out := make([]FileInfo, 0, len(m.files))
	for p, f := range m.files {
		out = append(out, FileInfo{
			RelPath: p,
			Size:    int64(len(f.Data)),
			Mtime:   f.Mtime,
			IsDir:   f.IsDir,
		})
	}
	return out, nil
}

func (m *Memory) Read(ctx context.Context, relPath string) ([]byte, error) {
	_ = ctx
	m.mu.Lock()
	defer m.mu.Unlock()
	f, ok := m.files[relPath]
	if !ok {
		return nil, errNotFound(relPath)
	}
	cp := append([]byte(nil), f.Data...)
	return cp, nil
}

func (m *Memory) Write(ctx context.Context, relPath string, data []byte, mtime time.Time) error {
	_ = ctx
	if mtime.IsZero() {
		mtime = time.Now().UTC()
	}
	m.mu.Lock()
	defer m.mu.Unlock()
	cp := append([]byte(nil), data...)
	m.files[relPath] = memFile{Data: cp, Mtime: mtime}
	return nil
}

func (m *Memory) Mkdir(ctx context.Context, relPath string) error {
	_ = ctx
	if !strings.HasSuffix(relPath, "/") {
		relPath += "/"
	}
	m.mu.Lock()
	defer m.mu.Unlock()
	m.files[relPath] = memFile{IsDir: true, Mtime: time.Now().UTC()}
	return nil
}

func (m *Memory) Remove(ctx context.Context, relPath string) error {
	_ = ctx
	m.mu.Lock()
	defer m.mu.Unlock()
	delete(m.files, relPath)
	if strings.HasSuffix(relPath, "/") {
		prefix := relPath
		for k := range m.files {
			if strings.HasPrefix(k, prefix) {
				delete(m.files, k)
			}
		}
	}
	return nil
}

type notFound string

func (e notFound) Error() string { return "not found: " + string(e) }

func errNotFound(p string) error { return notFound(p) }
