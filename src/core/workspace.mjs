import path from "node:path";
import { lstat } from "node:fs/promises";

import { CoreErrorCode, coreError, normalizeCoreError } from "./errors.mjs";

export function isSensitiveRelativePath(relativePath) {
  const segments = relativePath.split(/[\\/]+/).filter(Boolean).map((segment) => segment.toLocaleLowerCase());
  if (segments.includes(".git")) return true;
  if (segments.some((segment) => segment.startsWith(".luna-move-backup-")
    || segment.startsWith(".luna-delete-")
    || segment.startsWith(".luna-clone-")
    || segment.startsWith(".luna-import-")
    || segment.startsWith(".luna-import-backup-"))) return true;
  const leaf = segments.at(-1) || "";
  if (leaf === ".env.example" || leaf === ".env.sample") return false;
  if (leaf === ".env" || leaf.startsWith(".env.")) return true;
  return [".npmrc", ".pypirc", "id_rsa", "id_ed25519", "credentials.json", "secrets.json"].includes(leaf);
}

export class WorkspaceService {
  constructor(workspaceRoot) {
    this.root = path.resolve(workspaceRoot);
  }

  resolve(relativePath = ".") {
    if (typeof relativePath !== "string" || relativePath.includes("\0")) {
      throw coreError(CoreErrorCode.INVALID_ARGUMENT, "path must be a valid string");
    }
    if (path.isAbsolute(relativePath)) {
      throw coreError(
        CoreErrorCode.PATH_OUTSIDE_WORKSPACE,
        "Absolute paths are not allowed; use a path relative to the MCP workspace"
      );
    }

    const resolved = path.resolve(this.root, relativePath);
    const rootKey = this.root.toLocaleLowerCase();
    const resolvedKey = resolved.toLocaleLowerCase();
    if (resolvedKey !== rootKey && !resolvedKey.startsWith(`${rootKey}${path.sep}`)) {
      throw coreError(CoreErrorCode.PATH_OUTSIDE_WORKSPACE, "Path escapes the MCP workspace");
    }

    const relative = path.relative(this.root, resolved);
    if (relative && isSensitiveRelativePath(relative)) {
      throw coreError(CoreErrorCode.SENSITIVE_PATH, "Access to credential and repository-internal paths is blocked");
    }
    return resolved;
  }

  async rejectSymlinks(targetPath, allowMissingLeaf = false) {
    const relative = path.relative(this.root, targetPath);
    if (!relative) return;

    const parts = relative.split(path.sep).filter(Boolean);
    let current = this.root;
    for (let index = 0; index < parts.length; index += 1) {
      current = path.join(current, parts[index]);
      try {
        const info = await lstat(current);
        if (info.isSymbolicLink()) {
          throw coreError(CoreErrorCode.SYMBOLIC_LINK, "Symbolic links are not allowed inside the MCP workspace");
        }
      } catch (error) {
        if (error?.code === "ENOENT" && allowMissingLeaf) return;
        throw normalizeCoreError(error, CoreErrorCode.IO_ERROR);
      }
    }
  }

  display(absolutePath) {
    const relative = path.relative(this.root, absolutePath) || ".";
    return relative.split(path.sep).join("/");
  }

  relative(absolutePath) {
    return path.relative(this.root, absolutePath) || ".";
  }
}
