package setup

import (
	"context"
	"fmt"
	"path"
	"strings"

	"github.com/yobo2u/remotely-save-obsidin/vaultsync/internal/config"
	"github.com/yobo2u/remotely-save-obsidin/vaultsync/internal/remote"
)

func SetupSynology(ctx context.Context, cfg *config.Config, host, user, pass, remoteDir string, useWebDAV bool) error {
	if user == "" {
		user = cfg.Synology.Username
	}
	if pass == "" {
		pass = cfg.Synology.Password
	}
	if user == "" || pass == "" {
		return fmt.Errorf("synology username/password required (flags --user --password, or env SYNOLOGY_USER / SYNOLOGY_PASSWORD)")
	}
	if host == "" {
		host = cfg.Synology.Host
	}
	host = NormalizeHost(host)
	var chosen Device
	if host != "" {
		if d, ok := ProbeHost(ctx, host); ok {
			chosen = d
		} else {
			chosen = Device{IP: host, HTTPPort: 5000, HTTPSPort: 5001}
		}
	} else {
		fmt.Println("Scanning the local network for Synology DSM (private /24 of this machine only)...")
		devs, err := DiscoverSynology(ctx, 0)
		if err != nil {
			return err
		}
		if len(devs) == 0 {
			return fmt.Errorf("no Synology NAS found on the local subnet. Pass --host <nas-ip>")
		}
		fmt.Printf("Found %d device(s):\n", len(devs))
		for i, d := range devs {
			fmt.Printf("  [%d] %s http:%d https:%d webdav:%d/%d\n", i+1, d.IP, d.HTTPPort, d.HTTPSPort, d.WebDAVHTTP, d.WebDAVHTTPS)
		}
		chosen = devs[0]
		fmt.Printf("Using %s\n", chosen.IP)
	}

	cli := remote.NewSynology(chosen.IP, chosen.HTTPSPort, true, true, user, pass, "/tmp-probe")
	shares, err := cli.ListShares(ctx)
	if err != nil {
		// try HTTP 5000
		cli = remote.NewSynology(chosen.IP, chosen.HTTPPort, false, true, user, pass, "/tmp-probe")
		shares, err = cli.ListShares(ctx)
		if err != nil {
			return fmt.Errorf("login/list shares failed: %w", err)
		}
		cfg.Synology.HTTPS = false
		cfg.Synology.Port = chosen.HTTPPort
	} else {
		cfg.Synology.HTTPS = true
		cfg.Synology.Port = chosen.HTTPSPort
	}
	if len(shares) == 0 {
		return fmt.Errorf("DSM login succeeded but no File Station shares are visible")
	}
	fmt.Println("Shares:")
	for _, s := range shares {
		fmt.Printf("  %s\n", s)
	}

	vaultName := path.Base(strings.ReplaceAll(cfg.VaultPath, "\\", "/"))
	if remoteDir == "" {
		remoteDir = cfg.Synology.RemoteDir
	}
	if remoteDir == "" || remoteDir == "/"+vaultName || remoteDir == vaultName {
		base := pickShare(shares)
		remoteDir = strings.TrimSuffix(base, "/") + "/" + vaultName
	}
	if !strings.HasPrefix(remoteDir, "/") {
		remoteDir = "/" + remoteDir
	}

	cfg.Synology.Host = chosen.IP
	cfg.Synology.Username = user
	cfg.Synology.Password = pass
	cfg.Synology.RemoteDir = remoteDir
	cfg.Synology.InsecureTLS = true
	if chosen.WebDAVHTTPS != 0 {
		cfg.Synology.WebDAVPort = chosen.WebDAVHTTPS
	} else if chosen.WebDAVHTTP != 0 {
		cfg.Synology.WebDAVPort = chosen.WebDAVHTTP
	}
	cfg.Synology.UseWebDAV = useWebDAV
	cfg.EnableRemote(config.RemoteSynology)

	probe := remote.NewSynology(cfg.Synology.Host, cfg.Synology.Port, cfg.Synology.HTTPS, true, user, pass, remoteDir)
	if err := probe.Mkdir(ctx, ""); err != nil {
		return fmt.Errorf("could not create remote folder %s: %w", remoteDir, err)
	}
	fmt.Printf("Synology ready. Remote folder: %s on %s\n", remoteDir, chosen.IP)
	return nil
}

func pickShare(shares []string) string {
	preferred := []string{"/home", "/homes", "/docker"}
	for _, p := range preferred {
		for _, s := range shares {
			if s == p {
				return s
			}
		}
	}
	return shares[0]
}
