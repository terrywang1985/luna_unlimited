import path from "node:path";
import { chmod, mkdir, readFile, stat, unlink, writeFile } from "node:fs/promises";

import { CoreErrorCode, coreError, normalizeCoreError } from "./errors.mjs";
import { isSha256, sha256 } from "./hash.mjs";

const MAX_PATCH_FILES = 50;

async function statOrMissing(targetPath) {
  try {
    return await stat(targetPath);
  } catch (error) {
    if (error?.code === "ENOENT") return null;
    throw normalizeCoreError(error, CoreErrorCode.IO_ERROR);
  }
}

function validationError(code, message, details = {}) {
  return coreError(code, message, { phase: "validation", ...details });
}

function withValidationPhase(error) {
  const normalized = normalizeCoreError(error);
  if (normalized.details?.phase) return normalized;
  return coreError(normalized.code, normalized.message, { ...normalized.details, phase: "validation" });
}

function parseHeaderPath(value, prefix) {
  const withoutTimestamp = value.split("\t", 1)[0].trim();
  if (withoutTimestamp === "/dev/null") return null;
  if (!withoutTimestamp || withoutTimestamp.startsWith('"')) {
    throw validationError(CoreErrorCode.PATCH_UNSUPPORTED, "Quoted or empty unified diff paths are not supported");
  }
  return withoutTimestamp.startsWith(prefix) ? withoutTimestamp.slice(prefix.length) : withoutTimestamp;
}

function parseHunkHeader(line) {
  const match = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@(?:.*)$/.exec(line);
  if (!match) throw validationError(CoreErrorCode.PATCH_INVALID, `Invalid unified diff hunk header: ${line}`);
  return {
    oldStart: Number.parseInt(match[1], 10),
    oldCount: match[2] === undefined ? 1 : Number.parseInt(match[2], 10),
    newStart: Number.parseInt(match[3], 10),
    newCount: match[4] === undefined ? 1 : Number.parseInt(match[4], 10),
    lines: []
  };
}

export function parseUnifiedDiff(rawPatch) {
  if (typeof rawPatch !== "string" || rawPatch.trim().length === 0) {
    throw validationError(CoreErrorCode.PATCH_INVALID, "patch must be a non-empty unified diff string");
  }
  if (rawPatch.includes("\0")) throw validationError(CoreErrorCode.PATCH_INVALID, "patch contains a NUL byte");

  const lines = rawPatch.replace(/\r\n/g, "\n").split("\n");
  const files = [];
  let index = 0;

  while (index < lines.length) {
    const line = lines[index];
    if (!line || line.startsWith("diff --git ") || line.startsWith("index ")
      || line.startsWith("new file mode ") || line.startsWith("deleted file mode ")) {
      index += 1;
      continue;
    }
    if (line.startsWith("rename ") || line.startsWith("copy ") || line.startsWith("GIT binary patch")) {
      throw validationError(CoreErrorCode.PATCH_UNSUPPORTED, "Rename, copy, and binary patches are not supported");
    }
    if (!line.startsWith("--- ")) {
      throw validationError(CoreErrorCode.PATCH_INVALID, `Expected unified diff file header, found: ${line}`);
    }

    const oldPath = parseHeaderPath(line.slice(4), "a/");
    index += 1;
    if (index >= lines.length || !lines[index].startsWith("+++ ")) {
      throw validationError(CoreErrorCode.PATCH_INVALID, "Unified diff is missing a +++ file header");
    }
    const newPath = parseHeaderPath(lines[index].slice(4), "b/");
    index += 1;

    if (oldPath === null && newPath === null) {
      throw validationError(CoreErrorCode.PATCH_INVALID, "A patch cannot use /dev/null for both file paths");
    }
    if (oldPath !== null && newPath !== null && oldPath !== newPath) {
      throw validationError(CoreErrorCode.PATCH_UNSUPPORTED, "Rename patches are not supported; patch one stable path");
    }

    const entry = {
      path: newPath ?? oldPath,
      action: oldPath === null ? "created" : newPath === null ? "deleted" : "updated",
      hunks: []
    };

    while (index < lines.length) {
      const current = lines[index];
      if (current.startsWith("diff --git ") || current.startsWith("--- ")) break;
      if (!current) {
        if (index === lines.length - 1) {
          index += 1;
          break;
        }
        throw validationError(CoreErrorCode.PATCH_INVALID, "Hunk lines must start with a space, +, or -");
      }
      if (!current.startsWith("@@ ")) {
        throw validationError(CoreErrorCode.PATCH_INVALID, `Expected hunk header, found: ${current}`);
      }

      const hunk = parseHunkHeader(current);
      index += 1;
      while (index < lines.length) {
        const hunkLine = lines[index];
        if (hunkLine.startsWith("@@ ") || hunkLine.startsWith("diff --git ") || hunkLine.startsWith("--- ")) break;
        if (hunkLine === "\\ No newline at end of file") {
          throw validationError(
            CoreErrorCode.PATCH_UNSUPPORTED,
            "Files without a final newline are not supported by apply_patch"
          );
        }
        const kind = hunkLine[0];
        if (![" ", "+", "-"].includes(kind)) {
          if (hunkLine === "" && index === lines.length - 1) break;
          throw validationError(CoreErrorCode.PATCH_INVALID, "Hunk lines must start with a space, +, or -");
        }
        hunk.lines.push({ kind, text: hunkLine.slice(1) });
        index += 1;
      }

      const consumedOld = hunk.lines.filter((item) => item.kind !== "+").length;
      const producedNew = hunk.lines.filter((item) => item.kind !== "-").length;
      if (consumedOld !== hunk.oldCount || producedNew !== hunk.newCount) {
        throw validationError(CoreErrorCode.PATCH_INVALID, "Hunk line counts do not match its header", {
          path: entry.path,
          expectedOldLines: hunk.oldCount,
          actualOldLines: consumedOld,
          expectedNewLines: hunk.newCount,
          actualNewLines: producedNew
        });
      }
      entry.hunks.push(hunk);
    }

    if (entry.hunks.length === 0) {
      throw validationError(CoreErrorCode.PATCH_INVALID, `Patch has no hunks for ${entry.path}`);
    }
    files.push(entry);
  }

  if (files.length === 0 || files.length > MAX_PATCH_FILES) {
    throw validationError(CoreErrorCode.PATCH_INVALID, `patch must touch between 1 and ${MAX_PATCH_FILES} files`);
  }
  return files;
}

function applyPatchPath(line, prefix) {
  const value = line.slice(prefix.length).trim();
  if (!value || value.startsWith('"') || value.includes("\0")) {
    throw validationError(CoreErrorCode.PATCH_UNSUPPORTED, "Quoted, empty, or NUL apply_patch paths are not supported");
  }
  return value;
}

function readApplyPatchHunk(lines, startIndex) {
  const hunk = { lines: [] };
  let index = startIndex;
  while (index < lines.length) {
    const line = lines[index];
    if (line.startsWith("@@") || line.startsWith("*** Update File:") || line.startsWith("*** Add File:")
      || line.startsWith("*** Delete File:") || line === "*** End Patch") break;
    if (line === "" && index === lines.length - 1) break;
    const kind = line[0];
    if (![" ", "+", "-"].includes(kind)) {
      throw validationError(CoreErrorCode.PATCH_INVALID, `apply_patch hunk lines must start with a space, +, or -: ${line}`);
    }
    hunk.lines.push({ kind, text: line.slice(1) });
    index += 1;
  }
  if (!hunk.lines.length) throw validationError(CoreErrorCode.PATCH_INVALID, "apply_patch hunk is empty");
  return { hunk, index };
}

export function parseApplyPatch(rawPatch) {
  if (typeof rawPatch !== "string" || rawPatch.trim().length === 0) {
    throw validationError(CoreErrorCode.PATCH_INVALID, "patch must be a non-empty string");
  }
  if (rawPatch.includes("\0")) throw validationError(CoreErrorCode.PATCH_INVALID, "patch contains a NUL byte");

  const lines = rawPatch.replace(/\r\n/g, "\n").split("\n");
  let index = 0;
  while (index < lines.length && !lines[index]) index += 1;
  if (lines[index] !== "*** Begin Patch") {
    throw validationError(CoreErrorCode.PATCH_INVALID, "apply_patch input must begin with *** Begin Patch");
  }
  index += 1;
  const files = [];
  let ended = false;

  while (index < lines.length) {
    const line = lines[index];
    if (!line) {
      index += 1;
      continue;
    }
    if (line === "*** End Patch") {
      ended = true;
      index += 1;
      break;
    }
    if (line.startsWith("*** Move to:")) {
      throw validationError(CoreErrorCode.PATCH_UNSUPPORTED, "Move/rename apply_patch operations are not supported");
    }

    let action;
    let filePath;
    if (line.startsWith("*** Update File:")) {
      action = "updated";
      filePath = applyPatchPath(line, "*** Update File:");
    } else if (line.startsWith("*** Add File:")) {
      action = "created";
      filePath = applyPatchPath(line, "*** Add File:");
    } else if (line.startsWith("*** Delete File:")) {
      action = "deleted";
      filePath = applyPatchPath(line, "*** Delete File:");
    } else {
      throw validationError(CoreErrorCode.PATCH_INVALID, `Expected apply_patch file header, found: ${line}`);
    }
    index += 1;

    const entry = { path: filePath, action, hunks: [], dialect: "apply_patch" };
    if (action === "deleted") {
      while (index < lines.length && !lines[index].startsWith("*** ")) {
        const current = lines[index];
        if (current && current[0] !== "-") {
          throw validationError(CoreErrorCode.PATCH_INVALID, "Delete File content must contain only - lines when present");
        }
        if (current) entry.hunks.push({ lines: [{ kind: "-", text: current.slice(1) }] });
        index += 1;
      }
      files.push(entry);
      continue;
    }

    if (action === "created") {
      const hunk = { lines: [] };
      while (index < lines.length && !lines[index].startsWith("*** ")) {
        const current = lines[index];
        if (current === "" && index === lines.length - 1) break;
        if (!current.startsWith("+")) {
          throw validationError(CoreErrorCode.PATCH_INVALID, "Add File content must use + lines");
        }
        hunk.lines.push({ kind: "+", text: current.slice(1) });
        index += 1;
      }
      if (!hunk.lines.length) throw validationError(CoreErrorCode.PATCH_INVALID, `Add File has no content for ${filePath}`);
      entry.hunks.push(hunk);
      files.push(entry);
      continue;
    }

    while (index < lines.length && !lines[index].startsWith("*** ")) {
      if (lines[index].startsWith("@@")) index += 1;
      const parsed = readApplyPatchHunk(lines, index);
      entry.hunks.push(parsed.hunk);
      index = parsed.index;
    }
    if (!entry.hunks.length) throw validationError(CoreErrorCode.PATCH_INVALID, `Update File has no hunks for ${filePath}`);
    files.push(entry);
  }

  while (index < lines.length && !lines[index]) index += 1;
  if (!ended || index !== lines.length) {
    throw validationError(CoreErrorCode.PATCH_INVALID, "apply_patch input must end with *** End Patch");
  }
  if (files.length === 0 || files.length > MAX_PATCH_FILES) {
    throw validationError(CoreErrorCode.PATCH_INVALID, `patch must touch between 1 and ${MAX_PATCH_FILES} files`);
  }
  return files;
}

function parsePatch(rawPatch) {
  return rawPatch.trimStart().startsWith("*** Begin Patch") ? parseApplyPatch(rawPatch) : parseUnifiedDiff(rawPatch);
}

function splitText(content, relativePath) {
  if (content.includes("\0")) throw validationError(CoreErrorCode.BINARY_FILE, `Binary file is not supported: ${relativePath}`);
  if (content.length > 0 && !content.endsWith("\n")) {
    throw validationError(
      CoreErrorCode.PATCH_UNSUPPORTED,
      `File must end with a newline before it can be patched: ${relativePath}`
    );
  }
  const eol = content.includes("\r\n") ? "\r\n" : "\n";
  const normalized = content.replace(/\r\n/g, "\n");
  return { lines: normalized ? normalized.slice(0, -1).split("\n") : [], eol };
}

function applyContextHunks(file, originalContent) {
  const { lines: originalLines, eol } = splitText(originalContent, file.path);
  if (file.action === "created") {
    const lines = file.hunks.flatMap((hunk) => hunk.lines.map((line) => line.text));
    const content = lines.length ? `${lines.join(eol)}${eol}` : "";
    return { content, addedLines: lines.length, removedLines: 0 };
  }
  if (file.action === "deleted") {
    return { content: "", addedLines: 0, removedLines: originalLines.length };
  }

  const output = [];
  let cursor = 0;
  let addedLines = 0;
  let removedLines = 0;

  for (const hunk of file.hunks) {
    const oldLines = hunk.lines.filter((line) => line.kind !== "+").map((line) => line.text);
    if (!oldLines.length) {
      throw validationError(
        CoreErrorCode.PATCH_UNSUPPORTED,
        `apply_patch update hunk needs at least one context or removed line: ${file.path}`
      );
    }

    const matches = [];
    for (let start = cursor; start + oldLines.length <= originalLines.length; start += 1) {
      let matchesHere = true;
      for (let offset = 0; offset < oldLines.length; offset += 1) {
        if (originalLines[start + offset] !== oldLines[offset]) {
          matchesHere = false;
          break;
        }
      }
      if (matchesHere) matches.push(start);
    }
    if (matches.length === 0) {
      throw validationError(CoreErrorCode.PATCH_CONTEXT_MISMATCH, `apply_patch context does not match ${file.path}`, {
        path: file.path
      });
    }
    if (matches.length > 1) {
      throw validationError(CoreErrorCode.PATCH_CONTEXT_MISMATCH, `apply_patch context is ambiguous in ${file.path}; include more context`, {
        path: file.path,
        matches: matches.length
      });
    }

    const startIndex = matches[0];
    output.push(...originalLines.slice(cursor, startIndex));
    let sourceIndex = startIndex;
    for (const line of hunk.lines) {
      if (line.kind === "+") {
        output.push(line.text);
        addedLines += 1;
        continue;
      }
      if (line.kind === " ") output.push(line.text);
      else removedLines += 1;
      sourceIndex += 1;
    }
    cursor = sourceIndex;
  }

  output.push(...originalLines.slice(cursor));
  const content = output.length ? `${output.join(eol)}${eol}` : "";
  return { content, addedLines, removedLines };
}

function applyHunks(file, originalContent) {
  if (file.dialect === "apply_patch") return applyContextHunks(file, originalContent);
  const { lines: originalLines, eol } = splitText(originalContent, file.path);
  const output = [];
  let cursor = 0;
  let addedLines = 0;
  let removedLines = 0;

  for (const hunk of file.hunks) {
    const startIndex = hunk.oldStart === 0 ? 0 : hunk.oldStart - 1;
    if (startIndex < cursor || startIndex > originalLines.length) {
      throw validationError(CoreErrorCode.PATCH_CONTEXT_MISMATCH, `Hunk position does not match ${file.path}`, {
        path: file.path,
        oldStart: hunk.oldStart
      });
    }
    output.push(...originalLines.slice(cursor, startIndex));
    let sourceIndex = startIndex;

    for (const line of hunk.lines) {
      if (line.kind === "+") {
        output.push(line.text);
        addedLines += 1;
        continue;
      }
      if (sourceIndex >= originalLines.length || originalLines[sourceIndex] !== line.text) {
        throw validationError(CoreErrorCode.PATCH_CONTEXT_MISMATCH, `Patch context does not match ${file.path}`, {
          path: file.path,
          line: sourceIndex + 1
        });
      }
      if (line.kind === " ") output.push(line.text);
      else removedLines += 1;
      sourceIndex += 1;
    }
    cursor = sourceIndex;
  }

  output.push(...originalLines.slice(cursor));
  const content = output.length ? `${output.join(eol)}${eol}` : "";
  return { content, addedLines, removedLines };
}

export class PatchService {
  constructor({ workspace, mutations, maxFileBytes, maxBatchBytes }) {
    this.workspace = workspace;
    this.mutations = mutations;
    this.maxFileBytes = maxFileBytes;
    this.maxBatchBytes = maxBatchBytes;
  }

  prepareRequest({ patch, expectedFiles, dryRun = false }) {
    if (Buffer.byteLength(patch || "", "utf8") > this.maxBatchBytes) {
      throw validationError(CoreErrorCode.FILE_TOO_LARGE, "patch exceeds the configured batch byte limit");
    }
    const parsed = parsePatch(patch);
    if (!Array.isArray(expectedFiles) || expectedFiles.length < 1 || expectedFiles.length > MAX_PATCH_FILES) {
      throw validationError(
        CoreErrorCode.INVALID_ARGUMENT,
        `expected_files must explicitly describe every touched path (1-${MAX_PATCH_FILES} items)`
      );
    }

    const expectations = new Map();
    for (const expected of expectedFiles) {
      if (!expected || typeof expected.path !== "string" || expected.path.length === 0) {
        throw validationError(CoreErrorCode.INVALID_ARGUMENT, "Every expected_files item must contain a path");
      }
      if (expected.sha256 !== null && !isSha256(expected.sha256)) {
        throw validationError(
          CoreErrorCode.INVALID_ARGUMENT,
          `expected_files.sha256 must be a SHA-256 digest or null for a new file: ${expected.path}`
        );
      }
      const targetPath = this.workspace.resolve(expected.path);
      const key = process.platform === "win32" ? targetPath.toLocaleLowerCase() : targetPath;
      if (expectations.has(key)) throw validationError(CoreErrorCode.INVALID_ARGUMENT, "expected_files contains duplicate paths");
      expectations.set(key, { path: expected.path, sha256: expected.sha256, targetPath });
    }

    const prepared = parsed.map((file) => {
      const targetPath = this.workspace.resolve(file.path);
      const key = process.platform === "win32" ? targetPath.toLocaleLowerCase() : targetPath;
      const expected = expectations.get(key);
      if (!expected) {
        throw validationError(CoreErrorCode.INVALID_ARGUMENT, `Missing expected_files entry for ${file.path}`);
      }
      return { ...file, targetPath, expectedSha256: expected.sha256 };
    });
    const unique = new Set(prepared.map((file) => process.platform === "win32"
      ? file.targetPath.toLocaleLowerCase()
      : file.targetPath));
    if (unique.size !== prepared.length) throw validationError(CoreErrorCode.PATCH_INVALID, "patch touches a path more than once");
    if (expectations.size !== prepared.length) {
      throw validationError(CoreErrorCode.INVALID_ARGUMENT, "expected_files contains paths not touched by the patch");
    }
    return { prepared, dryRun: dryRun === true };
  }

  async writePreparedFile(file) {
    if (file.action === "deleted") {
      await unlink(file.targetPath);
      return;
    }
    await mkdir(path.dirname(file.targetPath), { recursive: true });
    await this.workspace.rejectSymlinks(path.dirname(file.targetPath));
    if (file.existed) await writeFile(file.targetPath, file.updatedContent, "utf8");
    else await writeFile(file.targetPath, file.updatedContent, { encoding: "utf8", flag: "wx" });
  }

  async apply(request) {
    let requestState;
    try {
      requestState = this.prepareRequest(request);
    } catch (error) {
      throw withValidationPhase(error);
    }

    return this.mutations.runMany(requestState.prepared.map((file) => file.targetPath), async () => {
      const snapshots = [];
      let totalOutputBytes = 0;
      try {
        for (const file of requestState.prepared) {
          await this.workspace.rejectSymlinks(file.targetPath, true);
          const info = await statOrMissing(file.targetPath);
          if (info && !info.isFile()) {
            throw validationError(CoreErrorCode.PATH_NOT_FILE, `Patch target is not a file: ${file.path}`);
          }
          if (info && file.action === "created") {
            throw validationError(CoreErrorCode.FILE_CHANGED, `New patch target already exists: ${file.path}`, {
              path: file.path,
              actualSha256: sha256(await readFile(file.targetPath))
            });
          }
          if (!info && file.action !== "created") {
            throw validationError(CoreErrorCode.FILE_CHANGED, `Patch target no longer exists: ${file.path}`, {
              path: file.path,
              actualSha256: null
            });
          }
          if (info && file.expectedSha256 === null) {
            throw validationError(CoreErrorCode.FILE_CHANGED, `Expected a new file but the path exists: ${file.path}`);
          }
          if (!info && file.expectedSha256 !== null) {
            throw validationError(CoreErrorCode.FILE_CHANGED, `Expected file no longer exists: ${file.path}`, {
              path: file.path,
              expectedSha256: file.expectedSha256,
              actualSha256: null
            });
          }

          const original = info ? await readFile(file.targetPath) : Buffer.alloc(0);
          if (original.length > this.maxFileBytes) {
            throw validationError(
              CoreErrorCode.FILE_TOO_LARGE,
              `Patch target is too large: ${file.path} (${original.length} bytes; limit is ${this.maxFileBytes})`
            );
          }
          const beforeSha256 = info ? sha256(original) : null;
          if (info && beforeSha256.toLocaleLowerCase() !== file.expectedSha256.toLocaleLowerCase()) {
            throw validationError(CoreErrorCode.FILE_CHANGED, `File changed since it was inspected: ${file.path}`, {
              path: file.path,
              expectedSha256: file.expectedSha256,
              actualSha256: beforeSha256
            });
          }

          const applied = applyHunks(file, original.toString("utf8"));
          if (file.action === "deleted" && applied.content !== "") {
            throw validationError(CoreErrorCode.PATCH_INVALID, `Delete patch did not remove all content from ${file.path}`);
          }
          const updatedBytes = Buffer.byteLength(applied.content, "utf8");
          if (updatedBytes > this.maxFileBytes) {
            throw validationError(
              CoreErrorCode.FILE_TOO_LARGE,
              `Patched file is too large: ${file.path} (${updatedBytes} bytes; limit is ${this.maxFileBytes})`
            );
          }
          totalOutputBytes += updatedBytes;
          snapshots.push({
            ...file,
            existed: Boolean(info),
            original,
            mode: info?.mode,
            beforeSha256,
            afterSha256: file.action === "deleted" ? null : sha256(applied.content),
            updatedContent: applied.content,
            updatedBytes,
            addedLines: applied.addedLines,
            removedLines: applied.removedLines
          });
        }
        if (totalOutputBytes > this.maxBatchBytes) {
          throw validationError(
            CoreErrorCode.FILE_TOO_LARGE,
            `Patched output is too large (${totalOutputBytes} bytes; limit is ${this.maxBatchBytes})`
          );
        }
      } catch (error) {
        throw withValidationPhase(error);
      }

      const files = snapshots.map((file) => ({
        path: this.workspace.display(file.targetPath),
        action: file.action,
        beforeSha256: file.beforeSha256,
        afterSha256: file.afterSha256,
        bytes: file.action === "deleted" ? 0 : file.updatedBytes,
        addedLines: file.addedLines,
        removedLines: file.removedLines
      }));
      const totals = files.reduce((result, file) => ({
        files: result.files + 1,
        bytes: result.bytes + file.bytes,
        addedLines: result.addedLines + file.addedLines,
        removedLines: result.removedLines + file.removedLines
      }), { files: 0, bytes: 0, addedLines: 0, removedLines: 0 });

      if (requestState.dryRun) {
        const result = { dryRun: true, committed: false, rolledBack: false, files, totals };
        return {
          text: JSON.stringify(result, null, 2),
          structured: result,
          details: { phase: "dry_run", dryRun: true, committed: false, files, totals }
        };
      }

      const committed = [];
      try {
        for (const file of snapshots) {
          committed.push(file);
          await this.writePreparedFile(file);
        }
      } catch (rawError) {
        const rollbackErrors = [];
        for (const file of committed.reverse()) {
          try {
            if (file.existed) {
              await mkdir(path.dirname(file.targetPath), { recursive: true });
              await writeFile(file.targetPath, file.original);
              if (file.mode !== undefined) await chmod(file.targetPath, file.mode);
            } else {
              await unlink(file.targetPath).catch((error) => {
                if (error?.code !== "ENOENT") throw error;
              });
            }
          } catch (rollbackError) {
            rollbackErrors.push({
              path: file.path,
              error: rollbackError instanceof Error ? rollbackError.message : String(rollbackError)
            });
          }
        }
        if (rollbackErrors.length) {
          throw coreError(CoreErrorCode.ROLLBACK_FAILED, "Patch commit failed and rollback was incomplete", {
            phase: "rollback",
            rolledBack: false,
            rollbackErrors
          });
        }
        const error = normalizeCoreError(rawError, CoreErrorCode.IO_ERROR);
        throw coreError(error.code, error.message, {
          ...error.details,
          phase: "rollback",
          rolledBack: true,
          committedFiles: committed.length
        });
      }

      const result = { dryRun: false, committed: true, rolledBack: false, files, totals };
      return {
        text: JSON.stringify(result, null, 2),
        structured: result,
        details: { phase: "committed", dryRun: false, committed: true, rolledBack: false, files, totals }
      };
    });
  }
}
