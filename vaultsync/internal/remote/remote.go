package remote

import (
	"context"
	"time"
)

type FileInfo struct {
	RelPath string
	Size    int64
	Mtime   time.Time
	IsDir   bool
}

type Remote interface {
	Kind() string
	List(ctx context.Context) ([]FileInfo, error)
	Read(ctx context.Context, relPath string) ([]byte, error)
	Write(ctx context.Context, relPath string, data []byte, mtime time.Time) error
	Mkdir(ctx context.Context, relPath string) error
	Remove(ctx context.Context, relPath string) error
}
