import cloneDeep from "lodash/cloneDeep";
import { nanoid } from "nanoid";
import { requestUrl } from "obsidian";
import {
  type Entity,
  type GDriveConfig,
  OAUTH2_FORCE_EXPIRE_MILLISECONDS,
} from "./baseTypes";
import { FakeFs } from "./fsAll";
import {
  GDRIVE_DEFAULT_REDIRECT_URI,
  GDRIVE_FOLDER_MIME,
  GDRIVE_REVOKE_ENDPOINT,
  GDRIVE_SCOPE,
  GDRIVE_TOKEN_ENDPOINT,
  concatArrayBuffers,
  escapeDriveQueryValue,
  extractOAuthCode,
  isGoogleNativeMime,
} from "./gdriveAuth";
import { getFolderLevels, getParentFolder } from "./misc";

export const DEFAULT_GDRIVE_CONFIG: GDriveConfig = {
  accessToken: "",
  accessTokenExpiresInMs: 0,
  accessTokenExpiresAtTimeMs: 0,
  refreshToken: "",
  remoteBaseDir: "",
  credentialsShouldBeDeletedAtTimeMs: 0,
  clientID: "",
  clientSecret: "",
  redirectUri: GDRIVE_DEFAULT_REDIRECT_URI,
  scope: GDRIVE_SCOPE,
  kind: "gdrive",
};

interface GDriveFile {
  id: string;
  name: string;
  mimeType: string;
  modifiedTime?: string;
  createdTime?: string;
  size?: string;
  md5Checksum?: string;
  parents?: string[];
  trashed?: boolean;
}

interface TokenResponse {
  access_token?: string;
  refresh_token?: string;
  expires_in?: number;
  token_type?: string;
  error?: string;
  error_description?: string;
}

const DRIVE_API = "https://www.googleapis.com/drive/v3";
const DRIVE_UPLOAD_API = "https://www.googleapis.com/upload/drive/v3";
const FILE_FIELDS =
  "id,name,mimeType,modifiedTime,createdTime,size,md5Checksum,parents,trashed";

const formBody = (params: Record<string, string>) =>
  new URLSearchParams(params).toString();

export const sendGDriveAuthReq = async (
  clientID: string,
  clientSecret: string,
  redirectUri: string,
  verifier: string,
  rawCode: string
): Promise<TokenResponse> => {
  const code = extractOAuthCode(rawCode);
  if (code === "") {
    throw Error("authorization code is empty");
  }
  const body: Record<string, string> = {
    code,
    client_id: clientID.trim(),
    redirect_uri: (redirectUri || GDRIVE_DEFAULT_REDIRECT_URI).trim(),
    grant_type: "authorization_code",
    code_verifier: verifier,
  };
  if (clientSecret.trim() !== "") {
    body.client_secret = clientSecret.trim();
  }
  const rsp = await requestUrl({
    url: GDRIVE_TOKEN_ENDPOINT,
    method: "POST",
    contentType: "application/x-www-form-urlencoded",
    body: formBody(body),
    throw: false,
  });
  const parsed = (await safeParseJson(rsp)) as TokenResponse;
  if (rsp.status >= 400 || parsed.error) {
    throw Error(
      parsed.error_description ||
        parsed.error ||
        `Google token exchange failed (HTTP ${rsp.status})`
    );
  }
  return parsed;
};

export const sendGDriveRefreshTokenReq = async (
  clientID: string,
  clientSecret: string,
  refreshToken: string
): Promise<TokenResponse> => {
  const body: Record<string, string> = {
    client_id: clientID.trim(),
    refresh_token: refreshToken,
    grant_type: "refresh_token",
  };
  if (clientSecret.trim() !== "") {
    body.client_secret = clientSecret.trim();
  }
  const rsp = await requestUrl({
    url: GDRIVE_TOKEN_ENDPOINT,
    method: "POST",
    contentType: "application/x-www-form-urlencoded",
    body: formBody(body),
    throw: false,
  });
  const parsed = (await safeParseJson(rsp)) as TokenResponse;
  if (rsp.status >= 400 || parsed.error) {
    throw Error(
      parsed.error_description ||
        parsed.error ||
        `Google token refresh failed (HTTP ${rsp.status})`
    );
  }
  return parsed;
};

export const setGDriveConfigBySuccessfulAuth = (
  config: GDriveConfig,
  authRes: TokenResponse,
  nowMs: number
) => {
  if (!authRes.access_token) {
    throw Error("Google auth response has no access_token");
  }
  config.accessToken = authRes.access_token;
  config.accessTokenExpiresInMs = (authRes.expires_in ?? 3600) * 1000;
  config.accessTokenExpiresAtTimeMs = nowMs + config.accessTokenExpiresInMs;
  if (authRes.refresh_token) {
    config.refreshToken = authRes.refresh_token;
  }
  config.credentialsShouldBeDeletedAtTimeMs =
    nowMs + OAUTH2_FORCE_EXPIRE_MILLISECONDS;
  config.scope = GDRIVE_SCOPE;
  config.kind = "gdrive";
};

async function safeParseJson(rsp: {
  json?: any;
  text?: string;
}): Promise<any> {
  if (rsp.json !== undefined && rsp.json !== null) {
    try {
      return typeof rsp.json === "string" ? JSON.parse(rsp.json) : rsp.json;
    } catch {
      // fall through
    }
  }
  if (typeof rsp.text === "string" && rsp.text !== "") {
    try {
      return JSON.parse(rsp.text);
    } catch {
      return { error: rsp.text };
    }
  }
  return {};
}

function fromDriveFileToEntity(
  file: GDriveFile,
  relativeKey: string
): Entity | undefined {
  if (
    isGoogleNativeMime(file.mimeType) &&
    file.mimeType !== GDRIVE_FOLDER_MIME
  ) {
    return undefined;
  }
  const isFolder = file.mimeType === GDRIVE_FOLDER_MIME;
  let key = relativeKey;
  if (isFolder && !key.endsWith("/")) {
    key = `${key}/`;
  }
  const mtime = file.modifiedTime
    ? Date.parse(file.modifiedTime).valueOf()
    : undefined;
  const ctime = file.createdTime
    ? Date.parse(file.createdTime).valueOf()
    : undefined;
  const size = file.size !== undefined ? Number(file.size) : 0;
  return {
    key,
    keyRaw: key,
    mtimeCli: mtime,
    mtimeSvr: mtime,
    ctimeCli: ctime,
    size: isFolder ? 0 : size,
    sizeRaw: isFolder ? 0 : size,
    hash: file.md5Checksum,
  };
}

export class FakeFsGDrive extends FakeFs {
  kind: "gdrive";
  gdriveConfig: GDriveConfig;
  remoteBaseDir: string;
  saveUpdatedConfigFunc: () => Promise<any>;
  vaultFolderId = "";
  private pathToId: Map<string, string> = new Map();

  constructor(
    gdriveConfig: GDriveConfig,
    vaultName: string,
    saveUpdatedConfigFunc: () => Promise<any>
  ) {
    super();
    this.kind = "gdrive";
    this.gdriveConfig = cloneDeep(gdriveConfig);
    this.remoteBaseDir = this.gdriveConfig.remoteBaseDir || vaultName || "";
    this.saveUpdatedConfigFunc = saveUpdatedConfigFunc;
  }

  private async ensureAccessToken() {
    if (this.gdriveConfig.refreshToken === "") {
      throw Error(
        "Google Drive is not authorized. Please complete OAuth first."
      );
    }
    const stillValid =
      this.gdriveConfig.accessToken !== "" &&
      this.gdriveConfig.accessTokenExpiresAtTimeMs > Date.now() + 60 * 1000;
    if (stillValid) {
      return;
    }
    const token = await sendGDriveRefreshTokenReq(
      this.gdriveConfig.clientID,
      this.gdriveConfig.clientSecret,
      this.gdriveConfig.refreshToken
    );
    setGDriveConfigBySuccessfulAuth(this.gdriveConfig, token, Date.now());
    await this.saveUpdatedConfigFunc?.();
  }

  private async driveRequest(opts: {
    url: string;
    method?: string;
    headers?: Record<string, string>;
    body?: string | ArrayBuffer;
    contentType?: string;
  }): Promise<{ status: number; json: any; arrayBuffer: ArrayBuffer }> {
    await this.ensureAccessToken();
    const headers: Record<string, string> = {
      Authorization: `Bearer ${this.gdriveConfig.accessToken}`,
      ...(opts.headers ?? {}),
    };
    const waitMs = [0, 1000, 2000, 4000];
    let lastErr: Error | undefined;
    for (let i = 0; i < waitMs.length; i++) {
      if (waitMs[i] > 0) {
        await new Promise((resolve) => setTimeout(resolve, waitMs[i]));
      }
      const rsp = await requestUrl({
        url: opts.url,
        method: opts.method ?? "GET",
        headers,
        body: opts.body,
        contentType: opts.contentType,
        throw: false,
      });
      if (rsp.status === 429 || rsp.status >= 500) {
        lastErr = Error(
          `Google Drive HTTP ${rsp.status}: ${rsp.text ?? ""}`.slice(0, 300)
        );
        continue;
      }
      let json: any = {};
      if (rsp.json !== undefined) {
        json = rsp.json;
      } else if (typeof rsp.text === "string" && rsp.text.startsWith("{")) {
        try {
          json = JSON.parse(rsp.text);
        } catch {
          json = {};
        }
      }
      if (rsp.status >= 400) {
        const msg =
          json?.error?.message ||
          json?.error_description ||
          `Google Drive HTTP ${rsp.status}`;
        throw Error(msg);
      }
      return { status: rsp.status, json, arrayBuffer: rsp.arrayBuffer };
    }
    throw lastErr ?? Error("Google Drive request failed after retries");
  }

  private async listByQuery(q: string): Promise<GDriveFile[]> {
    const files: GDriveFile[] = [];
    let pageToken = "";
    do {
      const params = new URLSearchParams({
        q,
        fields: `nextPageToken,files(${FILE_FIELDS})`,
        pageSize: "1000",
        spaces: "drive",
        includeItemsFromAllDrives: "false",
        supportsAllDrives: "false",
      });
      if (pageToken) {
        params.set("pageToken", pageToken);
      }
      const rsp = await this.driveRequest({
        url: `${DRIVE_API}/files?${params.toString()}`,
      });
      files.push(...((rsp.json.files ?? []) as GDriveFile[]));
      pageToken = rsp.json.nextPageToken ?? "";
    } while (pageToken);
    return files;
  }

  private remember(pathKey: string, id: string) {
    this.pathToId.set(pathKey, id);
    if (pathKey.endsWith("/")) {
      this.pathToId.set(pathKey.slice(0, -1), id);
    }
  }

  private async ensureVaultFolder(): Promise<string> {
    if (this.vaultFolderId) {
      return this.vaultFolderId;
    }
    const name = this.remoteBaseDir;
    const q = `name = '${escapeDriveQueryValue(
      name
    )}' and mimeType = '${GDRIVE_FOLDER_MIME}' and 'root' in parents and trashed = false`;
    const existing = await this.listByQuery(q);
    if (existing.length > 0) {
      this.vaultFolderId = existing[0].id;
    } else {
      const created = await this.createFolderMeta(name, "root");
      this.vaultFolderId = created.id;
    }
    this.remember("", this.vaultFolderId);
    this.remember("/", this.vaultFolderId);
    return this.vaultFolderId;
  }

  private async createFolderMeta(
    name: string,
    parentId: string
  ): Promise<GDriveFile> {
    const rsp = await this.driveRequest({
      url: `${DRIVE_API}/files?fields=${encodeURIComponent(FILE_FIELDS)}`,
      method: "POST",
      contentType: "application/json; charset=UTF-8",
      body: JSON.stringify({
        name,
        mimeType: GDRIVE_FOLDER_MIME,
        parents: [parentId],
      }),
    });
    return rsp.json as GDriveFile;
  }

  private async findChild(
    parentId: string,
    name: string,
    folder: boolean
  ): Promise<GDriveFile | undefined> {
    const mimeClause = folder
      ? `mimeType = '${GDRIVE_FOLDER_MIME}'`
      : `mimeType != '${GDRIVE_FOLDER_MIME}'`;
    const q = `'${parentId}' in parents and name = '${escapeDriveQueryValue(
      name
    )}' and ${mimeClause} and trashed = false`;
    const found = await this.listByQuery(q);
    if (found.length === 0) {
      return undefined;
    }
    found.sort((a, b) =>
      (b.modifiedTime ?? "").localeCompare(a.modifiedTime ?? "")
    );
    return found[0];
  }

  private keyToName(key: string): string {
    const trimmed = key.endsWith("/") ? key.slice(0, -1) : key;
    const segs = trimmed.split("/").filter((x) => x !== "");
    return segs[segs.length - 1] ?? trimmed;
  }

  private async resolveParentId(key: string): Promise<string> {
    const parentKey = getParentFolder(key);
    if (parentKey === "/" || parentKey === "") {
      return await this.ensureVaultFolder();
    }
    return await this.ensureFolder(parentKey);
  }

  private async ensureFolder(folderKey: string): Promise<string> {
    const norm = folderKey.endsWith("/") ? folderKey : `${folderKey}/`;
    const cached = this.pathToId.get(norm) || this.pathToId.get(folderKey);
    if (cached) {
      return cached;
    }
    await this.ensureVaultFolder();
    const levels = getFolderLevels(norm, true);
    let parentId = this.vaultFolderId;
    let acc = "";
    for (const level of levels) {
      const withSlash = level.endsWith("/") ? level : `${level}/`;
      const cachedLevel = this.pathToId.get(withSlash);
      if (cachedLevel) {
        parentId = cachedLevel;
        acc = withSlash;
        continue;
      }
      const name = this.keyToName(withSlash);
      let child = await this.findChild(parentId, name, true);
      if (child === undefined) {
        child = await this.createFolderMeta(name, parentId);
      }
      this.remember(withSlash, child.id);
      parentId = child.id;
      acc = withSlash;
    }
    if (acc !== norm) {
      const name = this.keyToName(norm);
      let child = await this.findChild(parentId, name, true);
      if (child === undefined) {
        child = await this.createFolderMeta(name, parentId);
      }
      this.remember(norm, child.id);
      parentId = child.id;
    }
    return parentId;
  }

  async walk(): Promise<Entity[]> {
    await this.ensureVaultFolder();
    const entities: Entity[] = [];
    const queue: { id: string; prefix: string }[] = [
      { id: this.vaultFolderId, prefix: "" },
    ];
    while (queue.length > 0) {
      const curr = queue.shift()!;
      const files = await this.listByQuery(
        `'${curr.id}' in parents and trashed = false`
      );
      for (const file of files) {
        const relative =
          curr.prefix === "" ? file.name : `${curr.prefix}${file.name}`;
        const entity = fromDriveFileToEntity(
          file,
          file.mimeType === GDRIVE_FOLDER_MIME ? `${relative}/` : relative
        );
        if (entity === undefined) {
          continue;
        }
        this.remember(entity.keyRaw, file.id);
        entities.push(entity);
        if (file.mimeType === GDRIVE_FOLDER_MIME) {
          queue.push({ id: file.id, prefix: entity.keyRaw });
        }
      }
    }
    return entities;
  }

  async walkPartial(): Promise<Entity[]> {
    return await this.walk();
  }

  async stat(key: string): Promise<Entity> {
    const id = await this.idForExisting(key);
    const rsp = await this.driveRequest({
      url: `${DRIVE_API}/files/${encodeURIComponent(
        id
      )}?fields=${encodeURIComponent(FILE_FIELDS)}`,
    });
    const entity = fromDriveFileToEntity(rsp.json as GDriveFile, key);
    if (entity === undefined) {
      throw Error(`unsupported Google Drive object: ${key}`);
    }
    return entity;
  }

  private async idForExisting(key: string): Promise<string> {
    const cached = this.pathToId.get(key);
    if (cached) {
      return cached;
    }
    if (key === "" || key === "/") {
      return await this.ensureVaultFolder();
    }
    if (key.endsWith("/")) {
      return await this.ensureFolder(key);
    }
    const parentId = await this.resolveParentId(key);
    const found = await this.findChild(parentId, this.keyToName(key), false);
    if (found === undefined) {
      throw Error(`remote file not found: ${key}`);
    }
    this.remember(key, found.id);
    return found.id;
  }

  async mkdir(key: string, mtime?: number, ctime?: number): Promise<Entity> {
    const id = await this.ensureFolder(key);
    if (mtime !== undefined || ctime !== undefined) {
      const meta: Record<string, string> = {};
      if (mtime !== undefined) {
        meta.modifiedTime = new Date(mtime).toISOString();
      }
      if (ctime !== undefined) {
        meta.createdTime = new Date(ctime).toISOString();
      }
      await this.driveRequest({
        url: `${DRIVE_API}/files/${encodeURIComponent(
          id
        )}?fields=${encodeURIComponent(FILE_FIELDS)}`,
        method: "PATCH",
        contentType: "application/json; charset=UTF-8",
        body: JSON.stringify(meta),
      });
    }
    return await this.stat(key.endsWith("/") ? key : `${key}/`);
  }

  async writeFile(
    key: string,
    content: ArrayBuffer,
    mtime: number,
    ctime: number
  ): Promise<Entity> {
    const parentId = await this.resolveParentId(key);
    const name = this.keyToName(key);
    const existing = await this.findChild(parentId, name, false);
    const metadata: Record<string, unknown> = {
      name,
      modifiedTime: new Date(mtime).toISOString(),
      createdTime: new Date(ctime).toISOString(),
    };
    if (existing === undefined) {
      metadata.parents = [parentId];
    }
    const boundary = `rs_gdrive_${nanoid()}`;
    const encoder = new TextEncoder();
    const preamble = encoder.encode(
      `--${boundary}\r\nContent-Type: application/json; charset=UTF-8\r\n\r\n${JSON.stringify(
        metadata
      )}\r\n--${boundary}\r\nContent-Type: application/octet-stream\r\n\r\n`
    );
    const closing = encoder.encode(`\r\n--${boundary}--`);
    const body = concatArrayBuffers([
      preamble,
      new Uint8Array(content),
      closing,
    ]);
    const fileIdPart = existing ? `/${encodeURIComponent(existing.id)}` : "";
    const method = existing ? "PATCH" : "POST";
    const rsp = await this.driveRequest({
      url: `${DRIVE_UPLOAD_API}/files${fileIdPart}?uploadType=multipart&fields=${encodeURIComponent(
        FILE_FIELDS
      )}`,
      method,
      headers: {
        "Content-Type": `multipart/related; boundary=${boundary}`,
      },
      contentType: `multipart/related; boundary=${boundary}`,
      body,
    });
    const file = rsp.json as GDriveFile;
    this.remember(key, file.id);
    const entity = fromDriveFileToEntity(file, key);
    if (entity === undefined) {
      throw Error(`failed to upload ${key}`);
    }
    return entity;
  }

  async readFile(key: string): Promise<ArrayBuffer> {
    const id = await this.idForExisting(key);
    const rsp = await this.driveRequest({
      url: `${DRIVE_API}/files/${encodeURIComponent(id)}?alt=media`,
    });
    return rsp.arrayBuffer;
  }

  async rename(key1: string, key2: string): Promise<void> {
    const id = await this.idForExisting(key1);
    const oldParent = await this.resolveParentId(key1);
    const newParent = await this.resolveParentId(key2);
    const params = new URLSearchParams({
      fields: FILE_FIELDS,
    });
    if (oldParent !== newParent) {
      params.set("addParents", newParent);
      params.set("removeParents", oldParent);
    }
    await this.driveRequest({
      url: `${DRIVE_API}/files/${encodeURIComponent(id)}?${params.toString()}`,
      method: "PATCH",
      contentType: "application/json; charset=UTF-8",
      body: JSON.stringify({ name: this.keyToName(key2) }),
    });
    this.pathToId.delete(key1);
    this.remember(key2, id);
  }

  async rm(key: string): Promise<void> {
    const id = await this.idForExisting(key);
    await this.driveRequest({
      url: `${DRIVE_API}/files/${encodeURIComponent(id)}`,
      method: "DELETE",
    });
    this.pathToId.delete(key);
  }

  async checkConnect(callbackFunc?: any): Promise<boolean> {
    try {
      await this.ensureVaultFolder();
    } catch (err) {
      console.debug(err);
      callbackFunc?.(err);
      return false;
    }
    return await this.checkConnectCommonOps(callbackFunc);
  }

  async getUserDisplayName(): Promise<string> {
    const rsp = await this.driveRequest({
      url: `${DRIVE_API}/about?fields=user`,
    });
    return rsp.json?.user?.displayName || rsp.json?.user?.emailAddress || "";
  }

  async revokeAuth(): Promise<any> {
    if (this.gdriveConfig.accessToken) {
      await requestUrl({
        url: `${GDRIVE_REVOKE_ENDPOINT}?token=${encodeURIComponent(
          this.gdriveConfig.accessToken
        )}`,
        method: "POST",
        throw: false,
      });
    }
  }

  allowEmptyFile(): boolean {
    return true;
  }
}
