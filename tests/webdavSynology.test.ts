import { strict as assert } from "assert";
import {
  buildSynologyWebdavAddress,
  isSynologyWebdavAddress,
  mergeSynologyConfig,
  resolveWebdavAddress,
} from "../src/webdavSynology";

describe("Synology WebDAV helpers", () => {
  it("builds https URL with default 5006 and encoded path", () => {
    const url = buildSynologyWebdavAddress({
      protocol: "https",
      host: "192.168.1.10",
      port: "",
      sharedFolder: "share2/库",
    });
    assert.equal(url, "https://192.168.1.10:5006/share2/%E5%BA%93");
  });

  it("builds http URL with default 5005", () => {
    const url = buildSynologyWebdavAddress({
      protocol: "http",
      host: "nas.local",
      port: "",
      sharedFolder: "share2/obsidian",
    });
    assert.equal(url, "http://nas.local:5005/share2/obsidian");
  });

  it("strips scheme from host and keeps custom port", () => {
    const url = buildSynologyWebdavAddress({
      protocol: "https",
      host: "https://nas.example.com/",
      port: "443",
      sharedFolder: "/backup/notes/",
    });
    assert.equal(url, "https://nas.example.com:443/backup/notes");
  });

  it("detects Synology WebDAV ports and hostnames", () => {
    assert.equal(
      isSynologyWebdavAddress("https://192.168.1.8:5006/share"),
      true
    );
    assert.equal(
      isSynologyWebdavAddress("http://192.168.1.8:5005/share"),
      true
    );
    assert.equal(
      isSynologyWebdavAddress("https://foo.quickconnect.to/share"),
      true
    );
    assert.equal(isSynologyWebdavAddress("https://example.com/webdav"), false);
  });

  it("resolveWebdavAddress prefers structured synology fields", () => {
    const url = resolveWebdavAddress({
      address: "https://old.example:5006/old",
      preset: "synology",
      synology: mergeSynologyConfig({
        protocol: "https",
        host: "10.0.0.2",
        port: "5006",
        sharedFolder: "vault",
      }),
    });
    assert.equal(url, "https://10.0.0.2:5006/vault");
  });

  it("returns empty string when synology host is missing", () => {
    assert.equal(buildSynologyWebdavAddress({ host: "" }), "");
  });
});
