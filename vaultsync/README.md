# vaultsync

English | [中文](./README.zh-cn.md)

Go sync engine for this fork: **Obsidian vault ↔ Synology NAS ↔ Google Drive**, bidirectional.

Obsidian community plugins must be JavaScript. This directory is the actual sync engine. The optional desktop helper plugin lives in [`../obsidian-vaultsync/`](../obsidian-vaultsync/). Phones cannot run the Go sidecar; use the TypeScript plugin there.

This code is **Apache 2.0**. It does **not** copy or wrap `pro/` (PolyForm Strict).

**Always backup the vault first.**

## What it does

- Reads/writes the local vault (skips `.git`, `.trash`, `vaultsync.json`, and `.obsidian` by default).
- Pairwise bidirectional sync against:
  - **Synology DSM File Station** (every DSM has this; WebDAV Server is optional).
  - **Google Drive** with your own OAuth Desktop client (`drive.file` scope).
- If both NAS and Drive are configured, `remote` becomes `all` and each backend keeps its own state file.
- Deletes propagate only when a previous snapshot proves the file existed on the other side.
- Conflicts: `keep_newer` (default), `keep_local`, or `keep_remote`. The losing copy is saved as `name.conflict-TIMESTAMP.ext`.

## Build

Requires Go 1.22+.

```bash
cd vaultsync
go test ./...
go build -o bin/vaultsync ./cmd/vaultsync
```

## Auto-configure

From inside the vault (or pass `-vault`):

```bash
./bin/vaultsync init -vault /path/to/vault
./bin/vaultsync setup google -vault /path/to/vault -client-id "$GOOGLE_CLIENT_ID"
./bin/vaultsync setup synology -vault /path/to/vault -user "$SYNOLOGY_USER" -password "$SYNOLOGY_PASSWORD"
```

Config is written to `<vault>/.obsidian/vaultsync.json` with mode `0600`.

### Google Drive

1. Open [Enable Drive API](https://console.cloud.google.com/apis/library/drive.googleapis.com) and [Credentials](https://console.cloud.google.com/apis/credentials).
2. Create an OAuth **Desktop** client. Redirect URI is a loopback address (`http://127.0.0.1`); `vaultsync` picks a free port.
3. Run `setup google`. A browser opens. After consent, a refresh token is stored locally.
4. Scope is `https://www.googleapis.com/auth/drive.file` (files this app creates/opens only). The vault folder is created by the app.

Environment: `GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET` (secret may be empty for some Desktop clients).

### Synology NAS

`setup synology` scans **only the RFC1918 /24 of this machine’s NICs** (not the public internet) and probes `http://IP:5000/webapi/query.cgi` for DSM.

Then it logs in with File Station, lists shares, and creates `/home/<vaultName>` (or `/homes`, `/docker`, else the first share).

- HTTPS DSM UI: port **5001** (self-signed TLS accepted by default).
- HTTP DSM UI: port **5000**.
- Optional `-webdav`: WebDAV Server package on **5006** / **5005**.

Pass `-host 192.168.1.10` to skip the scan. Environment: `SYNOLOGY_HOST`, `SYNOLOGY_USER`, `SYNOLOGY_PASSWORD`.

## Sync

```bash
./bin/vaultsync sync -vault /path/to/vault
./bin/vaultsync watch -vault /path/to/vault
./bin/vaultsync serve -vault /path/to/vault   # 127.0.0.1:19827 for the Obsidian helper
./bin/vaultsync doctor -vault /path/to/vault
```

Local HTTP API (loopback only):

- `GET /health`
- `POST /sync`
- `GET /config` (secrets stripped)

## Limits

- Desktop / NAS / your own machine. Not an Obsidian mobile plugin.
- No end-to-end encryption in this first version.
- Google Drive `drive.file` cannot see files created outside this OAuth client.
- File Station login uses the DSM account you provide; treat `vaultsync.json` as a secret.
