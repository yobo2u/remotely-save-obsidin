import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { shouldSkip } from "../src/ignore";
import { MemoryBackend, fromUtf8, utf8 } from "../src/memory";
import { Engine, conflictName, emptySnapshot } from "../src/sync";
import { extractOAuthCode } from "../src/google";
import { pickShare } from "../src/discover";
import { qnapEncodePassword } from "../src/qnap";

describe("ignore", () => {
  it("skips .obsidian when asked", () => {
    assert.equal(shouldSkip(".obsidian/app.json", true), true);
    assert.equal(shouldSkip("note.md", true), false);
    assert.equal(shouldSkip(".git/HEAD", false), true);
  });
});

describe("oauth code", () => {
  it("extracts from URL", () => {
    assert.equal(extractOAuthCode("http://127.0.0.1/?code=abc&scope=x"), "abc");
    assert.equal(extractOAuthCode("abc"), "abc");
  });
});

describe("qnap password", () => {
  it("encodes admin as YWRtaW4=", () => {
    assert.equal(qnapEncodePassword("admin"), "YWRtaW4=");
  });
});

describe("share pick", () => {
  it("prefers /home then vault name", () => {
    assert.equal(pickShare(["/photo", "/home"], "Vault"), "/home/Vault");
    assert.equal(pickShare(["/Public"], "Vault"), "/Public/Vault");
  });
});

describe("sync", () => {
  it("first bidirectional pass", async () => {
    const local = new MemoryBackend();
    const remote = new MemoryBackend();
    local.kind = "local";
    await local.write("hello.md", utf8("local"), Date.now());
    await remote.write("from-remote.md", utf8("remote"), Date.now());
    const eng = new Engine(local, remote, "keep_newer", 0);
    const { result } = await eng.run(emptySnapshot());
    assert.equal(result.pushed, 1);
    assert.equal(result.pulled, 1);
    assert.equal(fromUtf8(await local.read("from-remote.md")), "remote");
    assert.equal(fromUtf8(await remote.read("hello.md")), "local");
  });

  it("propagates delete after snapshot", async () => {
    const local = new MemoryBackend();
    const remote = new MemoryBackend();
    await local.write("gone.md", utf8("x"), Date.now());
    const eng = new Engine(local, remote, "keep_newer", 0);
    const first = await eng.run(emptySnapshot());
    await local.remove("gone.md");
    const second = await eng.run(first.next);
    assert.equal(second.result.deletedRemote, 1);
  });

  it("keeps newer and writes conflict copy", async () => {
    const local = new MemoryBackend();
    const remote = new MemoryBackend();
    const newer = Date.now();
    const older = newer - 3600_000;
    await local.write("note.md", utf8("local-new"), newer);
    await remote.write("note.md", utf8("remote-old"), older);
    const eng = new Engine(local, remote, "keep_newer", 0);
    const { result } = await eng.run(emptySnapshot());
    assert.equal(result.conflicts, 1);
    assert.equal(fromUtf8(await remote.read("note.md")), "local-new");
    const listed = await local.list();
    assert.ok(listed.some((f) => f.relPath.includes(".conflict-")));
  });
});

describe("conflictName", () => {
  it("keeps extension", () => {
    assert.match(conflictName("a/b.md", new Date("2026-08-28T05:41:00Z")), /b\.conflict-.*\.md$/);
  });
});
