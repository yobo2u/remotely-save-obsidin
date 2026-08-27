package serve

import (
	"context"
	"encoding/json"
	"log"
	"net/http"
	"sync"
	"time"

	"github.com/yobo2u/remotely-save-obsidin/vaultsync/internal/app"
	"github.com/yobo2u/remotely-save-obsidin/vaultsync/internal/config"
)

func Run(ctx context.Context, cfg *config.Config) error {
	var mu sync.Mutex
	busy := false
	mux := http.NewServeMux()
	mux.HandleFunc("/health", func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		_ = json.NewEncoder(w).Encode(map[string]any{
			"ok":     true,
			"vault":  cfg.VaultPath,
			"remote": cfg.Remote,
		})
	})
	mux.HandleFunc("/sync", func(w http.ResponseWriter, r *http.Request) {
		if r.Method != http.MethodPost && r.Method != http.MethodGet {
			http.Error(w, "method not allowed", http.StatusMethodNotAllowed)
			return
		}
		mu.Lock()
		if busy {
			mu.Unlock()
			http.Error(w, "sync already running", http.StatusConflict)
			return
		}
		busy = true
		mu.Unlock()
		defer func() {
			mu.Lock()
			busy = false
			mu.Unlock()
		}()
		res, err := app.SyncOnce(r.Context(), cfg)
		w.Header().Set("Content-Type", "application/json")
		if err != nil {
			w.WriteHeader(http.StatusBadGateway)
			_ = json.NewEncoder(w).Encode(map[string]any{"ok": false, "error": err.Error(), "result": res})
			return
		}
		_ = json.NewEncoder(w).Encode(map[string]any{"ok": true, "result": res})
	})
	mux.HandleFunc("/config", func(w http.ResponseWriter, r *http.Request) {
		safe := *cfg
		safe.Synology.Password = ""
		safe.Google.ClientSecret = ""
		safe.Google.RefreshToken = ""
		safe.Google.AccessToken = ""
		safe.WebDAV.Password = ""
		w.Header().Set("Content-Type", "application/json")
		_ = json.NewEncoder(w).Encode(safe)
	})

	srv := &http.Server{Addr: cfg.Listen, Handler: withCORS(mux)}
	go func() {
		<-ctx.Done()
		c, cancel := context.WithTimeout(context.Background(), 2*time.Second)
		defer cancel()
		_ = srv.Shutdown(c)
	}()
	log.Printf("vaultsync listening on http://%s (vault=%s remote=%s)", cfg.Listen, cfg.VaultPath, cfg.Remote)
	err := srv.ListenAndServe()
	if err == http.ErrServerClosed {
		return nil
	}
	return err
}

func withCORS(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Access-Control-Allow-Origin", "*")
		w.Header().Set("Access-Control-Allow-Headers", "*")
		w.Header().Set("Access-Control-Allow-Methods", "GET,POST,OPTIONS")
		if r.Method == http.MethodOptions {
			w.WriteHeader(http.StatusNoContent)
			return
		}
		next.ServeHTTP(w, r)
	})
}
