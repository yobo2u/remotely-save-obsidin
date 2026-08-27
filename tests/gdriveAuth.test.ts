import { strict as assert } from "assert";
import {
  escapeDriveQueryValue,
  extractOAuthCode,
  generateGDriveAuthUrl,
  generatePkceVerifier,
  isGoogleNativeMime,
  sha256Base64Url,
} from "../src/gdriveAuth";

describe("Google Drive OAuth helpers", () => {
  it("extracts code from a redirect URL", () => {
    const code = extractOAuthCode(
      "http://127.0.0.1/?code=4/0AanRRrsXYZ&scope=https://www.googleapis.com/auth/drive.file"
    );
    assert.equal(code, "4/0AanRRrsXYZ");
  });

  it("extracts code from a query string", () => {
    assert.equal(extractOAuthCode("code=abc%2Fdef&scope=x"), "abc/def");
  });

  it("keeps a raw authorization code", () => {
    assert.equal(extractOAuthCode("  4/0AanHello  "), "4/0AanHello");
  });

  it("escapes Drive query values", () => {
    assert.equal(escapeDriveQueryValue("O'Brien\\Notes"), "O\\'Brien\\\\Notes");
  });

  it("detects Google-native docs mime types", () => {
    assert.equal(
      isGoogleNativeMime("application/vnd.google-apps.document"),
      true
    );
    assert.equal(
      isGoogleNativeMime("application/vnd.google-apps.folder"),
      true
    );
    assert.equal(isGoogleNativeMime("text/markdown"), false);
  });

  it("builds an auth URL with PKCE", async () => {
    const { authUrl, verifier } = await generateGDriveAuthUrl({
      clientID: "abc.apps.googleusercontent.com",
      redirectUri: "http://127.0.0.1",
      verifier: "a".repeat(64),
    });
    const url = new URL(authUrl);
    assert.equal(url.origin, "https://accounts.google.com");
    assert.equal(
      url.searchParams.get("client_id"),
      "abc.apps.googleusercontent.com"
    );
    assert.equal(url.searchParams.get("redirect_uri"), "http://127.0.0.1");
    assert.equal(url.searchParams.get("code_challenge_method"), "S256");
    assert.equal(url.searchParams.get("access_type"), "offline");
    assert.equal(verifier.length, 64);
    const challenge = await sha256Base64Url(verifier);
    assert.equal(url.searchParams.get("code_challenge"), challenge);
  });

  it("generates a PKCE verifier in the required length range", () => {
    const verifier = generatePkceVerifier();
    assert.equal(verifier.length >= 43, true);
    assert.equal(verifier.length <= 128, true);
  });
});
