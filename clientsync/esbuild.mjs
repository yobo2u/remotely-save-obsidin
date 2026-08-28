import esbuild from "esbuild";
import process from "node:process";
import { fileURLToPath } from "node:url";
import path from "node:path";

const dir = path.dirname(fileURLToPath(import.meta.url));
const prod = process.argv[2] === "production";

const ctx = await esbuild.context({
  banner: {
    js: "/* client-direct-sync — Apache 2.0. Source: clientsync/ */\n",
  },
  entryPoints: [path.join(dir, "src/main.ts")],
  bundle: true,
  external: ["obsidian", "electron", "fs", "tls", "net", "http", "https", "url", "os", "path"],
  format: "cjs",
  target: "es2020",
  logLevel: "info",
  sourcemap: prod ? false : "inline",
  treeShaking: true,
  minify: prod,
  outfile: path.join(dir, "main.js"),
  platform: "browser",
});

if (prod) {
  await ctx.rebuild();
  await ctx.dispose();
} else {
  await ctx.watch();
}
