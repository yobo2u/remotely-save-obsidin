package app

import (
	"context"
	"fmt"
	"time"

	"github.com/yobo2u/remotely-save-obsidin/vaultsync/internal/config"
	"github.com/yobo2u/remotely-save-obsidin/vaultsync/internal/local"
	"github.com/yobo2u/remotely-save-obsidin/vaultsync/internal/remote"
	"github.com/yobo2u/remotely-save-obsidin/vaultsync/internal/syncer"
	"golang.org/x/oauth2"
)

type MultiResult struct {
	OK      bool                      `json:"ok"`
	Results map[string]*syncer.Result `json:"results"`
	Errors  []string                  `json:"errors,omitempty"`
}

func BuildRemote(ctx context.Context, cfg *config.Config, kind config.RemoteKind) (remote.Remote, error) {
	if kind == "" {
		kind = cfg.Remote
	}
	switch kind {
	case config.RemoteSynology:
		s := cfg.Synology
		if s.Host == "" || s.Username == "" {
			return nil, fmt.Errorf("synology is not configured; run: vaultsync setup synology")
		}
		if s.UseWebDAV {
			scheme := "https"
			port := s.WebDAVPort
			if port == 0 {
				port = 5006
			}
			if !s.HTTPS && (port == 5005 || port == 5000) {
				scheme = "http"
			}
			addr := fmt.Sprintf("%s://%s:%d", scheme, s.Host, port)
			return remote.NewWebDAV(addr, s.Username, s.Password, s.RemoteDir, s.InsecureTLS), nil
		}
		return remote.NewSynology(s.Host, s.Port, s.HTTPS, s.InsecureTLS, s.Username, s.Password, s.RemoteDir), nil
	case config.RemoteGDrive:
		g := cfg.Google
		if g.ClientID == "" || g.RefreshToken == "" {
			return nil, fmt.Errorf("google drive is not configured; run: vaultsync setup google")
		}
		oc := remote.GoogleOAuthConfig(g.ClientID, g.ClientSecret, g.RedirectURL)
		tok := &oauth2.Token{
			RefreshToken: g.RefreshToken,
			AccessToken:  g.AccessToken,
			Expiry:       config.TokenExpiry(g.Expiry),
		}
		ts := oc.TokenSource(ctx, tok)
		return remote.NewGDrive(ctx, ts, g.RemoteDir), nil
	case config.RemoteWebDAV:
		w := cfg.WebDAV
		if w.Address == "" {
			return nil, fmt.Errorf("webdav address is empty")
		}
		return remote.NewWebDAV(w.Address, w.Username, w.Password, w.BaseDir, true), nil
	default:
		return nil, fmt.Errorf("no remote configured; run vaultsync setup google or vaultsync setup synology")
	}
}

func SyncOnce(ctx context.Context, cfg *config.Config) (*MultiResult, error) {
	kinds := cfg.ActiveRemotes()
	if len(kinds) == 0 {
		return nil, fmt.Errorf("no remote configured; run vaultsync setup google or vaultsync setup synology")
	}
	out := &MultiResult{OK: true, Results: map[string]*syncer.Result{}}
	for _, kind := range kinds {
		r, err := BuildRemote(ctx, cfg, kind)
		if err != nil {
			out.OK = false
			out.Errors = append(out.Errors, string(kind)+": "+err.Error())
			continue
		}
		eng := &syncer.Engine{
			Vault: local.Vault{
				Root:              cfg.VaultPath,
				IgnoreDotObsidian: cfg.IgnoreDotObsidian,
			},
			Remote:    r,
			StatePath: config.StatePath(cfg.VaultPath, kind),
			Conflict:  cfg.Conflict,
		}
		start := time.Now()
		res, err := eng.Run(ctx)
		if res == nil {
			res = &syncer.Result{}
		}
		res.ElapsedMS = time.Since(start).Milliseconds()
		out.Results[string(kind)] = res
		if err != nil {
			out.OK = false
			out.Errors = append(out.Errors, string(kind)+": "+err.Error())
		}
	}
	if !out.OK {
		return out, fmt.Errorf("%s", joinErrors(out.Errors))
	}
	return out, nil
}

func joinErrors(errs []string) string {
	if len(errs) == 0 {
		return "sync failed"
	}
	out := errs[0]
	for i := 1; i < len(errs); i++ {
		out += "; " + errs[i]
	}
	return out
}
