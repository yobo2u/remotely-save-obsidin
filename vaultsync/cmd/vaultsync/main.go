package main

import (
	"context"
	"encoding/json"
	"flag"
	"fmt"
	"os"
	"os/signal"
	"syscall"

	"github.com/yobo2u/remotely-save-obsidin/vaultsync/internal/app"
	"github.com/yobo2u/remotely-save-obsidin/vaultsync/internal/config"
	"github.com/yobo2u/remotely-save-obsidin/vaultsync/internal/serve"
	"github.com/yobo2u/remotely-save-obsidin/vaultsync/internal/setup"
	"github.com/yobo2u/remotely-save-obsidin/vaultsync/internal/watch"
)

var version = "0.1.0"

func main() {
	if len(os.Args) < 2 {
		usage()
		os.Exit(2)
	}
	cmd := os.Args[1]
	args := os.Args[2:]
	switch cmd {
	case "init":
		cmdInit(args)
	case "setup":
		if len(args) < 1 {
			fatal("usage: vaultsync setup google|synology [flags]")
		}
		target, rest := args[0], args[1:]
		switch target {
		case "google":
			cmdSetupGoogle(rest)
		case "synology":
			cmdSetupSynology(rest)
		default:
			fatal("unknown setup target %s (google|synology)", target)
		}
	case "sync":
		cmdSync(args)
	case "watch":
		cmdWatch(args)
	case "serve":
		cmdServe(args)
	case "doctor":
		cmdDoctor(args)
	case "version", "-v", "--version":
		fmt.Println(version)
	case "help", "-h", "--help":
		usage()
	default:
		fatal("unknown command %s", cmd)
	}
}

func usage() {
	fmt.Fprintf(os.Stderr, `vaultsync %s — bidirectional Obsidian vault sync (local + Synology NAS + Google Drive)

Commands:
  init               create %s in the vault
  setup google       interactive Google Drive OAuth (loopback + PKCE)
  setup synology     discover DSM on the LAN and save File Station config
  sync               one bidirectional pass (all configured remotes)
  watch              sync on local file changes
  serve              local HTTP API for the Obsidian helper plugin (127.0.0.1 only)
  doctor             print config (secrets redacted) and connectivity
  version

Common flags:
  -vault PATH        vault root (default: current directory or OBSIDIAN_VAULT)
  -config PATH       config file (default: <vault>/.obsidian/vaultsync.json)

Environment:
  GOOGLE_CLIENT_ID / GOOGLE_CLIENT_SECRET
  SYNOLOGY_HOST / SYNOLOGY_USER / SYNOLOGY_PASSWORD
`, version, config.FileName)
}

func fatal(format string, a ...any) {
	fmt.Fprintf(os.Stderr, format+"\n", a...)
	os.Exit(1)
}

func must(err error) {
	if err != nil {
		fatal("%v", err)
	}
}

func parseCommon(args []string, extra func(*flag.FlagSet)) *flag.FlagSet {
	fs := flag.NewFlagSet(os.Args[1], flag.ExitOnError)
	fs.String("vault", "", "vault directory")
	fs.String("config", "", "config file path")
	if extra != nil {
		extra(fs)
	}
	must(fs.Parse(args))
	return fs
}

func vaultAndPath(fs *flag.FlagSet) (vault, cfgPath string) {
	vaultFlag := fs.Lookup("vault").Value.String()
	cfgPath = fs.Lookup("config").Value.String()
	var err error
	vault, err = config.FindVault(vaultFlag)
	must(err)
	if cfgPath == "" {
		cfgPath = config.PathForVault(vault)
	}
	return vault, cfgPath
}

func loadFromFlags(fs *flag.FlagSet) (*config.Config, string) {
	vault, cfgPath := vaultAndPath(fs)
	cfg, err := config.Load(cfgPath)
	must(err)
	if cfg.VaultPath == "" {
		cfg.VaultPath = vault
	}
	return cfg, cfgPath
}

func loadOrCreate(fs *flag.FlagSet) (*config.Config, string) {
	vault, cfgPath := vaultAndPath(fs)
	cfg, err := config.Load(cfgPath)
	if err != nil {
		if _, statErr := os.Stat(cfgPath); statErr == nil {
			must(err)
		}
		cfg = config.Default(vault)
		return cfg, cfgPath
	}
	if cfg.VaultPath == "" {
		cfg.VaultPath = vault
	}
	return cfg, cfgPath
}

func save(cfg *config.Config, path string) {
	must(cfg.Save(path))
	fmt.Println("wrote", path)
}

func cmdInit(args []string) {
	fs := parseCommon(args, nil)
	vault, cfgPath := vaultAndPath(fs)
	if _, err := os.Stat(cfgPath); err == nil {
		fatal("config already exists: %s", cfgPath)
	}
	save(config.Default(vault), cfgPath)
}

func cmdSetupGoogle(args []string) {
	var clientID, secret string
	var noBrowser bool
	fs := parseCommon(args, func(fs *flag.FlagSet) {
		fs.StringVar(&clientID, "client-id", os.Getenv("GOOGLE_CLIENT_ID"), "OAuth client id")
		fs.StringVar(&secret, "client-secret", os.Getenv("GOOGLE_CLIENT_SECRET"), "OAuth client secret (empty for many Desktop clients)")
		fs.BoolVar(&noBrowser, "no-browser", false, "print the URL only; do not open a browser")
	})
	cfg, path := loadOrCreate(fs)
	must(setup.SetupGoogle(context.Background(), cfg, clientID, secret, !noBrowser))
	save(cfg, path)
}

func cmdSetupSynology(args []string) {
	var host, user, password, remoteDir string
	var useWebDAV bool
	fs := parseCommon(args, func(fs *flag.FlagSet) {
		fs.StringVar(&host, "host", os.Getenv("SYNOLOGY_HOST"), "DSM host or URL, e.g. 192.168.1.10")
		fs.StringVar(&user, "user", os.Getenv("SYNOLOGY_USER"), "DSM username")
		fs.StringVar(&password, "password", os.Getenv("SYNOLOGY_PASSWORD"), "DSM password")
		fs.StringVar(&remoteDir, "remote-dir", "", "File Station folder, e.g. /home/MyVault")
		fs.BoolVar(&useWebDAV, "webdav", false, "use WebDAV package instead of File Station API")
	})
	cfg, path := loadOrCreate(fs)
	must(setup.SetupSynology(context.Background(), cfg, host, user, password, remoteDir, useWebDAV))
	save(cfg, path)
}

func cmdSync(args []string) {
	fs := parseCommon(args, nil)
	cfg, _ := loadFromFlags(fs)
	res, err := app.SyncOnce(context.Background(), cfg)
	if res != nil {
		fmt.Println(jsonPrint(res))
	}
	must(err)
}

func cmdWatch(args []string) {
	fs := parseCommon(args, nil)
	cfg, _ := loadFromFlags(fs)
	ctx, cancel := signal.NotifyContext(context.Background(), os.Interrupt, syscall.SIGTERM)
	defer cancel()
	fmt.Println("watching", cfg.VaultPath)
	must(watch.Run(ctx, cfg))
}

func cmdServe(args []string) {
	fs := parseCommon(args, nil)
	cfg, _ := loadFromFlags(fs)
	ctx, cancel := signal.NotifyContext(context.Background(), os.Interrupt, syscall.SIGTERM)
	defer cancel()
	must(serve.Run(ctx, cfg))
}

func cmdDoctor(args []string) {
	fs := parseCommon(args, nil)
	cfg, _ := loadFromFlags(fs)
	redacted := *cfg
	redacted.Google.ClientSecret = redact(redacted.Google.ClientSecret)
	redacted.Google.RefreshToken = redact(redacted.Google.RefreshToken)
	redacted.Google.AccessToken = redact(redacted.Google.AccessToken)
	redacted.Synology.Password = redact(redacted.Synology.Password)
	redacted.WebDAV.Password = redact(redacted.WebDAV.Password)
	fmt.Println(jsonPrint(redacted))
	ctx := context.Background()
	kinds := cfg.ActiveRemotes()
	if len(kinds) == 0 {
		fmt.Println("backends: none configured")
		return
	}
	for _, kind := range kinds {
		b, err := app.BuildRemote(ctx, cfg, kind)
		if err != nil {
			fmt.Printf("%s: ERROR %v\n", kind, err)
			continue
		}
		ents, err := b.List(ctx)
		if err != nil {
			fmt.Printf("%s: ERROR %v\n", kind, err)
			continue
		}
		fmt.Printf("%s: ok (%d files)\n", kind, len(ents))
	}
}

func redact(s string) string {
	if s == "" {
		return ""
	}
	return "***"
}

func jsonPrint(v any) string {
	b, err := json.MarshalIndent(v, "", "  ")
	if err != nil {
		return fmt.Sprint(v)
	}
	return string(b)
}
