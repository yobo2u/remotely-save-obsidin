import { assertOk, joinUrl, readJson } from "./http";
import { normalize } from "./ignore";
import type { Backend, FileInfo, NasSettings, Transport } from "./types";

function hostOnly(host: string): string {
  return host
    .trim()
    .replace(/^https?:\/\//, "")
    .replace(/\/+$/, "")
    .replace(/:\d+$/, "");
}

export function qnapBase(cfg: NasSettings): string {
  const scheme = cfg.https ? "https" : "http";
  const port = cfg.port || (cfg.https ? 443 : 8080);
  return `${scheme}://${hostOnly(cfg.host)}:${port}`;
}

function xmlTag(xml: string, tag: string): string {
  const re = new RegExp(`<${tag}[^>]*>(?:<!\\[CDATA\\[)?([^\\]<]*)`, "i");
  return re.exec(xml)?.[1]?.trim() ?? "";
}

/** QNAP classic password encoding (ASCII passwords == standard Base64). */
export function qnapEncodePassword(password: string): string {
  const bytes = new TextEncoder().encode(password);
  let bin = "";
  for (const b of bytes) bin += String.fromCharCode(b);
  return btoa(bin);
}

type QnapItem = {
  filename?: string;
  filesize?: string | number;
  mt?: string | number;
  epochmt?: string | number;
  isfolder?: number | string;
  isdir?: boolean;
};

export class QnapBackend implements Backend {
  kind = "qnap";
  private sid = "";

  constructor(
    private http: Transport,
    private cfg: NasSettings,
  ) {
    this.cfg = { ...cfg, host: hostOnly(cfg.host) };
  }

  private base(): string {
    return qnapBase(this.cfg);
  }

  async login(): Promise<void> {
    if (this.sid) return;
    const tryLogin = async (query: Record<string, string>) => {
      const url = joinUrl(this.base(), `cgi-bin/authLogin.cgi?${new URLSearchParams(query).toString()}`);
      const res = await this.http.request({ url });
      return res;
    };
    let res = await tryLogin({
      user: this.cfg.username,
      plain_pwd: this.cfg.password,
    });
    let sid = xmlTag(res.text, "authSid");
    let passed = xmlTag(res.text, "authPassed");
    if (passed !== "1" || !sid) {
      res = await tryLogin({
        user: this.cfg.username,
        pwd: qnapEncodePassword(this.cfg.password),
      });
      sid = xmlTag(res.text, "authSid");
      passed = xmlTag(res.text, "authPassed");
    }
    if (passed !== "1" || !sid) {
      throw new Error("QNAP 登录失败（请检查用户名、密码、端口 8080/443）");
    }
    this.sid = sid;
  }

  private async cgi(params: Record<string, string>, body?: ArrayBuffer, contentType?: string) {
    const q = new URLSearchParams({ ...params, sid: this.sid });
    const res = await this.http.request({
      url: joinUrl(this.base(), `cgi-bin/filemanager/utilRequest.cgi?${q.toString()}`),
      method: body ? "POST" : "GET",
      headers: contentType ? { "Content-Type": contentType } : undefined,
      body,
    });
    assertOk(res, "qnap");
    return res;
  }

  async listShares(): Promise<string[]> {
    await this.login();
    const res = await this.cgi({
      func: "get_tree",
      is_iso: "0",
      node: "share_root",
    });
    try {
      const parsed = JSON.parse(res.text) as Array<{ text?: string; id?: string }> | { datas?: QnapItem[] };
      if (Array.isArray(parsed)) {
        return parsed.map((x) => "/" + String(x.text || x.id || "").replace(/^\/+/, "")).filter((s) => s.length > 1);
      }
    } catch {
      /* ignore */
    }
    return ["/Public", "/home"];
  }

  async list(): Promise<FileInfo[]> {
    await this.login();
    await this.ensureDir(this.cfg.remoteDir);
    const out: FileInfo[] = [];
    const walk = async (folder: string) => {
      const items = await this.listFolder(folder);
      for (const it of items) {
        const name = String(it.filename ?? "");
        if (!name || name === "." || name === "..") continue;
        const prefix = normalize(folder.replace(this.root(), ""));
        const childRel = normalize(prefix ? `${prefix}/${name}` : name);
        const isDir = it.isfolder === 1 || it.isfolder === "1" || it.isdir === true;
        const rawMt = Number(it.epochmt || it.mt || 0);
        const mtimeMs = rawMt > 0 && rawMt < 1e12 ? rawMt * 1000 : rawMt;
        if (isDir) {
          out.push({ relPath: childRel + "/", size: 0, mtimeMs, isDir: true });
          await walk(this.joinPath(folder, name));
        } else {
          out.push({
            relPath: childRel,
            size: Number(it.filesize || 0),
            mtimeMs,
            isDir: false,
          });
        }
      }
    };
    await walk(this.root());
    return out;
  }

  async read(relPath: string): Promise<Uint8Array> {
    await this.login();
    const { parent, name } = splitName(this.full(relPath));
    const res = await this.cgi({
      func: "download",
      isfolder: "0",
      compress: "0",
      source_path: parent,
      source_file: name,
      source_total: "1",
    });
    return new Uint8Array(res.arrayBuffer);
  }

  async write(relPath: string, data: Uint8Array, _mtimeMs: number): Promise<void> {
    await this.login();
    const full = this.full(relPath);
    const { parent, name } = splitName(full);
    await this.ensureDir(parent);
    const progress = parent.replace(/\//g, "-") + "-" + name;
    const boundary = "----clientsync" + Math.random().toString(36).slice(2);
    const head =
      `--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="${name}"\r\nContent-Type: application/octet-stream\r\n\r\n`;
    const tail = `\r\n--${boundary}--\r\n`;
    const h = new TextEncoder().encode(head);
    const t = new TextEncoder().encode(tail);
    const packed = new Uint8Array(h.byteLength + data.byteLength + t.byteLength);
    packed.set(h, 0);
    packed.set(data, h.byteLength);
    packed.set(t, h.byteLength + data.byteLength);
    const res = await this.cgi(
      {
        func: "upload",
        type: "standard",
        dest_path: parent,
        overwrite: "1",
        progress,
      },
      packed.buffer.slice(packed.byteOffset, packed.byteOffset + packed.byteLength) as ArrayBuffer,
      `multipart/form-data; boundary=${boundary}`,
    );
    const parsed = await readJson<{ status?: number; success?: string | boolean }>(res).catch(() => ({
      status: 0,
    }));
    if (parsed.status && parsed.status !== 1) {
      throw new Error(`QNAP upload status=${parsed.status}`);
    }
  }

  async mkdir(relPath: string): Promise<void> {
    await this.login();
    await this.ensureDir(this.full(relPath));
  }

  async remove(relPath: string): Promise<void> {
    await this.login();
    const { parent, name } = splitName(this.full(relPath));
    const res = await this.cgi({
      func: "delete",
      path: parent,
      file_total: "1",
      file_name: name,
    });
    const parsed = await readJson<{ status?: number }>(res).catch(() => ({ status: 1 }));
    if (parsed.status && parsed.status !== 1) {
      throw new Error(`QNAP delete status=${parsed.status}`);
    }
  }

  async ensureRemote(): Promise<void> {
    await this.login();
    await this.ensureDir(this.cfg.remoteDir);
  }

  private root(): string {
    const d = this.cfg.remoteDir || "/Public";
    return d.startsWith("/") ? d.replace(/\/+$/, "") : "/" + d;
  }

  private full(rel: string): string {
    const n = normalize(rel).replace(/\/+$/, "");
    return n ? `${this.root()}/${n}` : this.root();
  }

  private joinPath(folder: string, name: string): string {
    return (folder.replace(/\/+$/, "") || "") + "/" + name;
  }

  private async listFolder(folder: string): Promise<QnapItem[]> {
    const res = await this.cgi({
      func: "get_list",
      is_iso: "0",
      list_mode: "all",
      path: folder || "/",
      dir: "ASC",
      limit: "10000",
      sort: "filename",
      start: "0",
      hidden_file: "1",
    });
    const parsed = await readJson<{ datas?: QnapItem[]; status?: number }>(res);
    return parsed.datas ?? [];
  }

  private async ensureDir(folder: string): Promise<void> {
    const clean = folder.replace(/\/+$/, "");
    if (!clean || clean === "/") return;
    const parts = clean.replace(/^\//, "").split("/");
    let cur = "";
    for (let i = 0; i < parts.length; i++) {
      const name = parts[i];
      const parent = cur ? "/" + cur : "/";
      cur = cur ? cur + "/" + name : name;
      if (i === 0) continue; // first segment is the share
      const res = await this.cgi({
        func: "createdir",
        dest_folder: name,
        dest_path: parent === "/" ? "/" + parts[0] : parent,
      });
      const parsed = await readJson<{ status?: number }>(res).catch(() => ({ status: 1 }));
      if (parsed.status && parsed.status !== 1 && parsed.status !== 2) {
        throw new Error(`QNAP createdir ${cur} status=${parsed.status}`);
      }
    }
  }
}

function splitName(full: string): { parent: string; name: string } {
  const n = full.replace(/\/+$/, "");
  const i = n.lastIndexOf("/");
  return { parent: n.slice(0, i) || "/", name: n.slice(i + 1) };
}
