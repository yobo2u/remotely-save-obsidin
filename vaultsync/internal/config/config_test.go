package config

import (
	"path/filepath"
	"testing"
)

func TestEnableRemoteBoth(t *testing.T) {
	c := Default("/tmp/vault")
	c.EnableRemote(RemoteSynology)
	if c.Remote != RemoteSynology {
		t.Fatalf("got %s", c.Remote)
	}
	c.EnableRemote(RemoteGDrive)
	if c.Remote != RemoteAll {
		t.Fatalf("expected all, got %s", c.Remote)
	}
	c.Synology.Host = "192.168.1.10"
	c.Synology.Username = "u"
	c.Google.ClientID = "id"
	c.Google.RefreshToken = "tok"
	got := c.ActiveRemotes()
	if len(got) != 2 {
		t.Fatalf("active remotes: %v", got)
	}
}

func TestStatePath(t *testing.T) {
	p := StatePath("/v", RemoteGDrive)
	if filepath.Base(p) != "vaultsync-state-gdrive.json" {
		t.Fatalf("path %s", p)
	}
}
