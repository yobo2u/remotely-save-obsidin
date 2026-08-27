# Vaultsync helper plugin (desktop)

This is a **thin Obsidian desktop plugin**. It does not implement sync itself.

It calls the local Go engine:

```
http://127.0.0.1:19827/sync
```

Install:

1. Build `vaultsync` (see [`../vaultsync/README.md`](../vaultsync/README.md)).
2. Copy this folder into `<vault>/.obsidian/plugins/obsidian-vaultsync/`.
3. Enable **Vaultsync (Go sidecar)** in community plugins (safe mode off).
4. Set the absolute path to the `vaultsync` binary, or start `vaultsync serve --vault <vault>` yourself.

Mobile cannot run the Go sidecar. Use the TypeScript Remotely Save plugin on phones.

License: Apache 2.0 (same as `src/` of this repository). Do not copy code from `pro/`.
