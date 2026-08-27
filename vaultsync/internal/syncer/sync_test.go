package syncer

import (
	"context"
	"os"
	"path/filepath"
	"testing"
	"time"

	"github.com/yobo2u/remotely-save-obsidin/vaultsync/internal/local"
	"github.com/yobo2u/remotely-save-obsidin/vaultsync/internal/remote"
)

func TestBidirectionalFirstSync(t *testing.T) {
	dir := t.TempDir()
	if err := os.WriteFile(filepath.Join(dir, "hello.md"), []byte("local"), 0o644); err != nil {
		t.Fatal(err)
	}
	mem := remote.NewMemory()
	_ = mem.Write(context.Background(), "from-remote.md", []byte("remote"), time.Now())
	eng := &Engine{
		Vault:     local.Vault{Root: dir, IgnoreDotObsidian: true},
		Remote:    mem,
		StatePath: filepath.Join(dir, ".obsidian", "vaultsync-state.json"),
		Conflict:  "keep_newer",
	}
	res, err := eng.Run(context.Background())
	if err != nil {
		t.Fatal(err)
	}
	if res.Pushed != 1 || res.Pulled != 1 {
		t.Fatalf("unexpected result %+v", res)
	}
	b, _ := os.ReadFile(filepath.Join(dir, "from-remote.md"))
	if string(b) != "remote" {
		t.Fatalf("pull failed: %q", b)
	}
	got, err := mem.Read(context.Background(), "hello.md")
	if err != nil || string(got) != "local" {
		t.Fatalf("push failed: %q %v", got, err)
	}
}

func TestDeletePropagation(t *testing.T) {
	dir := t.TempDir()
	p := filepath.Join(dir, "gone.md")
	if err := os.WriteFile(p, []byte("x"), 0o644); err != nil {
		t.Fatal(err)
	}
	mem := remote.NewMemory()
	eng := &Engine{
		Vault:     local.Vault{Root: dir, IgnoreDotObsidian: true},
		Remote:    mem,
		StatePath: filepath.Join(dir, ".obsidian", "vaultsync-state.json"),
		Conflict:  "keep_newer",
	}
	if _, err := eng.Run(context.Background()); err != nil {
		t.Fatal(err)
	}
	if err := os.Remove(p); err != nil {
		t.Fatal(err)
	}
	res, err := eng.Run(context.Background())
	if err != nil {
		t.Fatal(err)
	}
	if res.DeletedRemote != 1 {
		t.Fatalf("expected remote delete, got %+v", res)
	}
}

func TestConflictKeepNewer(t *testing.T) {
	dir := t.TempDir()
	p := filepath.Join(dir, "note.md")
	if err := os.WriteFile(p, []byte("local-new"), 0o644); err != nil {
		t.Fatal(err)
	}
	newer := time.Now()
	older := newer.Add(-time.Hour)
	if err := os.Chtimes(p, newer, newer); err != nil {
		t.Fatal(err)
	}
	mem := remote.NewMemory()
	if err := mem.Write(context.Background(), "note.md", []byte("remote-old"), older); err != nil {
		t.Fatal(err)
	}
	eng := &Engine{
		Vault:     local.Vault{Root: dir, IgnoreDotObsidian: true},
		Remote:    mem,
		StatePath: filepath.Join(dir, ".obsidian", "vaultsync-state.json"),
		Conflict:  "keep_newer",
	}
	res, err := eng.Run(context.Background())
	if err != nil {
		t.Fatal(err)
	}
	if res.Conflicts != 1 {
		t.Fatalf("expected 1 conflict, got %+v", res)
	}
	got, err := mem.Read(context.Background(), "note.md")
	if err != nil || string(got) != "local-new" {
		t.Fatalf("remote should keep newer local: %q %v", got, err)
	}
	matches, _ := filepath.Glob(filepath.Join(dir, "note.conflict-*.md"))
	if len(matches) != 1 {
		t.Fatalf("expected a local conflict copy, got %v", matches)
	}
}

func TestIgnore(t *testing.T) {
	dir := t.TempDir()
	_ = os.MkdirAll(filepath.Join(dir, ".obsidian"), 0o755)
	_ = os.WriteFile(filepath.Join(dir, ".obsidian", "app.json"), []byte("{}"), 0o644)
	_ = os.WriteFile(filepath.Join(dir, "note.md"), []byte("n"), 0o644)
	mem := remote.NewMemory()
	eng := &Engine{
		Vault:     local.Vault{Root: dir, IgnoreDotObsidian: true},
		Remote:    mem,
		StatePath: filepath.Join(dir, ".obsidian", "vaultsync-state.json"),
		Conflict:  "keep_newer",
	}
	res, err := eng.Run(context.Background())
	if err != nil {
		t.Fatal(err)
	}
	if res.Pushed != 1 {
		t.Fatalf("should only push note.md, got %+v", res)
	}
}
