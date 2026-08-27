package config

import (
	"encoding/json"
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"runtime"
	"time"
)

const (
	FileName      = "vaultsync.json"
	StateFileName = "vaultsync-state.json"
	DefaultPort   = 19827
)

type RemoteKind string

const (
	RemoteNone     RemoteKind = ""
	RemoteSynology RemoteKind = "synology"
	RemoteGDrive   RemoteKind = "gdrive"
	RemoteWebDAV   RemoteKind = "webdav"
	RemoteAll      RemoteKind = "all"
)

type Config struct {
	VaultPath         string         `json:"vaultPath"`
	Remote            RemoteKind     `json:"remote"`
	IgnoreDotObsidian bool           `json:"ignoreDotObsidian"`
	Conflict          string         `json:"conflict"` // keep_newer | keep_local | keep_remote
	AutoSyncSeconds   int            `json:"autoSyncSeconds"`
	Listen            string         `json:"listen"`
	Synology          SynologyConfig `json:"synology,omitempty"`
	Google            GoogleConfig   `json:"google,omitempty"`
	WebDAV            WebDAVConfig   `json:"webdav,omitempty"`
}

type SynologyConfig struct {
	Host        string `json:"host"`
	Port        int    `json:"port"`
	HTTPS       bool   `json:"https"`
	InsecureTLS bool   `json:"insecureTLS"`
	Username    string `json:"username"`
	Password    string `json:"password"`
	RemoteDir   string `json:"remoteDir"` // e.g. /home/ObsidianVault
	UseWebDAV   bool   `json:"useWebDAV"`
	WebDAVPort  int    `json:"webdavPort,omitempty"`
}

type GoogleConfig struct {
	ClientID     string `json:"clientID"`
	ClientSecret string `json:"clientSecret,omitempty"`
	RedirectURL  string `json:"redirectURL"`
	RefreshToken string `json:"refreshToken,omitempty"`
	AccessToken  string `json:"accessToken,omitempty"`
	Expiry       string `json:"expiry,omitempty"`
	RemoteDir    string `json:"remoteDir"`
}

type WebDAVConfig struct {
	Address  string `json:"address"`
	Username string `json:"username"`
	Password string `json:"password"`
	BaseDir  string `json:"baseDir"`
}

func Default(vault string) *Config {
	return &Config{
		VaultPath:         vault,
		IgnoreDotObsidian: true,
		Conflict:          "keep_newer",
		AutoSyncSeconds:   0,
		Listen:            fmt.Sprintf("127.0.0.1:%d", DefaultPort),
		Google: GoogleConfig{
			RedirectURL: "http://127.0.0.1:19828/callback",
			RemoteDir:   filepath.Base(vault),
		},
		Synology: SynologyConfig{
			HTTPS:       true,
			Port:        5001,
			InsecureTLS: true,
			WebDAVPort:  5006,
			RemoteDir:   "/" + filepath.Base(vault),
		},
	}
}

func PathForVault(vault string) string {
	return filepath.Join(vault, ".obsidian", FileName)
}

func StatePath(vault string, kind RemoteKind) string {
	if kind == "" {
		return filepath.Join(vault, ".obsidian", StateFileName)
	}
	return filepath.Join(vault, ".obsidian", "vaultsync-state-"+string(kind)+".json")
}

// EnableRemote records a configured backend. If another backend is already
// active, Remote becomes "all" so local can sync with both NAS and Drive.
func (c *Config) EnableRemote(kind RemoteKind) {
	if c.Remote == "" || c.Remote == kind {
		c.Remote = kind
		return
	}
	c.Remote = RemoteAll
}

func (c *Config) ActiveRemotes() []RemoteKind {
	switch c.Remote {
	case RemoteAll:
		var out []RemoteKind
		if c.Synology.Host != "" && c.Synology.Username != "" {
			out = append(out, RemoteSynology)
		}
		if c.Google.ClientID != "" && c.Google.RefreshToken != "" {
			out = append(out, RemoteGDrive)
		}
		if c.WebDAV.Address != "" {
			out = append(out, RemoteWebDAV)
		}
		return out
	case RemoteSynology, RemoteGDrive, RemoteWebDAV:
		return []RemoteKind{c.Remote}
	default:
		return nil
	}
}

func Load(path string) (*Config, error) {
	b, err := os.ReadFile(path)
	if err != nil {
		return nil, err
	}
	cfg := &Config{}
	if err := json.Unmarshal(b, cfg); err != nil {
		return nil, err
	}
	if cfg.Conflict == "" {
		cfg.Conflict = "keep_newer"
	}
	if cfg.Listen == "" {
		cfg.Listen = fmt.Sprintf("127.0.0.1:%d", DefaultPort)
	}
	return cfg, nil
}

func (c *Config) Save(path string) error {
	if err := os.MkdirAll(filepath.Dir(path), 0o755); err != nil {
		return err
	}
	b, err := json.MarshalIndent(c, "", "  ")
	if err != nil {
		return err
	}
	return os.WriteFile(path, b, 0o600)
}

func FindVault(flagVault string) (string, error) {
	if flagVault != "" {
		return filepath.Abs(flagVault)
	}
	if v := os.Getenv("OBSIDIAN_VAULT"); v != "" {
		return filepath.Abs(v)
	}
	wd, err := os.Getwd()
	if err != nil {
		return "", err
	}
	dir := wd
	for {
		if _, err := os.Stat(filepath.Join(dir, ".obsidian")); err == nil {
			return dir, nil
		}
		parent := filepath.Dir(dir)
		if parent == dir {
			break
		}
		dir = parent
	}
	return "", errors.New("vault not found: pass --vault or run inside an Obsidian vault")
}

func TokenExpiry(s string) time.Time {
	if s == "" {
		return time.Time{}
	}
	t, err := time.Parse(time.RFC3339, s)
	if err != nil {
		return time.Time{}
	}
	return t
}

func OSOpenHint() string {
	switch runtime.GOOS {
	case "darwin":
		return "open"
	case "windows":
		return "start"
	default:
		return "xdg-open"
	}
}
