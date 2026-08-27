package remote

import (
	"bytes"
	"context"
	"crypto/tls"
	"encoding/json"
	"fmt"
	"io"
	"mime/multipart"
	"net/http"
	"net/url"
	"path"
	"strings"
	"time"
)

// Synology talks to DSM File Station. This is the default NAS backend because
// every DSM has File Station; WebDAV Server is an extra package.
type Synology struct {
	BaseURL    string
	Username   string
	Password   string
	RemoteDir  string // absolute DSM path, e.g. /home/MyVault
	HTTPClient *http.Client
	sid        string
}

func NewSynology(host string, port int, https, insecure bool, user, pass, remoteDir string) *Synology {
	scheme := "http"
	if https {
		scheme = "https"
	}
	if port == 0 {
		if https {
			port = 5001
		} else {
			port = 5000
		}
	}
	tr := &http.Transport{
		TLSClientConfig: &tls.Config{InsecureSkipVerify: insecure}, //nolint:gosec
	}
	return &Synology{
		BaseURL:    fmt.Sprintf("%s://%s:%d", scheme, host, port),
		Username:   user,
		Password:   pass,
		RemoteDir:  strings.TrimSuffix(remoteDir, "/"),
		HTTPClient: &http.Client{Timeout: 60 * time.Second, Transport: tr},
	}
}

func (s *Synology) Kind() string { return "synology" }

func (s *Synology) login(ctx context.Context) error {
	if s.sid != "" {
		return nil
	}
	q := url.Values{
		"api":     {"SYNO.API.Auth"},
		"version": {"3"},
		"method":  {"login"},
		"account": {s.Username},
		"passwd":  {s.Password},
		"session": {"FileStation"},
		"format":  {"sid"},
	}
	var resp struct {
		Success bool `json:"success"`
		Data    struct {
			Sid string `json:"sid"`
		} `json:"data"`
		Error struct {
			Code int `json:"code"`
		} `json:"error"`
	}
	if err := s.getJSON(ctx, "/webapi/auth.cgi?"+q.Encode(), &resp); err != nil {
		return err
	}
	if !resp.Success || resp.Data.Sid == "" {
		return fmt.Errorf("synology login failed, code=%d", resp.Error.Code)
	}
	s.sid = resp.Data.Sid
	return nil
}

func (s *Synology) getJSON(ctx context.Context, rel string, dest any) error {
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, s.BaseURL+rel, nil)
	if err != nil {
		return err
	}
	rsp, err := s.HTTPClient.Do(req)
	if err != nil {
		return err
	}
	defer rsp.Body.Close()
	b, err := io.ReadAll(rsp.Body)
	if err != nil {
		return err
	}
	if rsp.StatusCode >= 400 {
		return fmt.Errorf("synology HTTP %d: %s", rsp.StatusCode, truncate(b))
	}
	return json.Unmarshal(b, dest)
}

type fsFile struct {
	Path  string `json:"path"`
	Name  string `json:"name"`
	IsDir bool   `json:"isdir"`
	Extra struct {
		Size int64 `json:"size"`
		Time struct {
			Atime  int64 `json:"atime"`
			Mtime  int64 `json:"mtime"`
			Ctime  int64 `json:"ctime"`
			Crtime int64 `json:"crtime"`
		} `json:"time"`
	} `json:"additional"`
}

func (s *Synology) List(ctx context.Context) ([]FileInfo, error) {
	if err := s.login(ctx); err != nil {
		return nil, err
	}
	if err := s.ensureRemoteDir(ctx); err != nil {
		return nil, err
	}
	var out []FileInfo
	var walk func(folder string) error
	walk = func(folder string) error {
		files, err := s.listFolder(ctx, folder)
		if err != nil {
			return err
		}
		for _, f := range files {
			rel := strings.TrimPrefix(f.Path, s.RemoteDir)
			rel = strings.TrimPrefix(rel, "/")
			if rel == "" {
				continue
			}
			mtime := f.Extra.Time.Mtime
			if mtime == 0 {
				mtime = f.Extra.Time.Ctime
			}
			info := FileInfo{
				RelPath: rel,
				Size:    f.Extra.Size,
				Mtime:   time.Unix(mtime, 0).UTC(),
				IsDir:   f.IsDir,
			}
			if f.IsDir {
				info.RelPath = rel + "/"
				info.Size = 0
				out = append(out, info)
				if err := walk(f.Path); err != nil {
					return err
				}
				continue
			}
			out = append(out, info)
		}
		return nil
	}
	if err := walk(s.RemoteDir); err != nil {
		return nil, err
	}
	return out, nil
}

func (s *Synology) listFolder(ctx context.Context, folder string) ([]fsFile, error) {
	q := url.Values{
		"api":         {"SYNO.FileStation.List"},
		"version":     {"2"},
		"method":      {"list"},
		"folder_path": {folder},
		"additional":  {`["size","time"]`},
		"_sid":        {s.sid},
	}
	var resp struct {
		Success bool `json:"success"`
		Data    struct {
			Files []fsFile `json:"files"`
		} `json:"data"`
		Error struct {
			Code int `json:"code"`
		} `json:"error"`
	}
	if err := s.getJSON(ctx, "/webapi/entry.cgi?"+q.Encode(), &resp); err != nil {
		return nil, err
	}
	if !resp.Success {
		return nil, fmt.Errorf("FileStation.List failed, code=%d", resp.Error.Code)
	}
	return resp.Data.Files, nil
}

func (s *Synology) Read(ctx context.Context, relPath string) ([]byte, error) {
	if err := s.login(ctx); err != nil {
		return nil, err
	}
	full := s.fullPath(relPath)
	q := url.Values{
		"api":     {"SYNO.FileStation.Download"},
		"version": {"2"},
		"method":  {"download"},
		"path":    {full},
		"mode":    {"download"},
		"_sid":    {s.sid},
	}
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, s.BaseURL+"/webapi/entry.cgi?"+q.Encode(), nil)
	if err != nil {
		return nil, err
	}
	rsp, err := s.HTTPClient.Do(req)
	if err != nil {
		return nil, err
	}
	defer rsp.Body.Close()
	if rsp.StatusCode >= 400 {
		b, _ := io.ReadAll(rsp.Body)
		return nil, fmt.Errorf("download HTTP %d: %s", rsp.StatusCode, truncate(b))
	}
	return io.ReadAll(rsp.Body)
}

func (s *Synology) Write(ctx context.Context, relPath string, data []byte, mtime time.Time) error {
	if err := s.login(ctx); err != nil {
		return err
	}
	full := s.fullPath(relPath)
	parent := path.Dir(full)
	if err := s.ensureDir(ctx, parent); err != nil {
		return err
	}
	var body bytes.Buffer
	w := multipart.NewWriter(&body)
	_ = w.WriteField("api", "SYNO.FileStation.Upload")
	_ = w.WriteField("version", "2")
	_ = w.WriteField("method", "upload")
	_ = w.WriteField("path", parent)
	_ = w.WriteField("overwrite", "true")
	_ = w.WriteField("create_parents", "true")
	part, err := w.CreateFormFile("file", path.Base(full))
	if err != nil {
		return err
	}
	if _, err := part.Write(data); err != nil {
		return err
	}
	if err := w.Close(); err != nil {
		return err
	}
	req, err := http.NewRequestWithContext(ctx, http.MethodPost, s.BaseURL+"/webapi/entry.cgi?_sid="+url.QueryEscape(s.sid), &body)
	if err != nil {
		return err
	}
	req.Header.Set("Content-Type", w.FormDataContentType())
	rsp, err := s.HTTPClient.Do(req)
	if err != nil {
		return err
	}
	defer rsp.Body.Close()
	b, _ := io.ReadAll(rsp.Body)
	var resp struct {
		Success bool `json:"success"`
		Error   struct {
			Code int `json:"code"`
		} `json:"error"`
	}
	_ = json.Unmarshal(b, &resp)
	if rsp.StatusCode >= 400 || !resp.Success {
		return fmt.Errorf("upload failed HTTP %d code=%d body=%s", rsp.StatusCode, resp.Error.Code, truncate(b))
	}
	_ = mtime
	return nil
}

func (s *Synology) Mkdir(ctx context.Context, relPath string) error {
	if err := s.login(ctx); err != nil {
		return err
	}
	return s.ensureDir(ctx, s.fullPath(relPath))
}

func (s *Synology) Remove(ctx context.Context, relPath string) error {
	if err := s.login(ctx); err != nil {
		return err
	}
	q := url.Values{
		"api":     {"SYNO.FileStation.Delete"},
		"version": {"2"},
		"method":  {"delete"},
		"path":    {fmt.Sprintf(`["%s"]`, s.fullPath(relPath))},
		"_sid":    {s.sid},
	}
	var resp struct {
		Success bool `json:"success"`
		Error   struct {
			Code int `json:"code"`
		} `json:"error"`
	}
	if err := s.getJSON(ctx, "/webapi/entry.cgi?"+q.Encode(), &resp); err != nil {
		return err
	}
	if !resp.Success {
		return fmt.Errorf("delete failed, code=%d", resp.Error.Code)
	}
	return nil
}

func (s *Synology) ListShares(ctx context.Context) ([]string, error) {
	if err := s.login(ctx); err != nil {
		return nil, err
	}
	q := url.Values{
		"api":     {"SYNO.FileStation.List"},
		"version": {"2"},
		"method":  {"list_share"},
		"_sid":    {s.sid},
	}
	var resp struct {
		Success bool `json:"success"`
		Data    struct {
			Shares []struct {
				Path  string `json:"path"`
				Name  string `json:"name"`
				IsDir bool   `json:"isdir"`
			} `json:"shares"`
		} `json:"data"`
	}
	if err := s.getJSON(ctx, "/webapi/entry.cgi?"+q.Encode(), &resp); err != nil {
		return nil, err
	}
	if !resp.Success {
		return nil, fmt.Errorf("list_share failed")
	}
	var names []string
	for _, sh := range resp.Data.Shares {
		names = append(names, sh.Path)
	}
	return names, nil
}

func (s *Synology) ensureRemoteDir(ctx context.Context) error {
	return s.ensureDir(ctx, s.RemoteDir)
}

func (s *Synology) ensureDir(ctx context.Context, folder string) error {
	folder = strings.TrimSuffix(folder, "/")
	if folder == "" || folder == "/" {
		return nil
	}
	// Create from the first share downward.
	parts := strings.Split(strings.TrimPrefix(folder, "/"), "/")
	if len(parts) == 0 {
		return nil
	}
	cur := "/" + parts[0]
	for i := 1; i < len(parts); i++ {
		parent := cur
		name := parts[i]
		cur = parent + "/" + name
		q := url.Values{
			"api":          {"SYNO.FileStation.CreateFolder"},
			"version":      {"2"},
			"method":       {"create"},
			"folder_path":  {parent},
			"name":         {name},
			"force_parent": {"true"},
			"_sid":         {s.sid},
		}
		var resp struct {
			Success bool `json:"success"`
			Error   struct {
				Code int `json:"code"`
			} `json:"error"`
		}
		if err := s.getJSON(ctx, "/webapi/entry.cgi?"+q.Encode(), &resp); err != nil {
			return err
		}
		// 414 / already exists codes vary; treat success or existing as ok.
		if !resp.Success && resp.Error.Code != 414 && resp.Error.Code != 1100 && resp.Error.Code != 119 {
			// keep going if list succeeds
			if _, err := s.listFolder(ctx, cur); err == nil {
				continue
			}
			return fmt.Errorf("create folder %s failed, code=%d", cur, resp.Error.Code)
		}
	}
	return nil
}

func (s *Synology) fullPath(rel string) string {
	rel = strings.TrimPrefix(strings.ReplaceAll(rel, "\\", "/"), "/")
	rel = strings.TrimSuffix(rel, "/")
	if rel == "" {
		return s.RemoteDir
	}
	return s.RemoteDir + "/" + rel
}

func truncate(b []byte) string {
	if len(b) > 240 {
		return string(b[:240])
	}
	return string(b)
}
