package setup

import (
	"context"
	"crypto/rand"
	"encoding/base64"
	"fmt"
	"net"
	"net/http"
	"os/exec"
	"path/filepath"
	"runtime"
	"time"

	"github.com/yobo2u/remotely-save-obsidin/vaultsync/internal/config"
	"github.com/yobo2u/remotely-save-obsidin/vaultsync/internal/remote"
	"golang.org/x/oauth2"
)

func OpenBrowser(url string) {
	var cmd *exec.Cmd
	switch runtime.GOOS {
	case "darwin":
		cmd = exec.Command("open", url)
	case "windows":
		cmd = exec.Command("rundll32", "url.dll,FileProtocolHandler", url)
	default:
		cmd = exec.Command("xdg-open", url)
	}
	_ = cmd.Start()
}

func GoogleWizardURLs() []string {
	return []string{
		"https://console.cloud.google.com/apis/library/drive.googleapis.com",
		"https://console.cloud.google.com/apis/credentials",
	}
}

func SetupGoogle(ctx context.Context, cfg *config.Config, clientID, clientSecret string, openBrowser bool) error {
	if clientID == "" {
		clientID = cfg.Google.ClientID
	}
	if clientSecret == "" {
		clientSecret = cfg.Google.ClientSecret
	}
	if clientID == "" {
		return fmt.Errorf("missing Google OAuth client ID. Create a Desktop OAuth client in Google Cloud, enable Drive API, then rerun: vaultsync setup google --client-id YOUR_ID\nOpen:\n  %s\n  %s", GoogleWizardURLs()[0], GoogleWizardURLs()[1])
	}
	ln, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		return err
	}
	port := ln.Addr().(*net.TCPAddr).Port
	redirect := fmt.Sprintf("http://127.0.0.1:%d/callback", port)
	oc := remote.GoogleOAuthConfig(clientID, clientSecret, redirect)
	state := randomString(16)
	verifier := oauth2.GenerateVerifier()
	codeCh := make(chan string, 1)
	errCh := make(chan error, 1)
	mux := http.NewServeMux()
	mux.HandleFunc("/callback", func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Query().Get("state") != state {
			http.Error(w, "state mismatch", http.StatusBadRequest)
			errCh <- fmt.Errorf("oauth state mismatch")
			return
		}
		if e := r.URL.Query().Get("error"); e != "" {
			http.Error(w, e, http.StatusBadRequest)
			errCh <- fmt.Errorf("oauth error: %s", e)
			return
		}
		code := r.URL.Query().Get("code")
		if code == "" {
			http.Error(w, "missing code", http.StatusBadRequest)
			errCh <- fmt.Errorf("missing oauth code")
			return
		}
		fmt.Fprint(w, "Google authorization complete. You can close this tab and return to vaultsync.")
		codeCh <- code
	})
	srv := &http.Server{Handler: mux}
	go func() { _ = srv.Serve(ln) }()
	defer func() {
		cctx, cancel := context.WithTimeout(context.Background(), time.Second)
		defer cancel()
		_ = srv.Shutdown(cctx)
	}()

	authURL := oc.AuthCodeURL(state,
		oauth2.AccessTypeOffline,
		oauth2.SetAuthURLParam("prompt", "consent"),
		oauth2.S256ChallengeOption(verifier),
	)
	fmt.Println("Open this URL to authorize Google Drive:")
	fmt.Println(authURL)
	if openBrowser {
		OpenBrowser(authURL)
	}
	var code string
	select {
	case <-ctx.Done():
		return ctx.Err()
	case err := <-errCh:
		return err
	case code = <-codeCh:
	case <-time.After(5 * time.Minute):
		return fmt.Errorf("timed out waiting for Google OAuth")
	}
	tok, err := oc.Exchange(ctx, code, oauth2.VerifierOption(verifier))
	if err != nil {
		return err
	}
	cfg.Google.ClientID = clientID
	cfg.Google.ClientSecret = clientSecret
	cfg.Google.RedirectURL = redirect
	cfg.Google.RefreshToken = tok.RefreshToken
	cfg.Google.AccessToken = tok.AccessToken
	if tok.RefreshToken == "" {
		return fmt.Errorf("Google did not return a refresh token; remove the app from https://myaccount.google.com/permissions and retry")
	}
	if !tok.Expiry.IsZero() {
		cfg.Google.Expiry = tok.Expiry.Format(time.RFC3339)
	}
	if cfg.Google.RemoteDir == "" {
		cfg.Google.RemoteDir = filepath.Base(cfg.VaultPath)
	}
	cfg.EnableRemote(config.RemoteGDrive)
	return nil
}

func randomString(n int) string {
	b := make([]byte, n)
	_, _ = rand.Read(b)
	return base64.RawURLEncoding.EncodeToString(b)
}
