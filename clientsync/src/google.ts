import { assertOk, readJson } from "./http";
import { normalize } from "./ignore";
import type { Backend, FileInfo, GoogleSettings, Transport } from "./types";

export const GDRIVE_SCOPE = "https://www.googleapis.com/auth/drive.file";
export const GDRIVE_AUTH = "https://accounts.google.com/o/oauth2/v2/auth";
export const GDRIVE_TOKEN = "https://oauth2.googleapis.com/token";
const DRIVE = "https://www.googleapis.com/drive/v3";
const UPLOAD = "https://www.googleapis.com/upload/drive/v3";
const FOLDER = "application/vnd.google-apps.folder";
const FIELDS = "id,name,mimeType,modifiedTime,size,parents,trashed";

const PKCE = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-._~";

export function generatePkceVerifier(length = 64): string {
  const n = Math.min(128, Math.max(43, length));
  const bytes = new Uint8Array(n);
  crypto.getRandomValues(bytes);
  let out = "";
  for (let i = 0; i < bytes.length; i++) {
    out += PKCE[bytes[i] % PKCE.length];
  }
  return out;
}

export async function sha256Base64Url(input: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(input));
  const bytes = new Uint8Array(digest);
  let bin = "";
  for (const b of bytes) bin += String.fromCharCode(b);
  return btoa(bin).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

export async function googleAuthUrl(opts: {
  clientId: string;
  redirectUri: string;
  verifier?: string;
}): Promise<{ authUrl: string; verifier: string }> {
  const clientId = opts.clientId.trim();
  if (!clientId) throw new Error("Google OAuth client ID is empty");
  const redirectUri = (opts.redirectUri || "http://127.0.0.1").trim();
  const verifier = opts.verifier || generatePkceVerifier();
  const challenge = await sha256Base64Url(verifier);
  const q = new URLSearchParams({
    client_id: clientId,
    redirect_uri: redirectUri,
    response_type: "code",
    scope: GDRIVE_SCOPE,
    access_type: "offline",
    prompt: "consent",
    code_challenge: challenge,
    code_challenge_method: "S256",
  });
  return { authUrl: `${GDRIVE_AUTH}?${q.toString()}`, verifier };
}

export function extractOAuthCode(input: string): string {
  const trimmed = (input ?? "").trim();
  if (!trimmed) return "";
  try {
    if (trimmed.includes("://") || trimmed.startsWith("?")) {
      const asUrl = trimmed.includes("://") ? trimmed : `http://127.0.0.1/${trimmed}`;
      const code = new URL(asUrl).searchParams.get("code");
      if (code) return code;
    }
  } catch {
    /* fall through */
  }
  const m = /(?:^|[?&#])code=([^&]+)/.exec(trimmed);
  return m?.[1] ? decodeURIComponent(m[1]) : trimmed;
}

type TokenRes = {
  access_token?: string;
  refresh_token?: string;
  expires_in?: number;
  error?: string;
  error_description?: string;
};

export async function exchangeGoogleCode(
  http: Transport,
  cfg: GoogleSettings,
  rawCode: string,
  verifier: string,
): Promise<GoogleSettings> {
  const code = extractOAuthCode(rawCode);
  if (!code) throw new Error("authorization code is empty");
  const body: Record<string, string> = {
    code,
    client_id: cfg.clientId.trim(),
    redirect_uri: (cfg.redirectUri || "http://127.0.0.1").trim(),
    grant_type: "authorization_code",
    code_verifier: verifier,
  };
  if (cfg.clientSecret.trim()) body.client_secret = cfg.clientSecret.trim();
  const res = await http.request({
    url: GDRIVE_TOKEN,
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams(body).toString(),
  });
  assertOk(res, "google token");
  const tok = await readJson<TokenRes>(res);
  if (tok.error || !tok.access_token) {
    throw new Error(tok.error_description || tok.error || "token exchange failed");
  }
  if (!tok.refresh_token) {
    throw new Error(
      "Google 未返回 refresh_token。请到 https://myaccount.google.com/permissions 移除应用后重试",
    );
  }
  return {
    ...cfg,
    accessToken: tok.access_token,
    refreshToken: tok.refresh_token,
    expiry: new Date(Date.now() + (tok.expires_in ?? 3600) * 1000).toISOString(),
    pkceVerifier: "",
    enabled: true,
  };
}

type DriveFile = {
  id: string;
  name: string;
  mimeType: string;
  modifiedTime?: string;
  size?: string;
};

export class GoogleDriveBackend implements Backend {
  kind = "gdrive";
  private rootId = "";
  private idByPath = new Map<string, string>();

  constructor(
    private http: Transport,
    private cfg: GoogleSettings,
    private onToken?: (cfg: GoogleSettings) => Promise<void>,
  ) {}

  private async token(): Promise<string> {
    const exp = this.cfg.expiry ? Date.parse(this.cfg.expiry) : 0;
    if (this.cfg.accessToken && exp > Date.now() + 60_000) {
      return this.cfg.accessToken;
    }
    if (!this.cfg.refreshToken) throw new Error("Google Drive is not authorized");
    const body: Record<string, string> = {
      client_id: this.cfg.clientId.trim(),
      refresh_token: this.cfg.refreshToken,
      grant_type: "refresh_token",
    };
    if (this.cfg.clientSecret.trim()) body.client_secret = this.cfg.clientSecret.trim();
    const res = await this.http.request({
      url: GDRIVE_TOKEN,
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams(body).toString(),
    });
    assertOk(res, "google refresh");
    const tok = await readJson<TokenRes>(res);
    if (!tok.access_token) throw new Error("google refresh failed");
    this.cfg.accessToken = tok.access_token;
    this.cfg.expiry = new Date(Date.now() + (tok.expires_in ?? 3600) * 1000).toISOString();
    await this.onToken?.(this.cfg);
    return this.cfg.accessToken;
  }

  private async api(
    method: string,
    url: string,
    body?: ArrayBuffer | string,
    contentType?: string,
  ): Promise<HttpBag> {
    const token = await this.token();
    const headers: Record<string, string> = { Authorization: `Bearer ${token}` };
    if (contentType) headers["Content-Type"] = contentType;
    const res = await this.http.request({ url, method, headers, body });
    if (res.status >= 400) {
      throw new Error(`gdrive ${method} ${res.status}: ${res.text.slice(0, 240)}`);
    }
    return res;
  }

  private async ensureRoot(): Promise<string> {
    if (this.rootId) return this.rootId;
    const name = this.cfg.remoteDir.trim() || "ObsidianVault";
    const found = await this.findChild("root", name, true);
    if (found) {
      this.rootId = found.id;
      return this.rootId;
    }
    this.rootId = await this.createFolder(name, "root");
    return this.rootId;
  }

  async list(): Promise<FileInfo[]> {
    const root = await this.ensureRoot();
    this.idByPath = new Map([["", root], ["/", root]]);
    const out: FileInfo[] = [];
    const walk = async (parentId: string, prefix: string) => {
      for (const f of await this.listChildren(parentId)) {
        if (f.mimeType.startsWith("application/vnd.google-apps.") && f.mimeType !== FOLDER) {
          continue;
        }
        const isDir = f.mimeType === FOLDER;
        const rel = prefix ? prefix + f.name : f.name;
        const mtimeMs = f.modifiedTime ? Date.parse(f.modifiedTime) : Date.now();
        const size = f.size ? Number(f.size) : 0;
        if (isDir) {
          const dir = rel + "/";
          this.idByPath.set(dir, f.id);
          this.idByPath.set(rel, f.id);
          out.push({ relPath: dir, size: 0, mtimeMs, isDir: true });
          await walk(f.id, dir);
        } else {
          this.idByPath.set(rel, f.id);
          out.push({ relPath: rel, size, mtimeMs, isDir: false });
        }
      }
    };
    await walk(root, "");
    return out;
  }

  async read(relPath: string): Promise<Uint8Array> {
    const id = await this.idOf(relPath);
    const res = await this.api("GET", `${DRIVE}/files/${encodeURIComponent(id)}?alt=media`);
    return new Uint8Array(res.arrayBuffer);
  }

  async write(relPath: string, data: Uint8Array, mtimeMs: number): Promise<void> {
    const { parent, name } = split(relPath);
    const parentId = await this.ensureFolder(parent);
    const existing = await this.findChild(parentId, name, false);
    const meta: Record<string, unknown> = {
      name,
      modifiedTime: new Date(mtimeMs || Date.now()).toISOString(),
    };
    let method = "POST";
    let url = `${UPLOAD}/files?uploadType=multipart&fields=id`;
    if (existing) {
      method = "PATCH";
      url = `${UPLOAD}/files/${encodeURIComponent(existing.id)}?uploadType=multipart&fields=id`;
    } else {
      meta.parents = [parentId];
    }
    const boundary = "clientsync_" + Math.random().toString(36).slice(2);
    const head =
      `--${boundary}\r\nContent-Type: application/json; charset=UTF-8\r\n\r\n` +
      JSON.stringify(meta) +
      `\r\n--${boundary}\r\nContent-Type: application/octet-stream\r\n\r\n`;
    const tail = `\r\n--${boundary}--`;
    const body = concat(
      new TextEncoder().encode(head),
      data,
      new TextEncoder().encode(tail),
    );
    const created = await readJson<DriveFile>(
      await this.api(
        method,
        url,
        body.buffer.slice(body.byteOffset, body.byteOffset + body.byteLength) as ArrayBuffer,
        `multipart/related; boundary=${boundary}`,
      ),
    );
    if (created.id) this.idByPath.set(normalize(relPath), created.id);
  }

  async mkdir(relPath: string): Promise<void> {
    await this.ensureFolder(relPath);
  }

  async remove(relPath: string): Promise<void> {
    const id = await this.idOf(relPath);
    await this.api("DELETE", `${DRIVE}/files/${encodeURIComponent(id)}`);
    this.idByPath.delete(normalize(relPath));
  }

  private async listChildren(parentId: string): Promise<DriveFile[]> {
    const q = `'${parentId}' in parents and trashed = false`;
    const all: DriveFile[] = [];
    let page = "";
    for (;;) {
      const params = new URLSearchParams({
        q,
        fields: `nextPageToken,files(${FIELDS})`,
        pageSize: "1000",
        spaces: "drive",
      });
      if (page) params.set("pageToken", page);
      const res = await this.api("GET", `${DRIVE}/files?${params.toString()}`);
      const parsed = await readJson<{ files?: DriveFile[]; nextPageToken?: string }>(res);
      all.push(...(parsed.files ?? []));
      if (!parsed.nextPageToken) break;
      page = parsed.nextPageToken;
    }
    return all;
  }

  private async findChild(parentId: string, name: string, folder: boolean): Promise<DriveFile | null> {
    const mime = folder ? `mimeType = '${FOLDER}'` : `mimeType != '${FOLDER}'`;
    const esc = name.replace(/\\/g, "\\\\").replace(/'/g, "\\'");
    const q = `'${parentId}' in parents and name = '${esc}' and ${mime} and trashed = false`;
    const params = new URLSearchParams({ q, fields: `files(${FIELDS})` });
    const parsed = await readJson<{ files?: DriveFile[] }>(
      await this.api("GET", `${DRIVE}/files?${params.toString()}`),
    );
    return parsed.files?.[0] ?? null;
  }

  private async createFolder(name: string, parentId: string): Promise<string> {
    const res = await this.api(
      "POST",
      `${DRIVE}/files?fields=id`,
      JSON.stringify({ name, mimeType: FOLDER, parents: [parentId] }),
      "application/json",
    );
    const created = await readJson<DriveFile>(res);
    if (!created.id) throw new Error("gdrive mkdir failed");
    return created.id;
  }

  private async ensureFolder(rel: string): Promise<string> {
    const root = await this.ensureRoot();
    const clean = normalize(rel).replace(/\/+$/, "");
    if (!clean) return root;
    let parent = root;
    let acc = "";
    for (const seg of clean.split("/")) {
      if (!seg) continue;
      acc = acc ? acc + seg + "/" : seg + "/";
      const cached = this.idByPath.get(acc);
      if (cached) {
        parent = cached;
        continue;
      }
      const found = await this.findChild(parent, seg, true);
      parent = found ? found.id : await this.createFolder(seg, parent);
      this.idByPath.set(acc, parent);
    }
    return parent;
  }

  private async idOf(relPath: string): Promise<string> {
    const n = normalize(relPath);
    const hit = this.idByPath.get(n);
    if (hit) return hit;
    await this.list();
    const again = this.idByPath.get(n);
    if (!again) throw new Error(`gdrive path not found: ${relPath}`);
    return again;
  }
}

type HttpBag = import("./types").HttpResponse;

function split(rel: string): { parent: string; name: string } {
  const n = normalize(rel);
  const i = n.lastIndexOf("/");
  if (i < 0) return { parent: "", name: n };
  return { parent: n.slice(0, i), name: n.slice(i + 1) };
}

function concat(...parts: Uint8Array[]): Uint8Array {
  const total = parts.reduce((s, p) => s + p.byteLength, 0);
  const out = new Uint8Array(total);
  let o = 0;
  for (const p of parts) {
    out.set(p, o);
    o += p.byteLength;
  }
  return out;
}
