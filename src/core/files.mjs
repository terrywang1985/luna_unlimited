import path from "node:path";
import { createReadStream } from "node:fs";
import { mkdir, readFile, readdir, stat, unlink, writeFile } from "node:fs/promises";
import { createInterface } from "node:readline";

import { CoreErrorCode, coreError, normalizeCoreError } from "./errors.mjs";
import { isSha256, sha256 } from "./hash.mjs";
import { isSensitiveRelativePath } from "./workspace.mjs";

async function statOrMissing(targetPath) {
  try {
    return await stat(targetPath);
  } catch (error) {
    if (error?.code === "ENOENT") return null;
    throw normalizeCoreError(error, CoreErrorCode.IO_ERROR);
  }
}

export class FileService {
  constructor({ workspace, mutations, maxFileBytes, maxCommandOutputBytes, maxBatchBytes }) {
    this.workspace = workspace;
    this.mutations = mutations;
    this.maxFileBytes = maxFileBytes;
    this.maxCommandOutputBytes = maxCommandOutputBytes;
    this.maxBatchBytes = maxBatchBytes;
  }

  async listDirectory({ path: relativePath }) {
    const directory = this.workspace.resolve(relativePath);
    await this.workspace.rejectSymlinks(directory);
    const info = await stat(directory).catch((error) => { throw normalizeCoreError(error, CoreErrorCode.IO_ERROR); });
    if (!info.isDirectory()) throw coreError(CoreErrorCode.PATH_NOT_DIRECTORY, "Requested path is not a directory");

    const entries = (await readdir(directory, { withFileTypes: true })).filter((entry) => {
      const entryRelativePath = path.relative(this.workspace.root, path.join(directory, entry.name));
      return !isSensitiveRelativePath(entryRelativePath);
    });
    const rows = entries
      .sort((a, b) => a.name.localeCompare(b.name))
      .map((entry) => `${entry.isDirectory() ? "[dir]" : "[file]"} ${entry.name}`);
    return { text: rows.length ? rows.join("\n") : "(empty directory)", details: { entries: entries.length } };
  }

  async statPath({ path: relativePath }) {
    const targetPath = this.workspace.resolve(relativePath);
    await this.workspace.rejectSymlinks(targetPath, true);
    const info = await statOrMissing(targetPath);
    if (!info) {
      const result = { path: relativePath, exists: false, type: "missing", readable: false, writable: true };
      return { text: JSON.stringify(result, null, 2), structured: result, details: result };
    }

    const type = info.isFile() ? "file" : info.isDirectory() ? "directory" : "other";
    let digest = null;
    if (info.isFile() && info.size <= this.maxFileBytes) digest = sha256(await readFile(targetPath));
    const result = {
      path: this.workspace.display(targetPath),
      exists: true,
      type,
      size: info.size,
      mtime: info.mtime.toISOString(),
      sha256: digest,
      readable: info.isDirectory() || (info.isFile() && info.size <= this.maxFileBytes),
      writable: info.isFile() || info.isDirectory()
    };
    return { text: JSON.stringify(result, null, 2), structured: result, details: result };
  }

  async readTextFile({ path: relativePath }) {
    const filePath = this.workspace.resolve(relativePath);
    await this.workspace.rejectSymlinks(filePath);
    const info = await stat(filePath).catch((error) => { throw normalizeCoreError(error, CoreErrorCode.IO_ERROR); });
    if (!info.isFile()) throw coreError(CoreErrorCode.PATH_NOT_FILE, "Requested path is not a file");
    if (info.size > this.maxFileBytes) {
      throw coreError(CoreErrorCode.FILE_TOO_LARGE, `File is too large (${info.size} bytes; limit is ${this.maxFileBytes})`);
    }
    const buffer = await readFile(filePath);
    const content = buffer.toString("utf8");
    if (content.includes("\0")) throw coreError(CoreErrorCode.BINARY_FILE, "Binary files are not supported");
    const digest = sha256(buffer);
    return {
      text: content,
      structured: {
        path: this.workspace.display(filePath),
        text: content,
        bytes: info.size,
        mtime: info.mtime.toISOString(),
        sha256: digest
      },
      details: { bytes: info.size, sha256: digest, mtime: info.mtime.toISOString() }
    };
  }

  async readTextFileRange({ path: relativePath, startLine, endLine }) {
    if (endLine < startLine) {
      throw coreError(CoreErrorCode.INVALID_ARGUMENT, "end_line must be greater than or equal to start_line");
    }
    if (endLine - startLine + 1 > 1000) {
      throw coreError(CoreErrorCode.INVALID_ARGUMENT, "A maximum of 1000 lines can be read at once");
    }

    const filePath = this.workspace.resolve(relativePath);
    await this.workspace.rejectSymlinks(filePath);
    const info = await stat(filePath).catch((error) => { throw normalizeCoreError(error, CoreErrorCode.IO_ERROR); });
    if (!info.isFile()) throw coreError(CoreErrorCode.PATH_NOT_FILE, "Requested path is not a file");

    const input = createReadStream(filePath, { encoding: "utf8" });
    const lines = createInterface({ input, crlfDelay: Infinity });
    const selected = [];
    let lineNumber = 0;
    let returnedBytes = 0;
    let truncated = false;

    try {
      for await (const line of lines) {
        lineNumber += 1;
        if (lineNumber < startLine) continue;
        if (lineNumber > endLine) break;
        if (line.includes("\0")) throw coreError(CoreErrorCode.BINARY_FILE, "Binary files are not supported");
        const lineWithBreak = `${line}\n`;
        const bytes = Buffer.byteLength(lineWithBreak, "utf8");
        if (returnedBytes + bytes > this.maxCommandOutputBytes) {
          truncated = true;
          break;
        }
        selected.push(line);
        returnedBytes += bytes;
      }
    } finally {
      lines.close();
      input.destroy();
    }

    const suffix = truncated ? "\n[output truncated by MCP limit]" : "";
    return {
      text: `${selected.join("\n")}${suffix}`,
      details: { startLine, endLine, returnedLines: selected.length, bytes: returnedBytes, truncated }
    };
  }

  async writeTextFile({ path: relativePath, content }) {
    const filePath = this.workspace.resolve(relativePath);
    const bytes = Buffer.byteLength(content, "utf8");
    if (bytes > this.maxFileBytes) {
      throw coreError(CoreErrorCode.FILE_TOO_LARGE, `Content is too large (${bytes} bytes; limit is ${this.maxFileBytes})`);
    }
    return this.mutations.run(filePath, async () => {
      await this.workspace.rejectSymlinks(filePath, true);
      await mkdir(path.dirname(filePath), { recursive: true });
      await this.workspace.rejectSymlinks(path.dirname(filePath));
      await writeFile(filePath, content, "utf8");
      return {
        text: `Wrote ${bytes} bytes to ${this.workspace.display(filePath)}`,
        structured: { path: this.workspace.display(filePath), bytes, sha256: sha256(content) },
        details: { bytes, sha256: sha256(content) }
      };
    });
  }

  async replaceText({ path: relativePath, oldText, newText, expectedReplacements }) {
    const filePath = this.workspace.resolve(relativePath);
    return this.mutations.run(filePath, async () => {
      await this.workspace.rejectSymlinks(filePath);
      const info = await stat(filePath).catch((error) => { throw normalizeCoreError(error, CoreErrorCode.IO_ERROR); });
      if (!info.isFile()) throw coreError(CoreErrorCode.PATH_NOT_FILE, "Requested path is not a file");
      if (info.size > this.maxFileBytes) {
        throw coreError(CoreErrorCode.FILE_TOO_LARGE, `File is too large (${info.size} bytes; limit is ${this.maxFileBytes})`);
      }
      const content = await readFile(filePath, "utf8");
      if (content.includes("\0")) throw coreError(CoreErrorCode.BINARY_FILE, "Binary files are not supported");
      const actualReplacements = content.split(oldText).length - 1;
      if (actualReplacements !== expectedReplacements) {
        throw coreError(
          CoreErrorCode.INVALID_ARGUMENT,
          `Expected ${expectedReplacements} replacement(s), found ${actualReplacements}`
        );
      }
      const updated = content.split(oldText).join(newText);
      const updatedBytes = Buffer.byteLength(updated, "utf8");
      if (updatedBytes > this.maxFileBytes) {
        throw coreError(CoreErrorCode.FILE_TOO_LARGE, `Updated file is too large (${updatedBytes} bytes; limit is ${this.maxFileBytes})`);
      }
      await writeFile(filePath, updated, "utf8");
      return {
        text: `Replaced ${actualReplacements} occurrence(s) in ${this.workspace.display(filePath)}`,
        structured: {
          path: this.workspace.display(filePath),
          replacements: actualReplacements,
          beforeBytes: info.size,
          afterBytes: updatedBytes,
          sha256: sha256(updated)
        },
        details: {
          replacements: actualReplacements,
          beforeBytes: info.size,
          afterBytes: updatedBytes,
          sha256: sha256(updated)
        }
      };
    });
  }

  async writeFiles({ files }) {
    if (!Array.isArray(files) || files.length === 0 || files.length > 50) {
      throw coreError(CoreErrorCode.INVALID_ARGUMENT, "files must contain between 1 and 50 items");
    }

    let totalBytes = 0;
    const prepared = files.map((file) => {
      const targetPath = this.workspace.resolve(file.path);
      const bytes = Buffer.byteLength(file.content, "utf8");
      totalBytes += bytes;
      if (bytes > this.maxFileBytes) {
        throw coreError(CoreErrorCode.FILE_TOO_LARGE, `Content is too large for ${file.path} (${bytes} bytes; limit is ${this.maxFileBytes})`);
      }
      if (file.expectedSha256 !== undefined && !isSha256(file.expectedSha256)) {
        throw coreError(CoreErrorCode.INVALID_ARGUMENT, `expected_sha256 must be a 64-character hex digest for ${file.path}`);
      }
      return { ...file, targetPath, bytes };
    });
    if (totalBytes > this.maxBatchBytes) {
      throw coreError(CoreErrorCode.FILE_TOO_LARGE, `Batch is too large (${totalBytes} bytes; limit is ${this.maxBatchBytes})`);
    }

    const uniquePaths = new Set(prepared.map((file) => file.targetPath.toLocaleLowerCase()));
    if (uniquePaths.size !== prepared.length) {
      throw coreError(CoreErrorCode.INVALID_ARGUMENT, "files contains duplicate target paths");
    }

    return this.mutations.runMany(prepared.map((file) => file.targetPath), async () => {
      const snapshots = [];
      for (const file of prepared) {
        await this.workspace.rejectSymlinks(file.targetPath, true);
        const info = await statOrMissing(file.targetPath);
        if (info && !info.isFile()) {
          throw coreError(CoreErrorCode.PATH_NOT_FILE, `Requested path is not a file: ${file.path}`);
        }
        if (info) {
          if (file.expectedSha256 === undefined) {
            throw coreError(
              CoreErrorCode.FILE_ALREADY_EXISTS,
              `File already exists; stat it and provide expected_sha256 before overwriting: ${file.path}`
            );
          }
          const original = await readFile(file.targetPath);
          const currentSha256 = sha256(original);
          if (currentSha256.toLocaleLowerCase() !== file.expectedSha256.toLocaleLowerCase()) {
            throw coreError(CoreErrorCode.FILE_CHANGED, `File changed since it was inspected: ${file.path}`, {
              expectedSha256: file.expectedSha256,
              actualSha256: currentSha256
            });
          }
          snapshots.push({ ...file, existed: true, original });
        } else {
          if (file.expectedSha256 !== undefined) {
            throw coreError(CoreErrorCode.FILE_CHANGED, `File no longer exists: ${file.path}`, {
              expectedSha256: file.expectedSha256,
              actualSha256: null
            });
          }
          snapshots.push({ ...file, existed: false, original: null });
        }
      }

      const committed = [];
      try {
        for (const file of snapshots) {
          await mkdir(path.dirname(file.targetPath), { recursive: true });
          await this.workspace.rejectSymlinks(path.dirname(file.targetPath));
          // Track the target before writing so even a partially-written file is restored.
          committed.push(file);
          if (file.existed) await writeFile(file.targetPath, file.content, "utf8");
          else await writeFile(file.targetPath, file.content, { encoding: "utf8", flag: "wx" });
        }
      } catch (rawError) {
        const rollbackErrors = [];
        for (const file of committed.reverse()) {
          try {
            if (file.existed) await writeFile(file.targetPath, file.original);
            else await unlink(file.targetPath);
          } catch (rollbackError) {
            if (!file.existed && rollbackError?.code === "ENOENT") continue;
            rollbackErrors.push({ path: file.path, error: rollbackError instanceof Error ? rollbackError.message : String(rollbackError) });
          }
        }
        if (rollbackErrors.length) {
          throw coreError(CoreErrorCode.ROLLBACK_FAILED, "Batch write failed and rollback was incomplete", { rollbackErrors });
        }
        const error = normalizeCoreError(rawError, CoreErrorCode.IO_ERROR);
        throw coreError(error.code, error.message, { ...error.details, rolledBack: true });
      }

      const changedFiles = snapshots.map((file) => ({
        path: this.workspace.display(file.targetPath),
        action: file.existed ? "updated" : "created",
        bytes: file.bytes,
        sha256: sha256(file.content)
      }));
      const result = { files: changedFiles, totalBytes };
      return {
        text: JSON.stringify(result, null, 2),
        structured: result,
        details: { files: changedFiles, totalBytes, committed: true }
      };
    });
  }
}
