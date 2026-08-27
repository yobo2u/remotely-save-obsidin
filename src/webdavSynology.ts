/**
 * Synology NAS WebDAV helpers.
 * Pure functions only — no Obsidian / webdav-client imports.
 */

export type WebdavSynologyProtocol = "http" | "https";

export interface WebdavSynologyConfig {
  protocol: WebdavSynologyProtocol;
  host: string;
  port: string;
  sharedFolder: string;
}

export const DEFAULT_WEBDAV_SYNOLOGY: WebdavSynologyConfig = {
  protocol: "https",
  host: "",
  port: "5006",
  sharedFolder: "",
};

export const SYNOLOGY_WEBDAV_HTTP_PORT = "5005";
export const SYNOLOGY_WEBDAV_HTTPS_PORT = "5006";

const SYNOLOGY_HOST_HINTS = [
  "synology",
  ".quickconnect.to",
  ".synology.me",
  ".dsmonline.me",
];

/**
 * Official WebDAV Server package listens on 5005 (http) / 5006 (https).
 * Also treat common Synology DDNS / QuickConnect hostnames as NAS endpoints.
 */
export function isSynologyWebdavAddress(address: string): boolean {
  const raw = (address ?? "").trim();
  if (raw === "") {
    return false;
  }
  try {
    const url = new URL(raw.includes("://") ? raw : `http://${raw}`);
    const port = url.port || (url.protocol === "https:" ? "443" : "80");
    if (
      port === SYNOLOGY_WEBDAV_HTTP_PORT ||
      port === SYNOLOGY_WEBDAV_HTTPS_PORT
    ) {
      return true;
    }
    const host = url.hostname.toLowerCase();
    return SYNOLOGY_HOST_HINTS.some((hint) => host.includes(hint));
  } catch {
    return false;
  }
}

function encodePathSegments(sharedFolder: string): string {
  return sharedFolder
    .trim()
    .replace(/^\/+/, "")
    .replace(/\/+$/, "")
    .split("/")
    .filter((seg) => seg !== "")
    .map((seg) => {
      if (seg.includes("%")) {
        return seg;
      }
      return encodeURIComponent(seg);
    })
    .join("/");
}

/**
 * Build a WebDAV base URL from structured Synology fields.
 * Example: https://192.168.1.10:5006/share2/vault
 */
export function buildSynologyWebdavAddress(
  synology: Partial<WebdavSynologyConfig>
): string {
  const protocol: WebdavSynologyProtocol =
    synology.protocol === "http" ? "http" : "https";
  const host = (synology.host ?? "")
    .trim()
    .replace(/^https?:\/\//i, "")
    .replace(/\/+$/, "")
    .split("/")[0];
  if (host === "") {
    return "";
  }
  const defaultPort =
    protocol === "https"
      ? SYNOLOGY_WEBDAV_HTTPS_PORT
      : SYNOLOGY_WEBDAV_HTTP_PORT;
  const port = (synology.port ?? "").trim() || defaultPort;
  const origin = `${protocol}://${host}:${port}`;
  const folderPath = encodePathSegments(synology.sharedFolder ?? "");
  return folderPath === "" ? origin : `${origin}/${folderPath}`;
}

export function mergeSynologyConfig(
  input?: Partial<WebdavSynologyConfig>
): WebdavSynologyConfig {
  return {
    protocol: input?.protocol === "http" ? "http" : "https",
    host: input?.host ?? "",
    port: input?.port ?? DEFAULT_WEBDAV_SYNOLOGY.port,
    sharedFolder: input?.sharedFolder ?? "",
  };
}

export interface WebdavAddressSource {
  address: string;
  preset?: "generic" | "synology";
  synology?: Partial<WebdavSynologyConfig>;
}

export function resolveWebdavAddress(config: WebdavAddressSource): string {
  if (config.preset === "synology") {
    const built = buildSynologyWebdavAddress(
      mergeSynologyConfig(config.synology)
    );
    if (built !== "") {
      return built;
    }
  }
  return config.address;
}
