package watch

import (
	"context"
	"io/fs"
	"log"
	"path/filepath"
	"time"

	"github.com/fsnotify/fsnotify"
	"github.com/yobo2u/remotely-save-obsidin/vaultsync/internal/app"
	"github.com/yobo2u/remotely-save-obsidin/vaultsync/internal/config"
)

func Run(ctx context.Context, cfg *config.Config) error {
	w, err := fsnotify.NewWatcher()
	if err != nil {
		return err
	}
	defer w.Close()
	if err := addRecursive(w, cfg.VaultPath); err != nil {
		return err
	}
	debounce := time.Duration(cfg.AutoSyncSeconds) * time.Second
	if debounce <= 0 {
		debounce = 3 * time.Second
	}
	timer := time.NewTimer(time.Hour)
	if !timer.Stop() {
		select {
		case <-timer.C:
		default:
		}
	}
	log.Printf("watching %s (debounce %s)", cfg.VaultPath, debounce)
	for {
		select {
		case <-ctx.Done():
			return nil
		case ev := <-w.Events:
			if filepath.Base(ev.Name) == config.StateFileName || filepath.Base(ev.Name) == config.FileName {
				continue
			}
			if !timer.Stop() {
				select {
				case <-timer.C:
				default:
				}
			}
			timer.Reset(debounce)
		case err := <-w.Errors:
			log.Printf("watch error: %v", err)
		case <-timer.C:
			res, err := app.SyncOnce(ctx, cfg)
			if err != nil {
				log.Printf("sync error: %v results=%v", err, res)
				continue
			}
			log.Printf("sync ok=%v results=%v errors=%v", res.OK, res.Results, res.Errors)
		}
	}
}

func addRecursive(w *fsnotify.Watcher, root string) error {
	return filepath.WalkDir(root, func(p string, d fs.DirEntry, err error) error {
		if err != nil {
			return err
		}
		if d.IsDir() {
			base := filepath.Base(p)
			if base == ".git" || base == ".trash" || base == "node_modules" {
				return filepath.SkipDir
			}
			if base == ".obsidian" {
				return filepath.SkipDir
			}
			return w.Add(p)
		}
		return nil
	})
}
