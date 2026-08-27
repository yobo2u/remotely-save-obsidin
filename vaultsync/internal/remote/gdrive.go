package remote

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"io"
	"mime/multipart"
	"net/http"
	"net/textproto"
	"net/url"
	"path"
	"strings"
	"time"

	"golang.org/x/oauth2"
	"golang.org/x/oauth2/google"
)

const driveFileScope = "https://www.googleapis.com/auth/drive.file"
const folderMIME = "application/vnd.google-apps.folder"

func GoogleOAuthConfig(clientID, clientSecret, redirectURL string) *oauth2.Config {
	return &oauth2.Config{
		ClientID:     clientID,
		ClientSecret: clientSecret,
		RedirectURL:  redirectURL,
		Scopes:       []string{driveFileScope},
		Endpoint:     google.Endpoint,
	}
}

type GDrive struct {
	HTTP      *http.Client
	RemoteDir string
	rootID    string
	idByPath  map[string]string
}

func NewGDrive(ctx context.Context, ts oauth2.TokenSource, remoteDir string) *GDrive {
	return &GDrive{
		HTTP:      oauth2.NewClient(ctx, ts),
		RemoteDir: strings.Trim(remoteDir, "/"),
		idByPath:  map[string]string{},
	}
}

func (g *GDrive) Kind() string { return "gdrive" }

type driveFile struct {
	ID           string   `json:"id"`
	Name         string   `json:"name"`
	MimeType     string   `json:"mimeType"`
	ModifiedTime string   `json:"modifiedTime"`
	CreatedTime  string   `json:"createdTime"`
	Size         string   `json:"size"`
	Parents      []string `json:"parents"`
	Md5          string   `json:"md5Checksum"`
}

func (g *GDrive) List(ctx context.Context) ([]FileInfo, error) {
	if err := g.ensureRoot(ctx); err != nil {
		return nil, err
	}
	g.idByPath = map[string]string{"": g.rootID, "/": g.rootID}
	var out []FileInfo
	var walk func(parentID, prefix string) error
	walk = func(parentID, prefix string) error {
		files, err := g.listChildren(ctx, parentID)
		if err != nil {
			return err
		}
		for _, f := range files {
			rel := f.Name
			if prefix != "" {
				rel = prefix + f.Name
			}
			isDir := f.MimeType == folderMIME
			if strings.HasPrefix(f.MimeType, "application/vnd.google-apps.") && !isDir {
				continue
			}
			mtime := time.Now().UTC()
			if f.ModifiedTime != "" {
				if t, err := time.Parse(time.RFC3339, f.ModifiedTime); err == nil {
					mtime = t.UTC()
				}
			}
			var size int64
			if f.Size != "" {
				fmt.Sscan(f.Size, &size)
			}
			info := FileInfo{RelPath: rel, Size: size, Mtime: mtime, IsDir: isDir}
			if isDir {
				info.RelPath = rel + "/"
				info.Size = 0
				g.idByPath[info.RelPath] = f.ID
				g.idByPath[rel] = f.ID
				out = append(out, info)
				if err := walk(f.ID, info.RelPath); err != nil {
					return err
				}
				continue
			}
			g.idByPath[rel] = f.ID
			out = append(out, info)
		}
		return nil
	}
	if err := walk(g.rootID, ""); err != nil {
		return nil, err
	}
	return out, nil
}

func (g *GDrive) Read(ctx context.Context, relPath string) ([]byte, error) {
	if err := g.ensureRoot(ctx); err != nil {
		return nil, err
	}
	id, err := g.idOf(ctx, relPath)
	if err != nil {
		return nil, err
	}
	req, err := http.NewRequestWithContext(ctx, http.MethodGet,
		"https://www.googleapis.com/drive/v3/files/"+url.PathEscape(id)+"?alt=media", nil)
	if err != nil {
		return nil, err
	}
	rsp, err := g.HTTP.Do(req)
	if err != nil {
		return nil, err
	}
	defer rsp.Body.Close()
	if rsp.StatusCode >= 400 {
		b, _ := io.ReadAll(rsp.Body)
		return nil, fmt.Errorf("gdrive download %d: %s", rsp.StatusCode, truncate(b))
	}
	return io.ReadAll(rsp.Body)
}

func (g *GDrive) Write(ctx context.Context, relPath string, data []byte, mtime time.Time) error {
	if err := g.ensureRoot(ctx); err != nil {
		return err
	}
	parent, name := splitParent(relPath)
	parentID, err := g.ensureFolder(ctx, parent)
	if err != nil {
		return err
	}
	existing, _ := g.findChild(ctx, parentID, name, false)
	meta := map[string]any{
		"name":         name,
		"modifiedTime": mtime.UTC().Format(time.RFC3339Nano),
	}
	method := http.MethodPost
	uploadURL := "https://www.googleapis.com/upload/drive/v3/files?uploadType=multipart&fields=id,name,modifiedTime,size"
	if existing != nil {
		method = http.MethodPatch
		uploadURL = "https://www.googleapis.com/upload/drive/v3/files/" + url.PathEscape(existing.ID) + "?uploadType=multipart&fields=id,name,modifiedTime,size"
	} else {
		meta["parents"] = []string{parentID}
	}
	var body bytes.Buffer
	w := multipart.NewWriter(&body)
	mw, err := w.CreatePart(textproto.MIMEHeader{"Content-Type": {"application/json; charset=UTF-8"}})
	if err != nil {
		return err
	}
	enc, _ := json.Marshal(meta)
	if _, err := mw.Write(enc); err != nil {
		return err
	}
	fw, err := w.CreatePart(textproto.MIMEHeader{"Content-Type": {"application/octet-stream"}})
	if err != nil {
		return err
	}
	if _, err := fw.Write(data); err != nil {
		return err
	}
	if err := w.Close(); err != nil {
		return err
	}
	req, err := http.NewRequestWithContext(ctx, method, uploadURL, &body)
	if err != nil {
		return err
	}
	req.Header.Set("Content-Type", w.FormDataContentType())
	rsp, err := g.HTTP.Do(req)
	if err != nil {
		return err
	}
	defer rsp.Body.Close()
	b, _ := io.ReadAll(rsp.Body)
	if rsp.StatusCode >= 400 {
		return fmt.Errorf("gdrive upload %d: %s", rsp.StatusCode, truncate(b))
	}
	var created driveFile
	_ = json.Unmarshal(b, &created)
	if created.ID != "" {
		g.idByPath[relPath] = created.ID
	}
	return nil
}

func (g *GDrive) Mkdir(ctx context.Context, relPath string) error {
	_, err := g.ensureFolder(ctx, relPath)
	return err
}

func (g *GDrive) Remove(ctx context.Context, relPath string) error {
	id, err := g.idOf(ctx, relPath)
	if err != nil {
		return err
	}
	req, err := http.NewRequestWithContext(ctx, http.MethodDelete,
		"https://www.googleapis.com/drive/v3/files/"+url.PathEscape(id), nil)
	if err != nil {
		return err
	}
	rsp, err := g.HTTP.Do(req)
	if err != nil {
		return err
	}
	defer rsp.Body.Close()
	if rsp.StatusCode >= 400 && rsp.StatusCode != 404 {
		b, _ := io.ReadAll(rsp.Body)
		return fmt.Errorf("gdrive delete %d: %s", rsp.StatusCode, truncate(b))
	}
	delete(g.idByPath, relPath)
	return nil
}

func (g *GDrive) ensureRoot(ctx context.Context) error {
	if g.rootID != "" {
		return nil
	}
	name := g.RemoteDir
	if name == "" {
		name = "ObsidianVault"
	}
	found, err := g.findChild(ctx, "root", name, true)
	if err != nil {
		return err
	}
	if found != nil {
		g.rootID = found.ID
		return nil
	}
	id, err := g.createFolder(ctx, name, "root")
	if err != nil {
		return err
	}
	g.rootID = id
	return nil
}

func (g *GDrive) ensureFolder(ctx context.Context, rel string) (string, error) {
	if err := g.ensureRoot(ctx); err != nil {
		return "", err
	}
	rel = strings.Trim(strings.ReplaceAll(rel, "\\", "/"), "/")
	if rel == "" {
		return g.rootID, nil
	}
	parent := g.rootID
	acc := ""
	for _, seg := range strings.Split(rel, "/") {
		if seg == "" {
			continue
		}
		if acc == "" {
			acc = seg + "/"
		} else {
			acc = acc + seg + "/"
		}
		if id, ok := g.idByPath[acc]; ok {
			parent = id
			continue
		}
		found, err := g.findChild(ctx, parent, seg, true)
		if err != nil {
			return "", err
		}
		if found == nil {
			id, err := g.createFolder(ctx, seg, parent)
			if err != nil {
				return "", err
			}
			parent = id
		} else {
			parent = found.ID
		}
		g.idByPath[acc] = parent
	}
	return parent, nil
}

func (g *GDrive) idOf(ctx context.Context, relPath string) (string, error) {
	relPath = strings.TrimPrefix(relPath, "/")
	if id, ok := g.idByPath[relPath]; ok {
		return id, nil
	}
	if _, err := g.List(ctx); err != nil {
		return "", err
	}
	if id, ok := g.idByPath[relPath]; ok {
		return id, nil
	}
	return "", fmt.Errorf("gdrive path not found: %s", relPath)
}

func (g *GDrive) listChildren(ctx context.Context, parentID string) ([]driveFile, error) {
	q := fmt.Sprintf("'%s' in parents and trashed = false", parentID)
	u := "https://www.googleapis.com/drive/v3/files?" + url.Values{
		"q":        {q},
		"fields":   {"nextPageToken,files(id,name,mimeType,modifiedTime,size,parents,md5Checksum)"},
		"pageSize": {"1000"},
		"spaces":   {"drive"},
	}.Encode()
	var all []driveFile
	for u != "" {
		req, err := http.NewRequestWithContext(ctx, http.MethodGet, u, nil)
		if err != nil {
			return nil, err
		}
		rsp, err := g.HTTP.Do(req)
		if err != nil {
			return nil, err
		}
		b, _ := io.ReadAll(rsp.Body)
		rsp.Body.Close()
		if rsp.StatusCode >= 400 {
			return nil, fmt.Errorf("gdrive list %d: %s", rsp.StatusCode, truncate(b))
		}
		var parsed struct {
			Files         []driveFile `json:"files"`
			NextPageToken string      `json:"nextPageToken"`
		}
		if err := json.Unmarshal(b, &parsed); err != nil {
			return nil, err
		}
		all = append(all, parsed.Files...)
		if parsed.NextPageToken == "" {
			break
		}
		u = "https://www.googleapis.com/drive/v3/files?" + url.Values{
			"q":         {q},
			"fields":    {"nextPageToken,files(id,name,mimeType,modifiedTime,size,parents,md5Checksum)"},
			"pageSize":  {"1000"},
			"pageToken": {parsed.NextPageToken},
		}.Encode()
	}
	return all, nil
}

func (g *GDrive) findChild(ctx context.Context, parentID, name string, folder bool) (*driveFile, error) {
	mime := fmt.Sprintf("mimeType != '%s'", folderMIME)
	if folder {
		mime = fmt.Sprintf("mimeType = '%s'", folderMIME)
	}
	esc := strings.ReplaceAll(strings.ReplaceAll(name, `\`, `\\`), `'`, `\'`)
	q := fmt.Sprintf("'%s' in parents and name = '%s' and %s and trashed = false", parentID, esc, mime)
	u := "https://www.googleapis.com/drive/v3/files?" + url.Values{
		"q":      {q},
		"fields": {"files(id,name,mimeType,modifiedTime,size)"},
	}.Encode()
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, u, nil)
	if err != nil {
		return nil, err
	}
	rsp, err := g.HTTP.Do(req)
	if err != nil {
		return nil, err
	}
	defer rsp.Body.Close()
	b, _ := io.ReadAll(rsp.Body)
	if rsp.StatusCode >= 400 {
		return nil, fmt.Errorf("gdrive find %d: %s", rsp.StatusCode, truncate(b))
	}
	var parsed struct {
		Files []driveFile `json:"files"`
	}
	if err := json.Unmarshal(b, &parsed); err != nil {
		return nil, err
	}
	if len(parsed.Files) == 0 {
		return nil, nil
	}
	return &parsed.Files[0], nil
}

func (g *GDrive) createFolder(ctx context.Context, name, parentID string) (string, error) {
	payload, _ := json.Marshal(map[string]any{
		"name":     name,
		"mimeType": folderMIME,
		"parents":  []string{parentID},
	})
	req, err := http.NewRequestWithContext(ctx, http.MethodPost,
		"https://www.googleapis.com/drive/v3/files?fields=id", bytes.NewReader(payload))
	if err != nil {
		return "", err
	}
	req.Header.Set("Content-Type", "application/json")
	rsp, err := g.HTTP.Do(req)
	if err != nil {
		return "", err
	}
	defer rsp.Body.Close()
	b, _ := io.ReadAll(rsp.Body)
	if rsp.StatusCode >= 400 {
		return "", fmt.Errorf("gdrive mkdir %d: %s", rsp.StatusCode, truncate(b))
	}
	var created driveFile
	if err := json.Unmarshal(b, &created); err != nil {
		return "", err
	}
	return created.ID, nil
}

func splitParent(rel string) (parent, name string) {
	rel = strings.Trim(strings.ReplaceAll(rel, "\\", "/"), "/")
	parent = path.Dir(rel)
	name = path.Base(rel)
	if parent == "." {
		parent = ""
	}
	return parent, name
}
