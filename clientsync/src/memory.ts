import type { Backend, FileInfo } from "./types";

interface MemFile {
  data: Uint8Array;
  mtimeMs: number;
  isDir: boolean;
}

export class MemoryBackend implements Backend {
  kind = "memory";
  private readonly files = new Map<string, MemFile>();

  async list(): Promise<FileInfo[]> {
    const out: FileInfo[] = [];
    for (const [relPath, f] of this.files) {
      out.push({
        relPath,
        size: f.isDir ? 0 : f.data.byteLength,
        mtimeMs: f.mtimeMs,
        isDir: f.isDir,
      });
    }
    return out;
  }

  async read(relPath: string): Promise<Uint8Array> {
    const f = this.files.get(relPath);
    if (!f || f.isDir) {
      throw new Error(`not found: ${relPath}`);
    }
    return f.data.slice();
  }

  async write(relPath: string, data: Uint8Array, mtimeMs: number): Promise<void> {
    this.files.set(relPath, {
      data: data.slice(),
      mtimeMs: mtimeMs || Date.now(),
      isDir: false,
    });
  }

  async mkdir(relPath: string): Promise<void> {
    const p = relPath.endsWith("/") ? relPath : relPath + "/";
    this.files.set(p, { data: new Uint8Array(), mtimeMs: Date.now(), isDir: true });
  }

  async remove(relPath: string): Promise<void> {
    this.files.delete(relPath);
    if (relPath.endsWith("/")) {
      for (const k of [...this.files.keys()]) {
        if (k.startsWith(relPath)) {
          this.files.delete(k);
        }
      }
    }
  }
}

export function utf8(s: string): Uint8Array {
  return new TextEncoder().encode(s);
}

export function fromUtf8(b: Uint8Array): string {
  return new TextDecoder().decode(b);
}
