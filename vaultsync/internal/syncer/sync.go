package syncer

import (
	"context"
	"encoding/json"
	"fmt"
	"os"
	"path/filepath"
	"strings"
	"time"

	"github.com/yobo2u/remotely-save-obsidin/vaultsync/internal/ignore"
	"github.com/yobo2u/remotely-save-obsidin/vaultsync/internal/local"
	"github.com/yobo2u/remotely-save-obsidin/vaultsync/internal/remote"
	"github.com/yobo2u/remotely-save-obsidin/vaultsync/internal/util"
)

type Action string

const (
	ActSkip          Action = "skip"
	ActPush          Action = "push"
	ActPull          Action = "pull"
	ActDeleteLocal   Action = "delete_local"
	ActDeleteRemote  Action = "delete_remote"
	ActConflictNewer Action = "conflict_keep_newer"
)

type FileState struct {
	LocalMtime  int64  `json:"localMtime,omitempty"`
	RemoteMtime int64  `json:"remoteMtime,omitempty"`
	Size        int64  `json:"size,omitempty"`
	Hash        string `json:"hash,omitempty"`
}

type Snapshot struct {
	Updated time.Time            `json:"updated"`
	Files   map[string]FileState `json:"files"`
}

type Result struct {
	Pushed        int      `json:"pushed"`
	Pulled        int      `json:"pulled"`
	DeletedLocal  int      `json:"deletedLocal"`
	DeletedRemote int      `json:"deletedRemote"`
	Conflicts     int      `json:"conflicts"`
	Skipped       int      `json:"skipped"`
	Errors        []string `json:"errors,omitempty"`
	ElapsedMS     int64    `json:"elapsedMs,omitempty"`
}

type Engine struct {
	Vault     local.Vault
	Remote    remote.Remote
	StatePath string
	Conflict  string
}

func LoadSnapshot(path string) *Snapshot {
	b, err := os.ReadFile(path)
	if err != nil {
		return &Snapshot{Files: map[string]FileState{}}
	}
	s := &Snapshot{}
	if json.Unmarshal(b, s) != nil || s.Files == nil {
		return &Snapshot{Files: map[string]FileState{}}
	}
	return s
}

func SaveSnapshot(path string, s *Snapshot) error {
	if err := os.MkdirAll(filepath.Dir(path), 0o755); err != nil {
		return err
	}
	s.Updated = time.Now().UTC()
	b, err := json.MarshalIndent(s, "", "  ")
	if err != nil {
		return err
	}
	return os.WriteFile(path, b, 0o600)
}

func index(files []remote.FileInfo) map[string]remote.FileInfo {
	m := map[string]remote.FileInfo{}
	for _, f := range files {
		p := ignore.Normalize(f.RelPath)
		if f.IsDir && !strings.HasSuffix(p, "/") {
			p += "/"
		}
		m[p] = f
	}
	return m
}

func (e *Engine) Run(ctx context.Context) (*Result, error) {
	localFiles, err := e.Vault.List()
	if err != nil {
		return nil, err
	}
	remoteFiles, err := e.Remote.List(ctx)
	if err != nil {
		return nil, err
	}
	loc := index(localFiles)
	rem := index(remoteFiles)
	prev := LoadSnapshot(e.StatePath)
	next := &Snapshot{Files: map[string]FileState{}}
	res := &Result{}

	all := map[string]struct{}{}
	for k := range loc {
		all[k] = struct{}{}
	}
	for k := range rem {
		all[k] = struct{}{}
	}
	for k := range prev.Files {
		all[k] = struct{}{}
	}

	for p := range all {
		if strings.HasSuffix(p, "/") {
			if err := e.syncDir(ctx, p, loc, rem, next); err != nil {
				res.Errors = append(res.Errors, p+": "+err.Error())
			}
			continue
		}
		act, err := e.syncFile(ctx, p, loc, rem, prev, next)
		if err != nil {
			res.Errors = append(res.Errors, p+": "+err.Error())
			continue
		}
		switch act {
		case ActPush:
			res.Pushed++
		case ActPull:
			res.Pulled++
		case ActDeleteLocal:
			res.DeletedLocal++
		case ActDeleteRemote:
			res.DeletedRemote++
		case ActConflictNewer:
			res.Conflicts++
		default:
			res.Skipped++
		}
	}
	if err := SaveSnapshot(e.StatePath, next); err != nil {
		return res, err
	}
	return res, nil
}

func (e *Engine) syncDir(ctx context.Context, p string, loc, rem map[string]remote.FileInfo, next *Snapshot) error {
	_, lOK := loc[p]
	_, rOK := rem[p]
	switch {
	case lOK && !rOK:
		if err := e.Remote.Mkdir(ctx, p); err != nil {
			return err
		}
	case rOK && !lOK:
		if err := e.Vault.Mkdir(p); err != nil {
			return err
		}
	}
	next.Files[p] = FileState{}
	return nil
}

func sameish(l, r remote.FileInfo) bool {
	if l.Size == r.Size && abs64(l.Mtime.Unix()-r.Mtime.Unix()) <= 2 {
		return true
	}
	return false
}

func abs64(v int64) int64 {
	if v < 0 {
		return -v
	}
	return v
}

func (e *Engine) syncFile(ctx context.Context, p string, loc, rem map[string]remote.FileInfo, prev *Snapshot, next *Snapshot) (Action, error) {
	l, lOK := loc[p]
	r, rOK := rem[p]
	s, sOK := prev.Files[p]

	switch {
	case lOK && !rOK:
		if sOK && s.RemoteMtime > 0 && s.LocalMtime == l.Mtime.Unix() {
			if err := e.Vault.Remove(p); err != nil {
				return ActSkip, err
			}
			return ActDeleteLocal, nil
		}
		data, err := e.Vault.Read(p)
		if err != nil {
			return ActSkip, err
		}
		if err := e.Remote.Write(ctx, p, data, l.Mtime); err != nil {
			return ActSkip, err
		}
		next.Files[p] = FileState{LocalMtime: l.Mtime.Unix(), RemoteMtime: l.Mtime.Unix(), Size: l.Size, Hash: util.SHA256Bytes(data)}
		return ActPush, nil

	case rOK && !lOK:
		if sOK && s.LocalMtime > 0 && s.RemoteMtime == r.Mtime.Unix() {
			if err := e.Remote.Remove(ctx, p); err != nil {
				return ActSkip, err
			}
			return ActDeleteRemote, nil
		}
		data, err := e.Remote.Read(ctx, p)
		if err != nil {
			return ActSkip, err
		}
		if err := e.Vault.Write(p, data, r.Mtime); err != nil {
			return ActSkip, err
		}
		next.Files[p] = FileState{LocalMtime: r.Mtime.Unix(), RemoteMtime: r.Mtime.Unix(), Size: r.Size, Hash: util.SHA256Bytes(data)}
		return ActPull, nil

	case lOK && rOK:
		if sameish(l, r) {
			h := ""
			if b, err := e.Vault.Read(p); err == nil {
				h = util.SHA256Bytes(b)
			}
			next.Files[p] = FileState{LocalMtime: l.Mtime.Unix(), RemoteMtime: r.Mtime.Unix(), Size: l.Size, Hash: h}
			return ActSkip, nil
		}
		localChanged := !sOK || s.LocalMtime != l.Mtime.Unix()
		remoteChanged := !sOK || s.RemoteMtime != r.Mtime.Unix()
		if localChanged && !remoteChanged {
			data, err := e.Vault.Read(p)
			if err != nil {
				return ActSkip, err
			}
			if err := e.Remote.Write(ctx, p, data, l.Mtime); err != nil {
				return ActSkip, err
			}
			next.Files[p] = FileState{LocalMtime: l.Mtime.Unix(), RemoteMtime: l.Mtime.Unix(), Size: l.Size, Hash: util.SHA256Bytes(data)}
			return ActPush, nil
		}
		if remoteChanged && !localChanged {
			data, err := e.Remote.Read(ctx, p)
			if err != nil {
				return ActSkip, err
			}
			if err := e.Vault.Write(p, data, r.Mtime); err != nil {
				return ActSkip, err
			}
			next.Files[p] = FileState{LocalMtime: r.Mtime.Unix(), RemoteMtime: r.Mtime.Unix(), Size: r.Size, Hash: util.SHA256Bytes(data)}
			return ActPull, nil
		}
		// both changed or first sync with mismatch
		keepLocal := l.Mtime.After(r.Mtime)
		switch e.Conflict {
		case "keep_local":
			keepLocal = true
		case "keep_remote":
			keepLocal = false
		}
		loserName := conflictName(p)
		if keepLocal {
			data, err := e.Remote.Read(ctx, p)
			if err == nil {
				_ = e.Vault.Write(loserName, data, r.Mtime)
			}
			dataL, err := e.Vault.Read(p)
			if err != nil {
				return ActSkip, err
			}
			if err := e.Remote.Write(ctx, p, dataL, l.Mtime); err != nil {
				return ActSkip, err
			}
			next.Files[p] = FileState{LocalMtime: l.Mtime.Unix(), RemoteMtime: l.Mtime.Unix(), Size: l.Size, Hash: util.SHA256Bytes(dataL)}
		} else {
			data, err := e.Vault.Read(p)
			if err == nil {
				_ = e.Vault.Write(loserName, data, l.Mtime)
			}
			dataR, err := e.Remote.Read(ctx, p)
			if err != nil {
				return ActSkip, err
			}
			if err := e.Vault.Write(p, dataR, r.Mtime); err != nil {
				return ActSkip, err
			}
			next.Files[p] = FileState{LocalMtime: r.Mtime.Unix(), RemoteMtime: r.Mtime.Unix(), Size: r.Size, Hash: util.SHA256Bytes(dataR)}
		}
		return ActConflictNewer, nil
	}
	return ActSkip, nil
}

func conflictName(p string) string {
	ext := filepath.Ext(p)
	stem := strings.TrimSuffix(p, ext)
	return fmt.Sprintf("%s.conflict-%s%s", stem, time.Now().UTC().Format("20060102-150405"), ext)
}
