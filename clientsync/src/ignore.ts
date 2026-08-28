export function normalize(rel: string): string {
  return rel.replace(/\\/g, "/").replace(/^\.\//, "").replace(/^\//, "");
}

export function shouldSkip(rel: string, ignoreDotObsidian: boolean): boolean {
  const n = normalize(rel);
  if (n === "") {
    return true;
  }
  const parts = n.split("/");
  const base = parts[parts.length - 1] ?? n;
  if (
    base === "clientsync-state.json" ||
    base.startsWith("clientsync-state-")
  ) {
    return true;
  }
  for (const p of parts) {
    if (p === ".git" || p === ".trash" || p === "node_modules") {
      return true;
    }
  }
  if (ignoreDotObsidian && (parts[0] === ".obsidian" || n.startsWith(".obsidian/"))) {
    return true;
  }
  return false;
}
