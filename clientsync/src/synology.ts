import { assertOk, joinUrl, readJson } from "./http";
import { normalize } from "./ignore";
import type { Backend, FileInfo, NasSettings, Transport } from "./types";

type SynoErr = { success?: boolean; error?: { code?: number }; data?: unknown };

export function synologyBase(cfg: NasSettings): string {
  const scheme = cfg.https ? "https" : "http";
  const port = cfg.port || (cfg.https ? 5001 : 5000);
  return `${scheme}://${cfg.host.replace(/[/:]/g, (c) => (c === "/" ? "" : c)).split(":")[0]}:${port}`;
}

function hostOnly(host: string): string {
  return host
    .trim()
    .replace(/^https?:\/\//, "")
    .replace(/\/+$/, "")
    .replace(/:\d+$/, "");
}

export class SynologyBackend implements Backend {
  kind = "synology";
  private sid = "";

  constructor(
    private http: Transport,
    private cfg: NasSettings,
  ) {
    this.cfg = { ...cfg, host: hostOnly(cfg.host) };
  }

  private base(): string {
    return synologyBase(this.cfg);
  }

  private async get<T>(pathAndQuery: string): Promise<T> {
    const res = await this.http.request({ url: joinUrl(this.base(), pathAndQuery) });
    assertOk(res, "synology");
    return readJson<T>(res);
  }

  async login(): Promise<void> {
    if (this.sid) return;
    const q = new URLSearchParams({
      api: "SYNO.API.Auth",
      version: "3",
      method: "login",
      account: this.cfg.username,
      passwd: this.cfg.password,
      session: "FileStation",
      format: "sid",
    });
    const resp = await this.get<{
      success?: boolean;
      data?: { sid?: string };
      error?: { code?: number };
    }>(`webapi/auth.cgi?${q.toString()}`);
    if (!resp.success || !resp.data?.sid) {
      throw new Error(`群晖登录失败 code=${resp.error?.code ?? "?"}`);
    }
    this.sid = resp.data.sid;
  }

  async listShares(): Promise<string[]> {
    await this.login();
    const q = new URLSearchParams({
      api: "SYNO.FileStation.List",
      version: "2",
      method: "list_share",
      _sid: this.sid,
    });
    const resp = await this.get<{
      success?: boolean;
      data?: { shares?: { path: string }[] };
    }>(`webapi/entry.cgi?${q.toString()}`);
    if (!resp.success) throw new Error("list_share failed");
    return (resp.data?.shares ?? []).map((s) => s.path);
  }

  async list(): Promise<FileInfo[]> {
    await this.login();
    await this.ensureDir(this.cfg.remoteDir);
    const out: FileInfo[] = [];
    const walk = async (folder: string) => {
      for (const f of await this.listFolder(folder)) {
        let rel = f.path.replace(this.cfg.remoteDir.replace(/\/+$/, ""), "").replace(/^\//, "");
        if (!rel) continue;
        const mtimeMs = (f.additional?.time?.mtime || f.additional?.time?.ctime || 0) * 1000;
        if (f.isdir) {
          rel = normalize(rel) + "/";
          out.push({ relPath: rel, size: 0, mtimeMs, isDir: true });
          await walk(f.path);
        } else {
          out.push({
            relPath: normalize(rel),
            size: f.additional?.size ?? 0,
            mtimeMs,
            isDir: false,
          });
        }
      }
    };
    await walk(this.cfg.remoteDir.replace(/\/+$/, "") || "/");
    return out;
  }

  async read(relPath: string): Promise<Uint8Array> {
    await this.login();
    const q = new URLSearchParams({
      api: "SYNO.FileStation.Download",
      version: "2",
      method: "download",
      path: this.full(relPath),
      mode: "download",
      _sid: this.sid,
    });
    const res = await this.http.request({
      url: joinUrl(this.base(), `webapi/entry.cgi?${q.toString()}`),
    });
    assertOk(res, "synology download");
    return new Uint8Array(res.arrayBuffer);
  }

  async write(relPath: string, data: Uint8Array, _mtimeMs: number): Promise<void> {
    await this.login();
    const full = this.full(relPath);
    const parent = full.slice(0, full.lastIndexOf("/")) || "/";
    await this.ensureDir(parent);
    const boundary = "----clientsync" + Math.random().toString(36).slice(2);
    const name = full.slice(full.lastIndexOf("/") + 1);
    const fields: [string, string][] = [
      ["api", "SYNO.FileStation.Upload"],
      ["version", "2"],
      ["method", "upload"],
      ["path", parent],
      ["overwrite", "true"],
      ["create_parents", "true"],
    ];
    let head = "";
    for (const [k, v] of fields) {
      head += `--${boundary}\r\nContent-Disposition: form-data; name="${k}"\r\n\r\n${v}\r\n`;
    }
    head += `--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="${name}"\r\nContent-Type: application/octet-stream\r\n\r\n`;
    const tail = `\r\n--${boundary}--\r\n`;
    const body = concatU8(
      new TextEncoder().encode(head),
      data,
      new TextEncoder().encode(tail),
    );
    const res = await this.http.request({
      url: joinUrl(this.base(), `webapi/entry.cgi?_sid=${encodeURIComponent(this.sid)}`),
      method: "POST",
      headers: { "Content-Type": `multipart/form-data; boundary=${boundary}` },
      body: u8ToAb(body),
    });
    assertOk(res, "synology upload");
    const parsed = await readJson<SynoErr>(res);
    if (!parsed.success) {
      throw new Error(`upload failed code=${parsed.error?.code ?? "?"}`);
    }
  }

  async mkdir(relPath: string): Promise<void> {
    await this.login();
    await this.ensureDir(this.full(relPath));
  }

  async remove(relPath: string): Promise<void> {
    await this.login();
    const q = new URLSearchParams({
      api: "SYNO.FileStation.Delete",
      version: "2",
      method: "delete",
      path: JSON.stringify([this.full(relPath)]),
      _sid: this.sid,
    });
    const resp = await this.get<SynoErr>(`webapi/entry.cgi?${q.toString()}`);
    if (!resp.success) throw new Error(`delete failed code=${resp.error?.code ?? "?"}`);
  }

  async ensureRemote(): Promise<void> {
    await this.login();
    await this.ensureDir(this.cfg.remoteDir);
  }

  private async listFolder(folder: string): Promise<
    {
      path: string;
      name: string;
      isdir: boolean;
      additional?: { size?: number; time?: { mtime?: number; ctime?: number } };
    }[]
  > {
    const q = new URLSearchParams({
      api: "SYNO.FileStation.List",
      version: "2",
      method: "list",
      folder_path: folder,
      additional: `["size","time"]`,
      _sid: this.sid,
    });
    const resp = await this.get<{
      success?: boolean;
      data?: {
        files?: {
          path: string;
          name: string;
          isdir: boolean;
          additional?: { size?: number; time?: { mtime?: number; ctime?: number } };
        }[];
      };
      error?: { code?: number };
    }>(`webapi/entry.cgi?${q.toString()}`);
    if (!resp.success) throw new Error(`FileStation.List failed code=${resp.error?.code ?? "?"}`);
    return resp.data?.files ?? [];
  }

  private async ensureDir(folder: string): Promise<void> {
    const clean = folder.replace(/\/+$/, "");
    if (!clean || clean === "/") return;
    const parts = clean.replace(/^\//, "").split("/");
    let cur = "/" + parts[0];
    for (let i = 1; i < parts.length; i++) {
      const parent = cur;
      const name = parts[i];
      cur = parent + "/" + name;
      const q = new URLSearchParams({
        api: "SYNO.FileStation.CreateFolder",
        version: "2",
        method: "create",
        folder_path: parent,
        name,
        force_parent: "true",
        _sid: this.sid,
      });
      const resp = await this.get<SynoErr>(`webapi/entry.cgi?${q.toString()}`);
      if (!resp.success && resp.error?.code !== 414 && resp.error?.code !== 1100) {
        try {
          await this.listFolder(cur);
        } catch {
          throw new Error(`create folder ${cur} failed code=${resp.error?.code ?? "?"}`);
        }
      }
    }
  }

  private full(rel: string): string {
    const n = normalize(rel).replace(/\/+$/, "");
    const root = this.cfg.remoteDir.replace(/\/+$/, "");
    return n ? `${root}/${n}` : root;
  }
}

function concatU8(a: Uint8Array, b: Uint8Array, c: Uint8Array): Uint8Array {
  const o = new Uint8Array(a.byteLength + b.byteLength + c.byteLength);
  o.set(a, 0);
  o.set(b, a.byteLength);
  o.set(c, a.byteLength + b.byteLength);
  return o;
}

function u8ToAb(u: Uint8Array): ArrayBuffer {
  return u.buffer.slice(u.byteOffset, u.byteOffset + u.byteLength) as ArrayBuffer;
}
