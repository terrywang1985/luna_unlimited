import path from "node:path";
import { randomBytes, randomUUID } from "node:crypto";
import {
  chmod,
  lstat,
  mkdir,
  readFile,
  readdir,
  realpath,
  rename,
  rm,
  rmdir,
  stat,
  unlink,
  writeFile
} from "node:fs/promises";

import { CoreErrorCode, coreError, normalizeCoreError } from "./errors.mjs";
import { sha256 } from "./hash.mjs";
import { isSensitiveRelativePath } from "./workspace.mjs";

const CHECKPOINT_ID_PATTERN = /^cp_\d{8}T\d{6}Z_[a-f0-9]{8}$/;
const EXCLUDED_DIRECTORY_NAMES = new Set(["node_modules"]);

function portablePath(relativePath) {
  return relativePath.split(path.sep).join("/");
}

function nativePath(relativePath) {
  return relativePath.split("/").join(path.sep);
}

function isInside(parentPath, candidatePath) {
  const relative = path.relative(parentPath, candidatePath);
  return relative === "" || (!path.isAbsolute(relative) && relative !== ".." && !relative.startsWith(`..${path.sep}`));
}

function checkpointId() {
  const timestamp = new Date().toISOString().replace(/[-:]/g, "").replace(/\.\d{3}Z$/, "Z");
  return `cp_${timestamp}_${randomBytes(4).toString("hex")}`;
}

function validateLabel(label) {
  if (label === undefined || label === null || label === "") return null;
  if (typeof label !== "string" || label.length > 120 || /[\0\r\n]/.test(label)) {
    throw coreError(CoreErrorCode.INVALID_ARGUMENT, "Checkpoint label must be at most 120 characters without line breaks");
  }
  return label;
}

function validateCheckpointId(id) {
  if (typeof id !== "string" || !CHECKPOINT_ID_PATTERN.test(id)) {
    throw coreError(CoreErrorCode.INVALID_ARGUMENT, "Invalid checkpoint_id");
  }
  return id;
}

function validateSnapshotPath(relativePath) {
  if (typeof relativePath !== "string" || !relativePath || relativePath.includes("\0") || path.posix.isAbsolute(relativePath)) {
    throw coreError(CoreErrorCode.CHECKPOINT_INVALID, "Checkpoint contains an invalid relative path");
  }
  const segments = relativePath.split("/");
  if (segments.some((segment) => !segment || segment === "." || segment === "..")) {
    throw coreError(CoreErrorCode.CHECKPOINT_INVALID, `Checkpoint contains an unsafe path: ${relativePath}`);
  }
  return relativePath;
}

function stateSummary(state) {
  return {
    files: state.files.size,
    directories: Math.max(0, state.directories.size - 1),
    bytes: state.totalBytes,
    excluded: { ...state.excluded }
  };
}

export class CheckpointService {
  constructor({
    workspace,
    mutations,
    checkpointRoot,
    excludedPaths = [],
    maxCheckpointFiles = 5000,
    maxCheckpointBytes = 128 * 1024 * 1024,
    maxCheckpoints = 20
  }) {
    this.workspace = workspace;
    this.mutations = mutations;
    this.checkpointBase = path.resolve(checkpointRoot);
    this.excludedPaths = excludedPaths.map((entry) => path.resolve(entry));
    this.maxCheckpointFiles = maxCheckpointFiles;
    this.maxCheckpointBytes = maxCheckpointBytes;
    this.maxCheckpoints = maxCheckpoints;
    this.backend = "local-snapshot";
    this.workspaceFingerprint = null;
    this.root = null;
  }

  async initialize() {
    await mkdir(this.workspace.root, { recursive: true });
    await mkdir(this.checkpointBase, { recursive: true, mode: 0o700 });
    const [workspaceRoot, checkpointBase] = await Promise.all([
      realpath(this.workspace.root),
      realpath(this.checkpointBase)
    ]);
    if (isInside(workspaceRoot, checkpointBase)) {
      throw coreError(CoreErrorCode.INVALID_ARGUMENT, "Checkpoint storage must be outside the authorized workspace");
    }
    this.workspaceFingerprint = sha256(Buffer.from(workspaceRoot, "utf8"));
    this.root = path.join(checkpointBase, this.workspaceFingerprint.slice(0, 24));
    await mkdir(this.root, { recursive: true, mode: 0o700 });
  }

  async captureWorkspace() {
    const files = new Map();
    const directories = new Set(["."]);
    const excluded = { sensitive: 0, dependencies: 0, runtime: 0, other: 0 };
    let totalBytes = 0;
    const pending = [{ absolute: this.workspace.root, relative: "" }];

    while (pending.length) {
      const current = pending.pop();
      const entries = await readdir(current.absolute, { withFileTypes: true })
        .catch((error) => { throw normalizeCoreError(error, CoreErrorCode.IO_ERROR); });
      for (const entry of entries) {
        const relativeNative = current.relative ? path.join(current.relative, entry.name) : entry.name;
        const relative = portablePath(relativeNative);
        if (isSensitiveRelativePath(relative)) {
          excluded.sensitive += 1;
          continue;
        }
        if (entry.isDirectory() && EXCLUDED_DIRECTORY_NAMES.has(entry.name.toLocaleLowerCase())) {
          excluded.dependencies += 1;
          continue;
        }

        const absolute = this.workspace.resolve(relativeNative);
        if (this.excludedPaths.some((excludedPath) => isInside(excludedPath, absolute))) {
          excluded.runtime += 1;
          continue;
        }
        const info = await lstat(absolute).catch((error) => { throw normalizeCoreError(error, CoreErrorCode.IO_ERROR); });
        if (info.isSymbolicLink()) {
          throw coreError(CoreErrorCode.SYMBOLIC_LINK, `Checkpoint cannot include symbolic link: ${relative}`);
        }
        if (info.isDirectory()) {
          if (directories.size > this.maxCheckpointFiles) {
            throw coreError(
              CoreErrorCode.CHECKPOINT_LIMIT_EXCEEDED,
              `Checkpoint exceeds the ${this.maxCheckpointFiles} directory limit`
            );
          }
          directories.add(relative);
          pending.push({ absolute, relative: relativeNative });
          continue;
        }
        if (!info.isFile()) {
          excluded.other += 1;
          continue;
        }
        if (files.size + 1 > this.maxCheckpointFiles) {
          throw coreError(
            CoreErrorCode.CHECKPOINT_LIMIT_EXCEEDED,
            `Checkpoint exceeds the ${this.maxCheckpointFiles} file limit`
          );
        }
        if (totalBytes + info.size > this.maxCheckpointBytes) {
          throw coreError(
            CoreErrorCode.CHECKPOINT_LIMIT_EXCEEDED,
            `Checkpoint exceeds the ${this.maxCheckpointBytes} byte limit`
          );
        }
        const content = await readFile(absolute).catch((error) => { throw normalizeCoreError(error, CoreErrorCode.IO_ERROR); });
        const after = await stat(absolute).catch((error) => { throw normalizeCoreError(error, CoreErrorCode.IO_ERROR); });
        if (!after.isFile() || after.size !== info.size || after.mtimeMs !== info.mtimeMs) {
          throw coreError(CoreErrorCode.FILE_CHANGED, `File changed while creating checkpoint: ${relative}`);
        }
        totalBytes += content.length;
        files.set(relative, {
          content,
          bytes: content.length,
          sha256: sha256(content),
          mode: info.mode & 0o777
        });
      }
    }
    return { files, directories, totalBytes, excluded };
  }

  checkpointPath(id) {
    validateCheckpointId(id);
    const target = path.resolve(this.root, id);
    if (!isInside(this.root, target)) throw coreError(CoreErrorCode.CHECKPOINT_INVALID, "Checkpoint path escaped storage root");
    return target;
  }

  async storeState(state, label) {
    const id = checkpointId();
    const createdAt = new Date().toISOString();
    const target = this.checkpointPath(id);
    const temporary = path.join(this.root, `.tmp-${randomUUID()}`);
    const filesRoot = path.join(temporary, "files");
    const manifest = {
      schemaVersion: 1,
      id,
      label,
      createdAt,
      backend: this.backend,
      workspaceFingerprint: this.workspaceFingerprint,
      files: [...state.files.entries()].sort(([left], [right]) => left.localeCompare(right)).map(([filePath, file]) => ({
        path: filePath,
        bytes: file.bytes,
        sha256: file.sha256,
        mode: file.mode
      })),
      directories: [...state.directories].filter((entry) => entry !== ".").sort(),
      totalBytes: state.totalBytes,
      excluded: state.excluded
    };

    try {
      await mkdir(filesRoot, { recursive: true, mode: 0o700 });
      for (const [filePath, file] of state.files) {
        const destination = path.resolve(filesRoot, nativePath(filePath));
        if (!isInside(filesRoot, destination)) throw coreError(CoreErrorCode.CHECKPOINT_INVALID, "Snapshot file escaped storage root");
        await mkdir(path.dirname(destination), { recursive: true, mode: 0o700 });
        await writeFile(destination, file.content, { mode: 0o600, flag: "wx" });
      }
      await writeFile(path.join(temporary, "manifest.json"), `${JSON.stringify(manifest, null, 2)}\n`, {
        encoding: "utf8",
        mode: 0o600,
        flag: "wx"
      });
      await rename(temporary, target);
    } catch (rawError) {
      await rm(temporary, { recursive: true, force: true }).catch(() => {});
      throw normalizeCoreError(rawError, CoreErrorCode.IO_ERROR);
    }
    return manifest;
  }

  validateManifest(manifest, expectedId) {
    const excluded = manifest?.excluded;
    if (
      !manifest
      || manifest.schemaVersion !== 1
      || manifest.id !== expectedId
      || manifest.workspaceFingerprint !== this.workspaceFingerprint
      || manifest.backend !== this.backend
      || !Array.isArray(manifest.files)
      || !Array.isArray(manifest.directories)
      || manifest.files.length > this.maxCheckpointFiles
      || manifest.directories.length > this.maxCheckpointFiles
      || !Number.isInteger(manifest.totalBytes)
      || manifest.totalBytes < 0
      || manifest.totalBytes > this.maxCheckpointBytes
      || (manifest.label !== null && (typeof manifest.label !== "string" || manifest.label.length > 120))
      || typeof manifest.createdAt !== "string"
      || Number.isNaN(Date.parse(manifest.createdAt))
      || !excluded
      || !["sensitive", "dependencies", "runtime", "other"].every(
        (name) => Number.isInteger(excluded[name]) && excluded[name] >= 0
      )
    ) {
      throw coreError(CoreErrorCode.CHECKPOINT_INVALID, "Checkpoint manifest is invalid or belongs to another workspace");
    }
  }

  async readManifest(id) {
    const checkpointDirectory = this.checkpointPath(id);
    let manifest;
    try {
      const directoryInfo = await lstat(checkpointDirectory);
      if (!directoryInfo.isDirectory() || directoryInfo.isSymbolicLink()) {
        throw coreError(CoreErrorCode.CHECKPOINT_INVALID, `Checkpoint storage is not a private directory: ${id}`);
      }
      const manifestPath = path.join(checkpointDirectory, "manifest.json");
      const manifestInfo = await lstat(manifestPath);
      if (!manifestInfo.isFile() || manifestInfo.isSymbolicLink()) {
        throw coreError(CoreErrorCode.CHECKPOINT_INVALID, `Checkpoint manifest is not a regular file: ${id}`);
      }
      manifest = JSON.parse(await readFile(manifestPath, "utf8"));
    } catch (error) {
      if (error?.code === CoreErrorCode.CHECKPOINT_INVALID) throw error;
      if (error?.code === "ENOENT") throw coreError(CoreErrorCode.CHECKPOINT_NOT_FOUND, `Checkpoint not found: ${id}`);
      if (error instanceof SyntaxError) throw coreError(CoreErrorCode.CHECKPOINT_INVALID, `Checkpoint manifest is corrupted: ${id}`);
      throw normalizeCoreError(error, CoreErrorCode.IO_ERROR);
    }
    this.validateManifest(manifest, id);
    return { checkpointDirectory, manifest };
  }

  async loadState(id) {
    const { checkpointDirectory, manifest } = await this.readManifest(id);
    const filesRoot = path.join(checkpointDirectory, "files");
    const files = new Map();
    const directories = new Set(["."]);
    let totalBytes = 0;

    for (const directoryPath of manifest.directories) {
      validateSnapshotPath(directoryPath);
      if (directories.has(directoryPath)) {
        throw coreError(CoreErrorCode.CHECKPOINT_INVALID, `Duplicate snapshot directory: ${directoryPath}`);
      }
      let absolute;
      try {
        absolute = this.workspace.resolve(nativePath(directoryPath));
      } catch {
        throw coreError(CoreErrorCode.CHECKPOINT_INVALID, `Invalid checkpoint directory path: ${directoryPath}`);
      }
      if (!isInside(this.workspace.root, absolute)) throw coreError(CoreErrorCode.CHECKPOINT_INVALID, "Invalid checkpoint directory path");
      directories.add(portablePath(nativePath(directoryPath)));
    }
    for (const entry of manifest.files) {
      if (
        !entry
        || typeof entry.path !== "string"
        || !Number.isInteger(entry.bytes)
        || entry.bytes < 0
        || typeof entry.sha256 !== "string"
        || !/^[a-f0-9]{64}$/i.test(entry.sha256)
      ) {
        throw coreError(CoreErrorCode.CHECKPOINT_INVALID, "Checkpoint contains an invalid file entry");
      }
      validateSnapshotPath(entry.path);
      const relativeNative = nativePath(entry.path);
      try {
        this.workspace.resolve(relativeNative);
      } catch {
        throw coreError(CoreErrorCode.CHECKPOINT_INVALID, `Invalid checkpoint file path: ${entry.path}`);
      }
      const storedPath = path.resolve(filesRoot, relativeNative);
      if (!isInside(filesRoot, storedPath)) throw coreError(CoreErrorCode.CHECKPOINT_INVALID, "Snapshot file escaped storage root");
      const storedInfo = await lstat(storedPath).catch((error) => {
        if (error?.code === "ENOENT") throw coreError(CoreErrorCode.CHECKPOINT_INVALID, `Snapshot file is missing: ${entry.path}`);
        throw normalizeCoreError(error, CoreErrorCode.IO_ERROR);
      });
      if (!storedInfo.isFile() || storedInfo.isSymbolicLink()) {
        throw coreError(CoreErrorCode.CHECKPOINT_INVALID, `Snapshot path is not a regular file: ${entry.path}`);
      }
      const content = await readFile(storedPath);
      if (content.length !== entry.bytes || sha256(content).toLocaleLowerCase() !== entry.sha256.toLocaleLowerCase()) {
        throw coreError(CoreErrorCode.CHECKPOINT_INVALID, `Snapshot integrity check failed: ${entry.path}`);
      }
      if (files.has(entry.path)) throw coreError(CoreErrorCode.CHECKPOINT_INVALID, `Duplicate snapshot path: ${entry.path}`);
      totalBytes += content.length;
      if (totalBytes > this.maxCheckpointBytes) throw coreError(CoreErrorCode.CHECKPOINT_INVALID, "Snapshot exceeds byte limit");
      files.set(entry.path, {
        content,
        bytes: content.length,
        sha256: entry.sha256.toLocaleLowerCase(),
        mode: Number.isInteger(entry.mode) ? entry.mode & 0o777 : 0o600
      });
    }
    for (const filePath of files.keys()) {
      if (directories.has(filePath)) throw coreError(CoreErrorCode.CHECKPOINT_INVALID, `Snapshot path has conflicting types: ${filePath}`);
    }
    if (totalBytes !== manifest.totalBytes) throw coreError(CoreErrorCode.CHECKPOINT_INVALID, "Snapshot total byte count is invalid");
    return {
      id,
      manifest,
      files,
      directories,
      totalBytes,
      excluded: manifest.excluded || { sensitive: 0, dependencies: 0, runtime: 0, other: 0 }
    };
  }

  async checkpointCount() {
    const entries = await readdir(this.root, { withFileTypes: true });
    return entries.filter((entry) => entry.isDirectory() && CHECKPOINT_ID_PATTERN.test(entry.name)).length;
  }

  async create({ label }) {
    const safeLabel = validateLabel(label);
    return this.mutations.runExclusive(async () => {
      const count = await this.checkpointCount();
      if (count >= this.maxCheckpoints) {
        throw coreError(
          CoreErrorCode.CHECKPOINT_LIMIT_EXCEEDED,
          `Checkpoint limit reached (${this.maxCheckpoints}); delete an older checkpoint first`
        );
      }
      const state = await this.captureWorkspace();
      const manifest = await this.storeState(state, safeLabel);
      const result = {
        id: manifest.id,
        label: manifest.label,
        createdAt: manifest.createdAt,
        backend: manifest.backend,
        ...stateSummary(state)
      };
      return {
        text: JSON.stringify(result, null, 2),
        structured: result,
        details: { ...result, committed: true }
      };
    });
  }

  async list() {
    const entries = await readdir(this.root, { withFileTypes: true });
    const checkpoints = [];
    let invalid = 0;
    for (const entry of entries) {
      if (!entry.isDirectory() || !CHECKPOINT_ID_PATTERN.test(entry.name)) continue;
      try {
        const { manifest } = await this.readManifest(entry.name);
        checkpoints.push({
          id: manifest.id,
          label: manifest.label,
          createdAt: manifest.createdAt,
          backend: manifest.backend,
          files: manifest.files.length,
          directories: manifest.directories.length,
          bytes: manifest.totalBytes,
          excluded: manifest.excluded || { sensitive: 0, dependencies: 0, runtime: 0, other: 0 }
        });
      } catch {
        invalid += 1;
      }
    }
    checkpoints.sort((left, right) => right.createdAt.localeCompare(left.createdAt));
    const result = { checkpoints, total: checkpoints.length, invalid };
    return { text: JSON.stringify(result, null, 2), structured: result, details: { total: checkpoints.length, invalid } };
  }

  validateRestoreTypes(target, current) {
    for (const filePath of target.files.keys()) {
      if (current.directories.has(filePath)) {
        throw coreError(
          CoreErrorCode.CHECKPOINT_CONFLICT,
          `Cannot restore file over an existing directory: ${filePath}`
        );
      }
    }
  }

  async applyState(target, current) {
    let deletedFiles = 0;
    let writtenFiles = 0;
    let removedDirectories = 0;
    const targetFiles = new Set(target.files.keys());

    for (const filePath of current.files.keys()) {
      if (!targetFiles.has(filePath)) {
        const absolute = this.workspace.resolve(nativePath(filePath));
        await this.workspace.rejectSymlinks(absolute);
        await unlink(absolute);
        deletedFiles += 1;
      }
    }

    for (const directoryPath of [...target.directories]
      .filter((entry) => entry !== ".")
      .sort((left, right) => left.split("/").length - right.split("/").length)) {
      const absolute = this.workspace.resolve(nativePath(directoryPath));
      await mkdir(absolute, { recursive: true });
      await this.workspace.rejectSymlinks(absolute);
    }

    for (const [filePath, file] of target.files) {
      const absolute = this.workspace.resolve(nativePath(filePath));
      await mkdir(path.dirname(absolute), { recursive: true });
      await this.workspace.rejectSymlinks(path.dirname(absolute));
      await writeFile(absolute, file.content);
      await chmod(absolute, file.mode).catch((error) => {
        if (process.platform !== "win32") throw error;
      });
      writtenFiles += 1;
    }

    const targetDirectories = target.directories;
    for (const directoryPath of [...current.directories]
      .filter((entry) => entry !== "." && !targetDirectories.has(entry))
      .sort((left, right) => right.split("/").length - left.split("/").length)) {
      const absolute = this.workspace.resolve(nativePath(directoryPath));
      try {
        await rmdir(absolute);
        removedDirectories += 1;
      } catch (error) {
        if (!["ENOENT", "ENOTEMPTY", "EEXIST"].includes(error?.code)) throw error;
      }
    }
    return { writtenFiles, deletedFiles, removedDirectories };
  }

  async verifyState(expected) {
    const actual = await this.captureWorkspace();
    if (actual.files.size !== expected.files.size) {
      throw coreError(CoreErrorCode.IO_ERROR, "Restored workspace file count does not match checkpoint");
    }
    for (const [filePath, file] of expected.files) {
      if (actual.files.get(filePath)?.sha256 !== file.sha256) {
        throw coreError(CoreErrorCode.IO_ERROR, `Restored file failed verification: ${filePath}`);
      }
    }
  }

  async restore({ checkpointId: rawCheckpointId }) {
    const id = validateCheckpointId(rawCheckpointId);
    return this.mutations.runExclusive(async () => {
      const target = await this.loadState(id);
      const before = await this.captureWorkspace();
      this.validateRestoreTypes(target, before);
      try {
        const changes = await this.applyState(target, before);
        await this.verifyState(target);
        const result = {
          id,
          label: target.manifest.label,
          restoredAt: new Date().toISOString(),
          backend: this.backend,
          ...changes,
          files: target.files.size,
          bytes: target.totalBytes,
          rolledBack: false
        };
        return { text: JSON.stringify(result, null, 2), structured: result, details: { ...result, committed: true } };
      } catch (rawError) {
        try {
          const partial = await this.captureWorkspace();
          this.validateRestoreTypes(before, partial);
          await this.applyState(before, partial);
          await this.verifyState(before);
        } catch (rollbackError) {
          throw coreError(CoreErrorCode.ROLLBACK_FAILED, "Checkpoint restore failed and rollback was incomplete", {
            checkpointId: id,
            restoreError: rawError instanceof Error ? rawError.message : String(rawError),
            rollbackError: rollbackError instanceof Error ? rollbackError.message : String(rollbackError)
          });
        }
        const error = normalizeCoreError(rawError, CoreErrorCode.IO_ERROR);
        throw coreError(error.code, error.message, { ...error.details, checkpointId: id, rolledBack: true });
      }
    });
  }

  async delete({ checkpointId: rawCheckpointId }) {
    const id = validateCheckpointId(rawCheckpointId);
    return this.mutations.runExclusive(async () => {
      const { manifest } = await this.readManifest(id);
      const target = this.checkpointPath(id);
      await rm(target, { recursive: true, force: false });
      const result = { id, label: manifest.label, deleted: true };
      return { text: JSON.stringify(result, null, 2), structured: result, details: result };
    });
  }

  limits() {
    return {
      backend: this.backend,
      maxCheckpoints: this.maxCheckpoints,
      maxCheckpointFiles: this.maxCheckpointFiles,
      maxCheckpointBytes: this.maxCheckpointBytes,
      excludedDirectoryNames: [...EXCLUDED_DIRECTORY_NAMES]
    };
  }
}
