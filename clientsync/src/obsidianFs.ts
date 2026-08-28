import { App, DataAdapter, normalizePath } from "obsidian";
import type { VaultAdapter } from "./localVault";

export function obsidianAdapter(app: App): VaultAdapter {
  const a = app.vault.adapter as DataAdapter & {
    list: (p: string) => Promise<{ files: string[]; folders: string[] }>;
    readBinary: (p: string) => Promise<ArrayBuffer>;
    writeBinary: (p: string, data: ArrayBuffer) => Promise<void>;
    mkdir: (p: string) => Promise<void>;
    rmdir: (p: string, recursive?: boolean) => Promise<void>;
    remove: (p: string) => Promise<void>;
    stat: (p: string) => Promise<{ ctime: number; mtime: number; size: number } | null>;
  };
  return {
    list: (p) => a.list(p ? normalizePath(p) : "/"),
    readBinary: (p) => a.readBinary(normalizePath(p)),
    writeBinary: (p, data) => a.writeBinary(normalizePath(p), data),
    mkdir: async (p) => {
      const n = normalizePath(p);
      if (n && n !== "/") await a.mkdir(n);
    },
    remove: async (p) => {
      const n = normalizePath(p);
      try {
        await a.remove(n);
      } catch {
        await a.rmdir(n, true);
      }
    },
    stat: (p) => a.stat(normalizePath(p)),
  };
}

export function vaultFolderName(app: App): string {
  const adapter = app.vault.adapter as { getBasePath?: () => string; getName?: () => string };
  if (typeof adapter.getBasePath === "function") {
    const base = adapter.getBasePath().replace(/\\/g, "/");
    const name = base.split("/").filter(Boolean).pop();
    if (name) return name;
  }
  return app.vault.getName() || "ObsidianVault";
}
