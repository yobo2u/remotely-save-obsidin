import type { Transport } from "./types";

export type DiscoveredNas = {
  kind: "synology" | "qnap";
  host: string;
  httpPort: number;
  httpsPort: number;
};

function hostOnly(host: string): string {
  return host
    .trim()
    .replace(/^https?:\/\//, "")
    .replace(/\/+$/, "")
    .replace(/:\d+$/, "");
}

export function rfc1918Hosts24(): string[] {
  try {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const os = require("os") as typeof import("os");
    const nets = os.networkInterfaces();
    const hosts: string[] = [];
    for (const addrs of Object.values(nets)) {
      for (const a of addrs ?? []) {
        const ip = a.address;
        const parts = ip.split(".").map(Number);
        if (parts.length !== 4 || a.internal) continue;
        const [a0, a1, a2, a3] = parts;
        const priv =
          a0 === 10 ||
          (a0 === 192 && a1 === 168) ||
          (a0 === 172 && a1 >= 16 && a1 <= 31);
        if (!priv) continue;
        for (let i = 1; i < 255; i++) {
          if (i === a3) continue;
          hosts.push(`${a0}.${a1}.${a2}.${i}`);
        }
      }
    }
    return hosts;
  } catch {
    return [];
  }
}

export async function probeNas(
  http: Transport,
  host: string,
): Promise<DiscoveredNas | null> {
  const ip = hostOnly(host);
  const syno = await probeText(
    http,
    `http://${ip}:5000/webapi/query.cgi?api=SYNO.API.Info&version=1&method=query&query=SYNO.API.Auth`,
  );
  if (syno && (syno.includes("SYNO.API") || syno.includes('"success"'))) {
    return { kind: "synology", host: ip, httpPort: 5000, httpsPort: 5001 };
  }
  const qnap = await probeText(http, `http://${ip}:8080/cgi-bin/authLogin.cgi`);
  if (qnap && (qnap.includes("QDocRoot") || qnap.includes("authPassed") || qnap.includes("QNAP"))) {
    return { kind: "qnap", host: ip, httpPort: 8080, httpsPort: 443 };
  }
  return null;
}

async function probeText(http: Transport, url: string): Promise<string | null> {
  try {
    const res = await http.request({ url });
    if (res.status >= 400) return null;
    return res.text;
  } catch {
    return null;
  }
}

export async function discoverNas(
  http: Transport,
  onProgress?: (msg: string) => void,
): Promise<DiscoveredNas[]> {
  const hosts = rfc1918Hosts24();
  if (hosts.length === 0) {
    throw new Error("未找到本机私有网卡，请手动填写 NAS IP");
  }
  onProgress?.(`正在扫描 ${hosts.length} 个局域网地址（仅 RFC1918 /24）…`);
  const found = new Map<string, DiscoveredNas>();
  const queue = [...hosts];
  const workers = Array.from({ length: 24 }, async () => {
    while (queue.length) {
      const ip = queue.shift();
      if (!ip) return;
      const hit = await probeNas(http, ip);
      if (hit) found.set(`${hit.kind}:${hit.host}`, hit);
    }
  });
  await Promise.all(workers);
  return [...found.values()];
}

export function pickShare(shares: string[], vaultName: string): string {
  const preferred = ["/home", "/homes", "/Public", "/public", "/docker"];
  for (const p of preferred) {
    if (shares.includes(p)) return `${p.replace(/\/+$/, "")}/${vaultName}`;
  }
  const first = shares[0] || "/home";
  return `${first.replace(/\/+$/, "")}/${vaultName}`;
}
