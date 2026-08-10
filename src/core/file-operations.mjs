import path from "node:path";
import { randomBytes } from "node:crypto";
import { lstat, mkdir, readFile, readdir, rename, rm } from "node:fs/promises";

import { CoreErrorCode, coreError, normalizeCoreError } from "./errors.mjs";
import { isSha256, sha256 } from "./hash.mjs";
import { isSensitiveRelativePath } from "./workspace.mjs";

async function lstatOrMissing(targetPath) {
  try {
    return await lstat(targetPath);
  } catch (error) {
    if (error?.code === "ENOENT") return null;
    throw normalizeCoreError(error, CoreErrorCode.IO_ERROR);
  }
}

function rejectWorkspaceRoot(workspace, targetPath) {
  if (targetPath === workspace.root) {
    throw coreError(CoreErrorCode.INVALID_ARGUMENT, "The workspace root cannot be moved or deleted");
  }
}

function canonical(targetPath) {
  return process.platform === "win32" ? targetPath.toLocaleLowerCase() : targetPath;
}

async function inspectTree(workspace, rootPath, maxEntries) {
  const stack = [rootPath];
  let entries = 0;
  let bytes = 0;
  while (stack.length) {
    const current = stack.pop();
    const info = await lstat(current).catch((error) => { throw normalizeCoreError(error, CoreErrorCode.IO_ERROR); });
    if (info.isSymbolicLink()) throw coreError(CoreErrorCode.SYMBOLIC_LINK, "Symbolic links cannot be moved or deleted");
    const relative = workspace.relative(current);
    if (relative !== "." && isSensitiveRelativePath(relative)) {
      throw coreError(CoreErrorCode.SENSITIVE_PATH, "A directory operation would affect a protected path", { path: relative });
    }
    entries += 1;
    if (entries > maxEntries) {
      throw coreError(CoreErrorCode.OPERATION_LIMIT_EXCEEDED, `Directory operation exceeds ${maxEntries} entries`);
    }
    if (info.isFile()) bytes += info.size;
    if (info.isDirectory()) {
      const children = await readdir(current);
      for (const child of children) stack.push(path.join(current, child));
    }
  }
  return { entries, bytes };
}

async function verifyFileRevision(targetPath, expectedSha256, label) {
  if (!isSha256(expectedSha256)) {
    throw coreError(CoreErrorCode.INVALID_ARGUMENT, `${label} must be a 64-character SHA-256 digest for a file`);
  }
  const content = await readFile(targetPath);
  const actualSha256 = sha256(content);
  if (actualSha256.toLocaleLowerCase() !== expectedSha256.toLocaleLowerCase()) {
    throw coreError(CoreErrorCode.FILE_CHANGED, "File changed since it was inspected", {
      expectedSha256,
      actualSha256
    });
  }
  return actualSha256;
}

export class FileOperationsService {
  constructor({ workspace, mutations, maxOperationEntries = 10000 }) {
    this.workspace = workspace;
    this.mutations = mutations;
    this.maxOperationEntries = maxOperationEntries;
    this.renamePath = rename;
    this.removePath = rm;
  }

  async createDirectory({ path: relativePath }) {
    const targetPath = this.workspace.resolve(relativePath);
    rejectWorkspaceRoot(this.workspace, targetPath);
    return this.mutations.run(targetPath, async () => {
      await this.workspace.rejectSymlinks(targetPath, true);
      const existing = await lstatOrMissing(targetPath);
      if (existing) {
        if (!existing.isDirectory()) throw coreError(CoreErrorCode.PATH_NOT_DIRECTORY, "A non-directory already exists at the requested path");
        const result = { path: this.workspace.display(targetPath), created: false };
        return { text: JSON.stringify(result, null, 2), structured: result, details: result };
      }
      await mkdir(targetPath, { recursive: true });
      await this.workspace.rejectSymlinks(targetPath);
      const result = { path: this.workspace.display(targetPath), created: true };
      return { text: JSON.stringify(result, null, 2), structured: result, details: result };
    });
  }

  async movePath({ source, destination, overwrite = false, expectedSha256, expectedDestinationSha256 }) {
    const sourcePath = this.workspace.resolve(source);
    const destinationPath = this.workspace.resolve(destination);
    rejectWorkspaceRoot(this.workspace, sourcePath);
    rejectWorkspaceRoot(this.workspace, destinationPath);
    if (canonical(sourcePath) === canonical(destinationPath)) {
      throw coreError(CoreErrorCode.INVALID_ARGUMENT, "source and destination must be different paths");
    }
    const sourceKey = `${canonical(sourcePath)}${path.sep}`;
    if (canonical(destinationPath).startsWith(sourceKey)) {
      throw coreError(CoreErrorCode.INVALID_ARGUMENT, "A directory cannot be moved inside itself");
    }

    // Directory moves affect an entire path hierarchy. The mutation queue uses
    // exact path keys, so a workspace-exclusive gate is the only safe way to
    // prevent another Luna operation from changing a descendant mid-move.
    return this.mutations.runExclusive(async () => {
      await this.workspace.rejectSymlinks(sourcePath);
      await this.workspace.rejectSymlinks(destinationPath, true);
      const sourceInfo = await lstatOrMissing(sourcePath);
      if (!sourceInfo) throw coreError(CoreErrorCode.PATH_NOT_FOUND, `Source path does not exist: ${source}`);
      if (sourceInfo.isSymbolicLink()) throw coreError(CoreErrorCode.SYMBOLIC_LINK, "Symbolic links cannot be moved");
      const sourceSummary = sourceInfo.isDirectory()
        ? await inspectTree(this.workspace, sourcePath, this.maxOperationEntries)
        : { entries: 1, bytes: sourceInfo.size };
      const sourceSha256 = sourceInfo.isFile()
        ? await verifyFileRevision(sourcePath, expectedSha256, "expected_sha256")
        : null;

      const destinationInfo = await lstatOrMissing(destinationPath);
      if (destinationInfo && !overwrite) {
        throw coreError(CoreErrorCode.FILE_ALREADY_EXISTS, `Destination already exists: ${destination}`);
      }
      if (destinationInfo) {
        if (destinationInfo.isSymbolicLink()) throw coreError(CoreErrorCode.SYMBOLIC_LINK, "Symbolic links cannot be overwritten");
        if (sourceInfo.isDirectory() !== destinationInfo.isDirectory()) {
          throw coreError(CoreErrorCode.INVALID_ARGUMENT, "Source and destination types differ");
        }
        if (destinationInfo.isDirectory()) {
          await inspectTree(this.workspace, destinationPath, this.maxOperationEntries);
        } else {
          await verifyFileRevision(destinationPath, expectedDestinationSha256, "expected_destination_sha256");
        }
      }

      await mkdir(path.dirname(destinationPath), { recursive: true });
      await this.workspace.rejectSymlinks(path.dirname(destinationPath));
      let backupPath = null;
      try {
        if (destinationInfo) {
          backupPath = path.join(path.dirname(destinationPath), `.luna-move-backup-${randomBytes(12).toString("hex")}`);
          await this.renamePath(destinationPath, backupPath);
        }
        await this.renamePath(sourcePath, destinationPath);
      } catch (rawError) {
        const rollbackErrors = [];
        try {
          if (await lstatOrMissing(destinationPath)) await this.renamePath(destinationPath, sourcePath);
        } catch (error) {
          rollbackErrors.push(error instanceof Error ? error.message : String(error));
        }
        try {
          if (backupPath && await lstatOrMissing(backupPath)) await this.renamePath(backupPath, destinationPath);
        } catch (error) {
          rollbackErrors.push(error instanceof Error ? error.message : String(error));
        }
        if (rollbackErrors.length) {
          throw coreError(CoreErrorCode.ROLLBACK_FAILED, "Move failed and rollback was incomplete", { rollbackErrors });
        }
        const error = normalizeCoreError(rawError, CoreErrorCode.IO_ERROR);
        throw coreError(error.code, error.message, { ...error.details, rolledBack: true });
      }
      let cleanupPending = false;
      if (backupPath) {
        try {
          await this.removePath(backupPath, { recursive: true, force: false });
        } catch {
          cleanupPending = true;
        }
      }

      const result = {
        source: this.workspace.display(sourcePath),
        destination: this.workspace.display(destinationPath),
        type: sourceInfo.isDirectory() ? "directory" : "file",
        overwritten: Boolean(destinationInfo),
        entries: sourceSummary.entries,
        bytes: sourceSummary.bytes,
        sha256: sourceSha256,
        cleanupPending
      };
      return { text: JSON.stringify(result, null, 2), structured: result, details: { ...result, committed: true } };
    });
  }

  async deletePath({ path: relativePath, recursive = false, expectedSha256 }) {
    const targetPath = this.workspace.resolve(relativePath);
    rejectWorkspaceRoot(this.workspace, targetPath);
    // Deletion can recursively consume descendants, so serialize it against
    // every other workspace mutation rather than locking only the root path.
    return this.mutations.runExclusive(async () => {
      await this.workspace.rejectSymlinks(targetPath);
      const info = await lstatOrMissing(targetPath);
      if (!info) throw coreError(CoreErrorCode.PATH_NOT_FOUND, `Path does not exist: ${relativePath}`);
      if (info.isSymbolicLink()) throw coreError(CoreErrorCode.SYMBOLIC_LINK, "Symbolic links cannot be deleted");

      let summary;
      let digest = null;
      if (info.isDirectory()) {
        const children = await readdir(targetPath);
        if (!recursive && children.length) {
          throw coreError(CoreErrorCode.DIRECTORY_NOT_EMPTY, "Directory is not empty; recursive=true is required");
        }
        summary = await inspectTree(this.workspace, targetPath, this.maxOperationEntries);
      } else if (info.isFile()) {
        digest = await verifyFileRevision(targetPath, expectedSha256, "expected_sha256");
        summary = { entries: 1, bytes: info.size };
      } else {
        throw coreError(CoreErrorCode.INVALID_ARGUMENT, "Only regular files and directories can be deleted");
      }

      const trashPath = path.join(path.dirname(targetPath), `.luna-delete-${randomBytes(12).toString("hex")}`);
      try {
        await this.renamePath(targetPath, trashPath);
      } catch (rawError) {
        const error = normalizeCoreError(rawError, CoreErrorCode.IO_ERROR);
        throw coreError(error.code, error.message, { ...error.details, committed: false });
      }
      let cleanupPending = false;
      try {
        await this.removePath(trashPath, { recursive: info.isDirectory(), force: false });
      } catch {
        cleanupPending = true;
      }

      const result = {
        path: this.workspace.display(targetPath),
        type: info.isDirectory() ? "directory" : "file",
        recursive: info.isDirectory() && recursive,
        entries: summary.entries,
        bytes: summary.bytes,
        sha256: digest,
        deleted: true,
        cleanupPending
      };
      return { text: JSON.stringify(result, null, 2), structured: result, details: { ...result, committed: true } };
    });
  }
}
