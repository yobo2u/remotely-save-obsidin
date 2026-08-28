import { shouldSkip, normalize } from "./ignore";
import type { Backend, FileInfo } from "./types";

export interface VaultAdapter {
  list(normalizedPath: string): Promise<{ files: string[]; folders: string[] }>;
  readBinary(normalizedPath: string): Promise<ArrayBuffer>;
  writeBinary(normalizedPath: string, data: ArrayBuffer): Promise<void>;
  mkdir(normalizedPath: string): Promise<void>;
  remove(normalizedPath: string): Promise<void>;
  stat(normalizedPath: string): Promise<{ ctime: number; mtime: number; size: number } | null>;
}

export class LocalVault implements Backend {
  kind = "local";

  constructor(
    private adapter: VaultAdapter,
    private ignoreDotObsidian: boolean,
  ) {}

  async list(): Promise<FileInfo[]> {
    const out: FileInfo[] = [];
    const walk = async (prefix: string) => {
      const listed = await this.adapter.list(prefix);
      for (const folder of listed.folders) {
        const rel = normalize(folder);
        if (shouldSkip(rel + "/", this.ignoreDotObsidian)) continue;
        const st = await this.adapter.stat(rel);
        out.push({
          relPath: rel + "/",
          size: 0,
          mtimeMs: st?.mtime ?? Date.now(),
          isDir: true,
        });
        await walk(rel);
      }
      for (const file of listed.files) {
        const rel = normalize(file);
        if (shouldSkip(rel, this.ignoreDotObsidian)) continue;
        const st = await this.adapter.stat(rel);
        out.push({
          relPath: rel,
          size: st?.size ?? 0,
          mtimeMs: st?.mtime ?? Date.now(),
          isDir: false,
        });
      }
    };
    await walk("");
    return out;
  }

  async read(relPath: string): Promise<Uint8Array> {
    const buf = await this.adapter.readBinary(normalize(relPath));
    return new Uint8Array(buf);
  }

  async write(relPath: string, data: Uint8Array, mtimeMs: number): Promise<void> {
    const n = normalize(relPath);
    const parent = n.includes("/") ? n.slice(0, n.lastIndexOf("/")) : "";
    if (parent) {
      await this.adapter.mkdir(parent).catch(() => undefined);
    }
    const copy = data.buffer.slice(data.byteOffset, data.byteOffset + data.byteLength) as ArrayBuffer;
    await this.adapter.writeBinary(n, copy);
    void mtimeMs;
  }

  async mkdir(relPath: string): Promise<void> {
    await this.adapter.mkdir(normalize(relPath).replace(/\/+$/, ""));
  }

  async remove(relPath: string): Promise<void> {
    await this.adapter.remove(normalize(relPath).replace(/\/+$/, ""));
  }
}
