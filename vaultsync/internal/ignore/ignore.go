package ignore

import (
	"path"
	"strings"
)

func ShouldSkip(rel string, ignoreDotObsidian bool) bool {
	rel = strings.ReplaceAll(rel, "\\", "/")
	rel = strings.TrimPrefix(rel, "/")
	if rel == "" {
		return true
	}
	base := path.Base(rel)
	if base == "vaultsync.json" || base == "vaultsync-state.json" {
		return true
	}
	parts := strings.Split(rel, "/")
	for _, p := range parts {
		if p == ".git" || p == ".trash" || p == "node_modules" {
			return true
		}
	}
	if ignoreDotObsidian && (parts[0] == ".obsidian" || strings.HasPrefix(rel, ".obsidian/")) {
		return true
	}
	if strings.Contains(base, ".conflict-") {
		return false
	}
	return false
}

func Normalize(rel string) string {
	rel = strings.ReplaceAll(rel, "\\", "/")
	rel = strings.TrimPrefix(rel, "./")
	rel = strings.TrimPrefix(rel, "/")
	return rel
}
