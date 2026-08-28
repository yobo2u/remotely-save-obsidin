import { normalize } from "./ignore";
import type {
  Backend,
  ConflictMode,
  FileInfo,
  FileState,
  Snapshot,
  SyncResult,
} from "./types";

export function emptySnapshot(): Snapshot {
  return { updated: 0, files: {} };
}

function index(files: FileInfo[]): Map<string, FileInfo> {
  const m = new Map<string, FileInfo>();
  for (const f of files) {
    let p = normalize(f.relPath);
    if (f.isDir && !p.endsWith("/")) {
      p += "/";
    }
    m.set(p, { ...f, relPath: p });
  }
  return m;
}

function abs64(v: number): number {
  return v < 0 ? -v : v;
}

function sameish(l: FileInfo, r: FileInfo): boolean {
  return l.size === r.size && abs64(l.mtimeMs - r.mtimeMs) <= 2000;
}

export function conflictName(p: string, now = new Date()): string {
  const i = p.lastIndexOf(".");
  const ext = i > 0 ? p.slice(i) : "";
  const stem = i > 0 ? p.slice(0, i) : p;
  const ts = now.toISOString().replace(/[-:]/g, "").replace(/\.\d+Z$/, "Z").replace("T", "-").slice(0, 15);
  return `${stem}.conflict-${ts}${ext}`;
}

export class Engine {
  constructor(
    private readonly local: Backend,
    private readonly remote: Backend,
    private readonly conflict: ConflictMode,
    private readonly skipBytes: number,
  ) {}

  async run(prev: Snapshot): Promise<{ result: SyncResult; next: Snapshot }> {
    const result: SyncResult = {
      remote: this.remote.kind,
      pushed: 0,
      pulled: 0,
      deletedLocal: 0,
      deletedRemote: 0,
      conflicts: 0,
      skipped: 0,
      errors: [],
    };
    const loc = index(await this.local.list());
    const rem = index(await this.remote.list());
    const next: Snapshot = { updated: Date.now(), files: {} };
    const all = new Set<string>([...loc.keys(), ...rem.keys(), ...Object.keys(prev.files)]);

    for (const p of all) {
      try {
        if (p.endsWith("/")) {
          await this.syncDir(p, loc, rem, next);
          continue;
        }
        const act = await this.syncFile(p, loc, rem, prev, next);
        if (act === "push") result.pushed++;
        else if (act === "pull") result.pulled++;
        else if (act === "delete_local") result.deletedLocal++;
        else if (act === "delete_remote") result.deletedRemote++;
        else if (act === "conflict") result.conflicts++;
        else result.skipped++;
      } catch (e) {
        result.errors.push(`${p}: ${e instanceof Error ? e.message : String(e)}`);
      }
    }
    return { result, next };
  }

  private async syncDir(
    p: string,
    loc: Map<string, FileInfo>,
    rem: Map<string, FileInfo>,
    next: Snapshot,
  ): Promise<void> {
    const lOK = loc.has(p);
    const rOK = rem.has(p);
    if (lOK && !rOK) {
      await this.remote.mkdir(p);
    } else if (rOK && !lOK) {
      await this.local.mkdir(p);
    }
    next.files[p] = { localMtime: 0, remoteMtime: 0, size: 0 };
  }

  private tooLarge(size: number): boolean {
    return this.skipBytes > 0 && size > this.skipBytes;
  }

  private async syncFile(
    p: string,
    loc: Map<string, FileInfo>,
    rem: Map<string, FileInfo>,
    prev: Snapshot,
    next: Snapshot,
  ): Promise<string> {
    const l = loc.get(p);
    const r = rem.get(p);
    const s = prev.files[p];

    if (l && !r) {
      if (s && s.remoteMtime > 0 && s.localMtime === l.mtimeMs) {
        await this.local.remove(p);
        return "delete_local";
      }
      if (this.tooLarge(l.size)) {
        throw new Error(`skip large file ${l.size} bytes`);
      }
      const data = await this.local.read(p);
      await this.remote.write(p, data, l.mtimeMs);
      next.files[p] = { localMtime: l.mtimeMs, remoteMtime: l.mtimeMs, size: l.size };
      return "push";
    }

    if (r && !l) {
      if (s && s.localMtime > 0 && s.remoteMtime === r.mtimeMs) {
        await this.remote.remove(p);
        return "delete_remote";
      }
      if (this.tooLarge(r.size)) {
        throw new Error(`skip large file ${r.size} bytes`);
      }
      const data = await this.remote.read(p);
      await this.local.write(p, data, r.mtimeMs);
      next.files[p] = { localMtime: r.mtimeMs, remoteMtime: r.mtimeMs, size: r.size };
      return "pull";
    }

    if (l && r) {
      if (sameish(l, r)) {
        next.files[p] = { localMtime: l.mtimeMs, remoteMtime: r.mtimeMs, size: l.size };
        return "skip";
      }
      const localChanged = !s || s.localMtime !== l.mtimeMs;
      const remoteChanged = !s || s.remoteMtime !== r.mtimeMs;
      if (localChanged && !remoteChanged) {
        if (this.tooLarge(l.size)) throw new Error(`skip large file ${l.size} bytes`);
        const data = await this.local.read(p);
        await this.remote.write(p, data, l.mtimeMs);
        next.files[p] = { localMtime: l.mtimeMs, remoteMtime: l.mtimeMs, size: l.size };
        return "push";
      }
      if (remoteChanged && !localChanged) {
        if (this.tooLarge(r.size)) throw new Error(`skip large file ${r.size} bytes`);
        const data = await this.remote.read(p);
        await this.local.write(p, data, r.mtimeMs);
        next.files[p] = { localMtime: r.mtimeMs, remoteMtime: r.mtimeMs, size: r.size };
        return "pull";
      }
      let keepLocal = l.mtimeMs >= r.mtimeMs;
      if (this.conflict === "keep_local") keepLocal = true;
      if (this.conflict === "keep_remote") keepLocal = false;
      const loser = conflictName(p);
      if (keepLocal) {
        try {
          const rd = await this.remote.read(p);
          await this.local.write(loser, rd, r.mtimeMs);
        } catch {
          /* ignore backup failure */
        }
        const data = await this.local.read(p);
        await this.remote.write(p, data, l.mtimeMs);
        next.files[p] = { localMtime: l.mtimeMs, remoteMtime: l.mtimeMs, size: l.size };
      } else {
        try {
          const ld = await this.local.read(p);
          await this.local.write(loser, ld, l.mtimeMs);
        } catch {
          /* ignore */
        }
        const data = await this.remote.read(p);
        await this.local.write(p, data, r.mtimeMs);
        next.files[p] = { localMtime: r.mtimeMs, remoteMtime: r.mtimeMs, size: r.size };
      }
      return "conflict";
    }
    return "skip";
  }
}
