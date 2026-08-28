export type ConflictMode = "keep_newer" | "keep_local" | "keep_remote";

export interface FileInfo {
  relPath: string;
  size: number;
  mtimeMs: number;
  isDir: boolean;
}

export interface Backend {
  kind: string;
  list(): Promise<FileInfo[]>;
  read(relPath: string): Promise<Uint8Array>;
  write(relPath: string, data: Uint8Array, mtimeMs: number): Promise<void>;
  mkdir(relPath: string): Promise<void>;
  remove(relPath: string): Promise<void>;
}

export interface HttpRequest {
  url: string;
  method?: string;
  headers?: Record<string, string>;
  body?: string | ArrayBuffer;
}

export interface HttpResponse {
  status: number;
  text: string;
  arrayBuffer: ArrayBuffer;
  headers: Record<string, string>;
}

export interface Transport {
  request(req: HttpRequest): Promise<HttpResponse>;
}

export interface FileState {
  localMtime: number;
  remoteMtime: number;
  size: number;
}

export interface Snapshot {
  updated: number;
  files: Record<string, FileState>;
}

export interface SyncResult {
  remote: string;
  pushed: number;
  pulled: number;
  deletedLocal: number;
  deletedRemote: number;
  conflicts: number;
  skipped: number;
  errors: string[];
}

export interface GoogleSettings {
  enabled: boolean;
  clientId: string;
  clientSecret: string;
  redirectUri: string;
  refreshToken: string;
  accessToken: string;
  expiry: string;
  remoteDir: string;
  pkceVerifier: string;
}

export interface NasSettings {
  enabled: boolean;
  host: string;
  port: number;
  https: boolean;
  insecureTLS: boolean;
  username: string;
  password: string;
  remoteDir: string;
}

export interface PluginSettings {
  ignoreDotObsidian: boolean;
  conflict: ConflictMode;
  autoSyncMinutes: number;
  skipLargeMB: number;
  google: GoogleSettings;
  synology: NasSettings;
  qnap: NasSettings;
}

export const DEFAULT_SETTINGS: PluginSettings = {
  ignoreDotObsidian: true,
  conflict: "keep_newer",
  autoSyncMinutes: 0,
  skipLargeMB: 50,
  google: {
    enabled: false,
    clientId: "",
    clientSecret: "",
    redirectUri: "http://127.0.0.1",
    refreshToken: "",
    accessToken: "",
    expiry: "",
    remoteDir: "",
    pkceVerifier: "",
  },
  synology: {
    enabled: false,
    host: "",
    port: 5000,
    https: false,
    insecureTLS: true,
    username: "",
    password: "",
    remoteDir: "",
  },
  qnap: {
    enabled: false,
    host: "",
    port: 8080,
    https: false,
    insecureTLS: true,
    username: "",
    password: "",
    remoteDir: "",
  },
};
