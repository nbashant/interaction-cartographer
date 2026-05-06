import path from "node:path";

export function safeJoin(root: string, requestPath: string): string | null {
  try {
    const decoded = decodeURIComponent(requestPath.replace(/^\/+/, ""));
    if (decoded.includes("\0")) return null;
    const resolvedRoot = path.resolve(root);
    const resolvedPath = path.resolve(resolvedRoot, decoded);
    const relative = path.relative(resolvedRoot, resolvedPath);
    if (relative.startsWith("..") || path.isAbsolute(relative)) return null;
    return resolvedPath;
  } catch {
    return null;
  }
}

export function runAssetPath(runDir: string, requestPath: string): string | null {
  if (requestPath.startsWith("/screenshots/")) {
    return safeJoin(path.join(runDir, "screenshots"), requestPath.replace(/^\/screenshots\/?/, ""));
  }
  if (requestPath.startsWith("/replays/")) {
    return safeJoin(path.join(runDir, "replays"), requestPath.replace(/^\/replays\/?/, ""));
  }
  return null;
}
