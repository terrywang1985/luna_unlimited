import path from "node:path";
import os from "node:os";
import { randomBytes } from "node:crypto";
import { lstat, readdir, rename, rm } from "node:fs/promises";

import { CoreErrorCode, coreError, normalizeCoreError } from "./errors.mjs";
import { resolvePublicAddresses } from "./network.mjs";
import { launchFor, runCapturedProcess } from "./process.mjs";
import { isSensitiveRelativePath } from "./workspace.mjs";

async function lstatOrMissing(targetPath) {
  try {
    return await lstat(targetPath);
  } catch (error) {
    if (error?.code === "ENOENT") return null;
    throw normalizeCoreError(error, CoreErrorCode.IO_ERROR);
  }
}

function repositoryError(code, message, details = {}) {
  throw coreError(code, message, details);
}

export async function resolvePublicGitHubRepositoryUrl(rawUrl, lookupFn) {
  let url;
  try {
    url = new URL(rawUrl);
  } catch {
    repositoryError(CoreErrorCode.REPOSITORY_SOURCE_NOT_ALLOWED, "Repository URL is invalid");
  }
  if (url.protocol !== "https:" || url.username || url.password || (url.port && url.port !== "443")) {
    repositoryError(
      CoreErrorCode.REPOSITORY_SOURCE_NOT_ALLOWED,
      "Repository must use credential-free HTTPS on port 443"
    );
  }
  if (url.hostname.toLocaleLowerCase() !== "github.com" || url.search || url.hash || url.pathname.includes("%")) {
    repositoryError(
      CoreErrorCode.REPOSITORY_SOURCE_NOT_ALLOWED,
      "Only public github.com repository URLs without query parameters or fragments are allowed"
    );
  }
  const match = /^\/([A-Za-z0-9_.-]+)\/([A-Za-z0-9_.-]+?)(?:\.git)?\/?$/.exec(url.pathname);
  if (!match || [".", ".."].includes(match[1]) || [".", ".."].includes(match[2])) {
    repositoryError(
      CoreErrorCode.REPOSITORY_SOURCE_NOT_ALLOWED,
      "Repository URL must have the form https://github.com/owner/repository"
    );
  }
  const addresses = await resolvePublicAddresses("github.com", lookupFn);
  if (!addresses.length) {
    repositoryError(CoreErrorCode.REPOSITORY_SOURCE_NOT_ALLOWED, "github.com did not resolve only to public addresses");
  }
  const owner = match[1];
  const repository = match[2];
  return {
    url: `https://github.com/${owner}/${repository}.git`,
    host: "github.com",
    repositoryPath: `${owner}/${repository}`
  };
}

function validateRef(ref) {
  if (ref == null) return null;
  if (typeof ref !== "string" || ref.length < 1 || ref.length > 255) {
    repositoryError(CoreErrorCode.INVALID_ARGUMENT, "ref must be a branch or tag name of at most 255 characters");
  }
  if (ref.startsWith("-") || ref.startsWith("/") || ref.endsWith("/") || ref.endsWith(".")
    || ref.includes("..") || ref.includes("@{") || ref.includes("//")
    || /[\x00-\x20~^:?*[\\]/.test(ref)) {
    repositoryError(CoreErrorCode.INVALID_ARGUMENT, "ref contains characters that are unsafe for a Git branch or tag");
  }
  return ref;
}

function cloneEnvironment(workspaceRoot) {
  const nullDevice = process.platform === "win32" ? "NUL" : os.devNull;
  return {
    GIT_ALLOW_PROTOCOL: "https",
    GIT_ASKPASS: "",
    GIT_CEILING_DIRECTORIES: path.dirname(workspaceRoot),
    GIT_CONFIG_GLOBAL: nullDevice,
    GIT_CONFIG_NOSYSTEM: "1",
    GIT_LFS_SKIP_SMUDGE: "1",
    GIT_OPTIONAL_LOCKS: "0",
    GIT_TERMINAL_PROMPT: "0",
    HTTP_PROXY: "",
    HTTPS_PROXY: "",
    ALL_PROXY: "",
    NO_PROXY: "*"
  };
}

async function inspectRepositoryTree(rootPath, maxFiles, maxBytes) {
  const pending = [{ absolutePath: rootPath, relativePath: "" }];
  let files = 0;
  let bytes = 0;
  while (pending.length) {
    const current = pending.pop();
    const entries = await readdir(current.absolutePath, { withFileTypes: true })
      .catch((error) => { throw normalizeCoreError(error, CoreErrorCode.IO_ERROR); });
    for (const entry of entries) {
      const relativePath = current.relativePath ? path.join(current.relativePath, entry.name) : entry.name;
      const absolutePath = path.join(current.absolutePath, entry.name);
      const info = await lstat(absolutePath).catch((error) => {
        throw normalizeCoreError(error, CoreErrorCode.IO_ERROR);
      });
      files += 1;
      bytes += info.size;
      if (files > maxFiles) {
        repositoryError(CoreErrorCode.REPOSITORY_LIMIT_EXCEEDED, `Repository exceeds ${maxFiles} filesystem entries`);
      }
      if (bytes > maxBytes) {
        repositoryError(CoreErrorCode.REPOSITORY_LIMIT_EXCEEDED, `Repository exceeds ${maxBytes} bytes`);
      }
      if (info.isSymbolicLink()) {
        repositoryError(
          CoreErrorCode.SYMBOLIC_LINK,
          "Repositories containing symbolic links are not accepted by the safe clone policy"
        );
      }
      const firstSegment = relativePath.split(path.sep, 1)[0].toLocaleLowerCase();
      if (firstSegment !== ".git" && isSensitiveRelativePath(relativePath)) {
        repositoryError(
          CoreErrorCode.SENSITIVE_PATH,
          "Repository contains a path reserved for credentials or Luna internal state"
        );
      }
      if (entry.isDirectory()) pending.push({ absolutePath, relativePath });
    }
  }
  return { files, bytes };
}

export class RepositoryService {
  constructor({
    workspace,
    mutations,
    maxRepositoryFiles = 10000,
    maxRepositoryBytes = 128 * 1024 * 1024,
    maxCommandOutputBytes = 256 * 1024,
    processRunner = runCapturedProcess,
    repositoryUrlResolver = resolvePublicGitHubRepositoryUrl
  }) {
    this.workspace = workspace;
    this.mutations = mutations;
    this.maxRepositoryFiles = maxRepositoryFiles;
    this.maxRepositoryBytes = maxRepositoryBytes;
    this.maxCommandOutputBytes = maxCommandOutputBytes;
    this.processRunner = processRunner;
    this.repositoryUrlResolver = repositoryUrlResolver;
  }

  async clone({ url, destination, ref = null, depth = 1, timeoutSeconds = 180 }) {
    if (!Number.isInteger(depth) || depth < 1 || depth > 50) {
      repositoryError(CoreErrorCode.INVALID_ARGUMENT, "depth must be an integer between 1 and 50");
    }
    if (!Number.isInteger(timeoutSeconds) || timeoutSeconds < 1 || timeoutSeconds > 600) {
      repositoryError(CoreErrorCode.INVALID_ARGUMENT, "timeoutSeconds must be an integer between 1 and 600");
    }
    const selectedRef = validateRef(ref);
    const source = await this.repositoryUrlResolver(url);
    const destinationPath = this.workspace.resolve(destination);
    if (destinationPath === this.workspace.root) {
      repositoryError(CoreErrorCode.INVALID_ARGUMENT, "Repository destination cannot be the workspace root");
    }
    const parentPath = path.dirname(destinationPath);
    await this.workspace.rejectSymlinks(parentPath);
    const parentInfo = await lstat(parentPath).catch((error) => {
      throw normalizeCoreError(error, CoreErrorCode.IO_ERROR);
    });
    if (!parentInfo.isDirectory()) {
      repositoryError(CoreErrorCode.PATH_NOT_DIRECTORY, "Repository destination parent is not a directory");
    }

    return this.mutations.run(destinationPath, async () => {
      if (await lstatOrMissing(destinationPath)) {
        repositoryError(CoreErrorCode.FILE_ALREADY_EXISTS, "Repository destination already exists");
      }
      const temporaryName = `.luna-clone-${randomBytes(12).toString("hex")}`;
      const temporaryPath = path.join(parentPath, temporaryName);
      const environmentOverrides = cloneEnvironment(this.workspace.root);
      try {
        const cloneArgs = [
          "-c", "credential.helper=",
          "-c", "http.proxy=",
          "-c", "https.proxy=",
          "-c", "http.followRedirects=false",
          "-c", "protocol.file.allow=never",
          "-c", "protocol.ext.allow=never",
          "clone",
          "--depth", String(depth),
          "--single-branch",
          "--no-tags",
          ...(selectedRef ? ["--branch", selectedRef] : []),
          "--",
          source.url,
          temporaryName
        ];
        const cloneLaunch = launchFor("git", cloneArgs);
        const output = await this.processRunner(cloneLaunch.executable, cloneLaunch.args, {
          cwd: parentPath,
          timeoutMs: timeoutSeconds * 1000,
          maxOutputBytes: this.maxCommandOutputBytes,
          environmentOverrides
        }).catch((error) => {
          throw normalizeCoreError(error, CoreErrorCode.REPOSITORY_CLONE_FAILED);
        });
        if (output.timedOut) {
          repositoryError(CoreErrorCode.COMMAND_TIMEOUT, "Repository clone timed out");
        }
        if (output.exitCode !== 0) {
          repositoryError(CoreErrorCode.REPOSITORY_CLONE_FAILED, "Public repository clone failed", {
            exitCode: output.exitCode,
            stderr: output.stderr.slice(-2000),
            stderrTruncated: output.stderrTruncated
          });
        }
        const gitInfo = await lstatOrMissing(path.join(temporaryPath, ".git"));
        if (!gitInfo || (!gitInfo.isDirectory() && !gitInfo.isFile())) {
          repositoryError(CoreErrorCode.REPOSITORY_CLONE_FAILED, "Clone did not produce a valid Git worktree");
        }
        const summary = await inspectRepositoryTree(
          temporaryPath,
          this.maxRepositoryFiles,
          this.maxRepositoryBytes
        );
        const headArgs = [
          "--no-pager",
          "-c", "core.fsmonitor=false",
          "-c", "core.hooksPath=",
          "rev-parse", "--verify", "HEAD"
        ];
        const headLaunch = launchFor("git", headArgs);
        const head = await this.processRunner(headLaunch.executable, headLaunch.args, {
          cwd: temporaryPath,
          timeoutMs: Math.min(timeoutSeconds * 1000, 15_000),
          maxOutputBytes: 4096,
          environmentOverrides
        }).catch((error) => {
          throw normalizeCoreError(error, CoreErrorCode.REPOSITORY_CLONE_FAILED);
        });
        const commit = head.stdout.trim();
        if (head.timedOut || head.exitCode !== 0 || !/^[a-f0-9]{40,64}$/i.test(commit)) {
          repositoryError(CoreErrorCode.REPOSITORY_CLONE_FAILED, "Could not verify the cloned repository HEAD");
        }
        if (await lstatOrMissing(destinationPath)) {
          repositoryError(CoreErrorCode.FILE_ALREADY_EXISTS, "Repository destination was created concurrently");
        }
        await rename(temporaryPath, destinationPath).catch((error) => {
          throw normalizeCoreError(error, CoreErrorCode.IO_ERROR);
        });
        const result = {
          repository: `${source.host}/${source.repositoryPath}`,
          destination: this.workspace.display(destinationPath),
          ref: selectedRef,
          commit: commit.toLocaleLowerCase(),
          depth,
          shallow: true,
          files: summary.files,
          bytes: summary.bytes
        };
        return {
          text: JSON.stringify(result, null, 2),
          structured: result,
          details: {
            repositoryHost: source.host,
            repositoryPath: source.repositoryPath,
            destination: result.destination,
            ref: selectedRef,
            commit: result.commit,
            depth,
            files: result.files,
            bytes: result.bytes,
            riskLevel: "network",
            networkAccess: true,
            publicRepositoryOnly: true
          }
        };
      } finally {
        await rm(temporaryPath, { recursive: true, force: true }).catch(() => {});
      }
    });
  }
}
