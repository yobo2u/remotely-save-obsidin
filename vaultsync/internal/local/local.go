package local

import (
	"io/fs"
	"os"
	"path/filepath"
	"time"

	"github.com/yobo2u/remotely-save-obsidin/vaultsync/internal/ignore"
	"github.com/yobo2u/remotely-save-obsidin/vaultsync/internal/remote"
	"github.com/yobo2u/remotely-save-obsidin/vaultsync/internal/util"
)

type Vault struct {
	Root              string
	IgnoreDotObsidian bool
}

func (v Vault) Abs(rel string) string {
	return filepath.Join(v.Root, filepath.FromSlash(ignore.Normalize(rel)))
}

func (v Vault) List() ([]remote.FileInfo, error) {
	var out []remote.FileInfo
	err := filepath.WalkDir(v.Root, func(p string, d fs.DirEntry, err error) error {
		if err != nil {
			return err
		}
		rel, err := filepath.Rel(v.Root, p)
		if err != nil {
			return err
		}
		if rel == "." {
			return nil
		}
		n := ignore.Normalize(rel)
		if d.IsDir() && ignore.ShouldSkip(n+"/", v.IgnoreDotObsidian) {
			return filepath.SkipDir
		}
		if ignore.ShouldSkip(n, v.IgnoreDotObsidian) {
			return nil
		}
		info, err := d.Info()
		if err != nil {
			return err
		}
		item := remote.FileInfo{
			RelPath: n,
			Size:    info.Size(),
			Mtime:   info.ModTime().UTC(),
			IsDir:   d.IsDir(),
		}
		if d.IsDir() {
			item.RelPath = n + "/"
			item.Size = 0
		}
		out = append(out, item)
		return nil
	})
	return out, err
}

func (v Vault) Read(rel string) ([]byte, error) {
	return os.ReadFile(v.Abs(rel))
}

func (v Vault) Write(rel string, data []byte, mtime time.Time) error {
	abs := v.Abs(rel)
	if err := os.MkdirAll(filepath.Dir(abs), 0o755); err != nil {
		return err
	}
	if err := os.WriteFile(abs, data, 0o644); err != nil {
		return err
	}
	if !mtime.IsZero() {
		return os.Chtimes(abs, mtime, mtime)
	}
	return nil
}

func (v Vault) Mkdir(rel string) error {
	return os.MkdirAll(v.Abs(rel), 0o755)
}

func (v Vault) Remove(rel string) error {
	return os.RemoveAll(v.Abs(rel))
}

func (v Vault) Hash(rel string) (string, error) {
	return util.SHA256File(v.Abs(rel))
}
