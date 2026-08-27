/**
 * Google Drive OAuth helpers that do not depend on Obsidian APIs.
 */

export const GDRIVE_SCOPE = "https://www.googleapis.com/auth/drive.file";
export const GDRIVE_AUTH_ENDPOINT =
  "https://accounts.google.com/o/oauth2/v2/auth";
export const GDRIVE_TOKEN_ENDPOINT = "https://oauth2.googleapis.com/token";
export const GDRIVE_REVOKE_ENDPOINT = "https://oauth2.googleapis.com/revoke";
export const GDRIVE_DEFAULT_REDIRECT_URI = "http://127.0.0.1";
export const GDRIVE_FOLDER_MIME = "application/vnd.google-apps.folder";

const PKCE_ALPHABET =
  "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-._~";

export function generatePkceVerifier(length = 64): string {
  const size = Math.min(128, Math.max(43, length));
  const bytes = new Uint8Array(size);
  crypto.getRandomValues(bytes);
  let out = "";
  for (let i = 0; i < bytes.length; i++) {
    out += PKCE_ALPHABET[bytes[i] % PKCE_ALPHABET.length];
  }
  return out;
}

export async function sha256Base64Url(input: string): Promise<string> {
  const data = new TextEncoder().encode(input);
  const digest = await crypto.subtle.digest("SHA-256", data);
  const bytes = new Uint8Array(digest);
  let binary = "";
  for (let i = 0; i < bytes.length; i++) {
    binary += String.fromCharCode(bytes[i]);
  }
  return btoa(binary)
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/, "");
}

export async function generateGDriveAuthUrl(params: {
  clientID: string;
  redirectUri: string;
  verifier?: string;
}): Promise<{ authUrl: string; verifier: string }> {
  const clientID = params.clientID.trim();
  if (clientID === "") {
    throw Error("Google OAuth client ID is empty.");
  }
  const redirectUri = (
    params.redirectUri || GDRIVE_DEFAULT_REDIRECT_URI
  ).trim();
  const verifier = params.verifier || generatePkceVerifier();
  const challenge = await sha256Base64Url(verifier);
  const query = new URLSearchParams({
    client_id: clientID,
    redirect_uri: redirectUri,
    response_type: "code",
    scope: GDRIVE_SCOPE,
    access_type: "offline",
    prompt: "consent",
    code_challenge: challenge,
    code_challenge_method: "S256",
  });
  return {
    authUrl: `${GDRIVE_AUTH_ENDPOINT}?${query.toString()}`,
    verifier,
  };
}

/**
 * Accept a raw authorization code, a redirect URL, or a query string.
 */
export function extractOAuthCode(input: string): string {
  const trimmed = (input ?? "").trim();
  if (trimmed === "") {
    return "";
  }
  try {
    if (trimmed.includes("://") || trimmed.startsWith("?")) {
      const asUrl = trimmed.includes("://")
        ? trimmed
        : `http://127.0.0.1/${trimmed}`;
      const url = new URL(asUrl);
      const code = url.searchParams.get("code");
      if (code) {
        return code;
      }
    }
  } catch {
    // fall through
  }
  const codeMatch = /(?:^|[?&#])code=([^&]+)/.exec(trimmed);
  if (codeMatch?.[1]) {
    return decodeURIComponent(codeMatch[1]);
  }
  return trimmed;
}

export function escapeDriveQueryValue(value: string): string {
  return value.replace(/\\/g, "\\\\").replace(/'/g, "\\'");
}

export function concatArrayBuffers(
  parts: Array<ArrayBuffer | Uint8Array>
): ArrayBuffer {
  const views = parts.map((part) =>
    part instanceof Uint8Array ? part : new Uint8Array(part)
  );
  const total = views.reduce((sum, part) => sum + part.byteLength, 0);
  const out = new Uint8Array(new ArrayBuffer(total));
  let offset = 0;
  for (const part of views) {
    out.set(part, offset);
    offset += part.byteLength;
  }
  return out.buffer as ArrayBuffer;
}

export function isGoogleNativeMime(mimeType: string | undefined): boolean {
  return (mimeType ?? "").startsWith("application/vnd.google-apps.");
}
