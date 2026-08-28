# Client Direct Sync

English | [中文](./README.zh-cn.md)

Obsidian plugin: **bidirectional** sync of the vault with **Google Drive**, **Synology NAS**, and **QNAP NAS**.

It runs **inside Obsidian**. HTTP uses Obsidian `requestUrl` (CORS bypass). There is **no author backend** and **no local Go sidecar**. Google’s API and your NAS are the only remote systems.

Apache 2.0. This folder does **not** copy `pro/` (PolyForm Strict).

**Backup the vault first.**

## Install

1. `cd clientsync && npm test && npm run build` (from repo root: `node --import tsx --test clientsync/tests/*.test.ts` then `node clientsync/esbuild.mjs production`).
2. Copy `manifest.json`, `main.js`, `styles.css` to `<vault>/.obsidian/plugins/client-direct-sync/`.
3. Enable **Client Direct Sync** in community plugins.

## Google Drive

1. [Enable Drive API](https://console.cloud.google.com/apis/library/drive.googleapis.com).
2. [Credentials](https://console.cloud.google.com/apis/credentials) → OAuth **Desktop** client.
3. Redirect URI: `http://127.0.0.1` (must match the plugin setting).
4. Paste client ID (secret optional for many Desktop clients).
5. Open the auth browser, then paste the address-bar URL back into the plugin.

Scope: `drive.file` (only files this app creates).

## Synology

Uses **DSM File Station** (every DSM has it). Default HTTP **5000** on LAN (HTTPS **5001**). Desktop can ignore self-signed certs.

Fill user/password, tap **探测** (desktop, RFC1918 /24 only) or type the IP, then **登录并创建目录**.

## QNAP

Uses **QTS File Station** (`authLogin.cgi` + `utilRequest.cgi`). Default HTTP **8080** (HTTPS **443**). Same login button as Synology.

Remote dir examples: `/Public/MyVault`, `/home/MyVault`.

## Sync rules

- Skip `.obsidian` (optional), `.git`, `.trash`.
- Deletes propagate only if a previous snapshot saw the file on the other side.
- Conflicts: keep newer (default); loser saved as `name.conflict-TIMESTAMP.ext`.
- Google and one or both NAS targets can be enabled together (pairwise sync).

## Limits

- Phone: Google paste-code works; NAS must be reachable on the LAN. Auto-sync may pause in background.
- No end-to-end encryption in this version.
- Treat plugin `data.json` as a secret (NAS password, Google refresh token).
