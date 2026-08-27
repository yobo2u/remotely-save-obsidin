package ignore

import "testing"

func TestShouldSkip(t *testing.T) {
	if !ShouldSkip(".obsidian/app.json", true) {
		t.Fatal("expected skip .obsidian")
	}
	if ShouldSkip("note.md", true) {
		t.Fatal("should not skip note")
	}
	if !ShouldSkip(".git/HEAD", false) {
		t.Fatal("expected skip git")
	}
	if !ShouldSkip(".obsidian/vaultsync.json", false) {
		t.Fatal("expected skip config even if syncing .obsidian")
	}
}
