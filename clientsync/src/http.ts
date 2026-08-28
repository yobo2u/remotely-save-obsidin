import type { HttpRequest, HttpResponse, Transport } from "./types";

export async function readJson<T>(res: HttpResponse): Promise<T> {
  if (!res.text) {
    return {} as T;
  }
  return JSON.parse(res.text) as T;
}

export function assertOk(res: HttpResponse, label: string): void {
  if (res.status >= 400) {
    throw new Error(`${label} HTTP ${res.status}: ${res.text.slice(0, 240)}`);
  }
}

export function joinUrl(base: string, path: string): string {
  return base.replace(/\/+$/, "") + "/" + path.replace(/^\/+/, "");
}

/**
 * Desktop-only HTTPS with optional self-signed certs. Mobile uses Obsidian requestUrl.
 */
export function nodeTransport(insecureTLS: boolean): Transport | null {
  try {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const http = require("http") as typeof import("http");
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const https = require("https") as typeof import("https");
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const { URL } = require("url") as typeof import("url");
    return {
      request(req: HttpRequest): Promise<HttpResponse> {
        return new Promise((resolve, reject) => {
          const u = new URL(req.url);
          const lib = u.protocol === "https:" ? https : http;
          const headers = { ...(req.headers ?? {}) };
          let body: Buffer | undefined;
          if (typeof req.body === "string") {
            body = Buffer.from(req.body);
          } else if (req.body) {
            body = Buffer.from(new Uint8Array(req.body));
          }
          if (body && !headers["Content-Length"]) {
            headers["Content-Length"] = String(body.length);
          }
          const r = lib.request(
            {
              protocol: u.protocol,
              hostname: u.hostname,
              port: u.port,
              path: u.pathname + u.search,
              method: req.method ?? "GET",
              headers,
              rejectUnauthorized: !insecureTLS,
              timeout: 60000,
            },
            (rsp) => {
              const chunks: Buffer[] = [];
              rsp.on("data", (c) => chunks.push(c as Buffer));
              rsp.on("end", () => {
                const buf = Buffer.concat(chunks);
                const headersOut: Record<string, string> = {};
                for (const [k, v] of Object.entries(rsp.headers)) {
                  if (typeof v === "string") {
                    headersOut[k.toLowerCase()] = v;
                  }
                }
                const arrayBuffer = buf.buffer.slice(
                  buf.byteOffset,
                  buf.byteOffset + buf.byteLength,
                );
                resolve({
                  status: rsp.statusCode ?? 0,
                  text: buf.toString("utf8"),
                  arrayBuffer,
                  headers: headersOut,
                });
              });
            },
          );
          r.on("error", reject);
          if (body) {
            r.write(body);
          }
          r.end();
        });
      },
    };
  } catch {
    return null;
  }
}

export function obsidianTransport(
  requestUrl: (args: {
    url: string;
    method?: string;
    headers?: Record<string, string>;
    body?: string | ArrayBuffer;
    throw?: boolean;
  }) => Promise<{
    status: number;
    text: string;
    arrayBuffer: ArrayBuffer;
    headers: Record<string, string>;
  }>,
): Transport {
  return {
    async request(req: HttpRequest): Promise<HttpResponse> {
      const res = await requestUrl({
        url: req.url,
        method: req.method ?? "GET",
        headers: req.headers,
        body: req.body,
        throw: false,
      });
      return {
        status: res.status,
        text: res.text ?? "",
        arrayBuffer: res.arrayBuffer,
        headers: res.headers ?? {},
      };
    },
  };
}

/** Prefer Node insecure HTTPS for LAN NAS certs; otherwise Obsidian requestUrl (CORS bypass). */
export function nasTransport(
  obsidian: Transport,
  insecureTLS: boolean,
): Transport {
  const node = insecureTLS ? nodeTransport(true) : null;
  if (!node) {
    return obsidian;
  }
  return {
    async request(req: HttpRequest): Promise<HttpResponse> {
      if (req.url.startsWith("https://")) {
        try {
          return await node.request(req);
        } catch {
          return obsidian.request(req);
        }
      }
      return obsidian.request(req);
    },
  };
}
