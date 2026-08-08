import path from "node:path";
import os from "node:os";
import { readFile, stat } from "node:fs/promises";

import { CoreErrorCode, coreError, normalizeCoreError } from "./errors.mjs";
import { sha256 } from "./hash.mjs";
import { launchFor, runCapturedProcess } from "./process.mjs";

function deny(message) {
  throw coreError(CoreErrorCode.COMMAND_NOT_ALLOWED, message);
}

function validateRelativeCommandPath(value) {
  if (value.includes("\0") || value.includes("\n") || value.includes("\r")) return false;
  if (path.isAbsolute(value)) return false;
  return !value.split(/[\\/]+/).includes("..");
}

export class CommandPolicy {
  classify(program, args) {
    if (program === "npm") {
      return {
        riskLevel: "build",
        transitiveExecution: true,
        source: "mutable-workspace-manifest"
      };
    }
    if (program === "go") return { riskLevel: "build", transitiveExecution: true, source: "workspace-code" };
    return { riskLevel: "read", transitiveExecution: false, source: "direct-command" };
  }

  validate(program, args) {
    if (!Array.isArray(args) || args.length === 0 || args.length > 50) {
      deny("args must contain between 1 and 50 items");
    }
    if (args.some((arg) => typeof arg !== "string" || arg.length > 1000 || arg.includes("\0"))) {
      deny("Each argument must be a string of at most 1000 characters");
    }

    if (program === "git") {
      const subcommand = args[0];
      const rest = args.slice(1);
      if (subcommand === "status") {
        const allowed = new Set(["--short", "--branch", "--porcelain", "--porcelain=v1", "--porcelain=v2"]);
        if (rest.some((arg) => !allowed.has(arg))) deny("Unsupported git status argument");
        return this.classify(program, args);
      }
      if (subcommand === "diff") {
        const allowedFlags = new Set(["--stat", "--name-only", "--name-status", "--cached", "--staged", "--"]);
        for (const arg of rest) {
          if (arg.startsWith("-") && !allowedFlags.has(arg)) deny("Unsupported git diff argument");
          if (!arg.startsWith("-") && !validateRelativeCommandPath(arg)) deny("Unsafe git path argument");
        }
        return this.classify(program, args);
      }
      if (subcommand === "log") {
        for (let index = 0; index < rest.length; index += 1) {
          const arg = rest[index];
          if (["--oneline", "--decorate", "--no-decorate", "--all"].includes(arg)) continue;
          if (/^-n\d+$/.test(arg) || /^--max-count=\d+$/.test(arg)) continue;
          if (arg === "-n" && /^\d+$/.test(rest[index + 1] || "")) {
            index += 1;
            continue;
          }
          deny("Unsupported git log argument");
        }
        return this.classify(program, args);
      }
      deny("Allowed git subcommands: status, diff, log");
    }

    if (program === "go") {
      const subcommand = args[0];
      const rest = args.slice(1);
      const commonFlags = [/^-v$/, /^-race$/, /^-trimpath$/, /^-tags=[\w,.-]+$/];
      const testFlags = [/^-short$/, /^-count=\d+$/, /^-run=[\w./|^$*+?()[\]{}-]+$/, /^-timeout=\d+(ms|s|m|h)$/];
      if (!["test", "build"].includes(subcommand)) deny("Allowed go subcommands: test, build");
      for (const arg of rest) {
        if (arg.startsWith("-")) {
          const patterns = subcommand === "test" ? [...commonFlags, ...testFlags] : commonFlags;
          if (!patterns.some((pattern) => pattern.test(arg))) deny(`Unsupported go ${subcommand} flag`);
        } else if (!validateRelativeCommandPath(arg)) {
          deny("Unsafe Go package path");
        }
      }
      return this.classify(program, args);
    }

    if (program === "npm") {
      if (args.length === 1 && args[0] === "test") return this.classify(program, args);
      if (args.length === 2 && args[0] === "run" && ["build", "test", "lint", "typecheck"].includes(args[1])) {
        return this.classify(program, args);
      }
      deny("Allowed npm commands: test, run build, run test, run lint, run typecheck");
    }

    deny("Unsupported program");
  }
}

export class CommandService {
  constructor({ workspace, mutations, maxCommandOutputBytes, commandPolicy = new CommandPolicy() }) {
    this.workspace = workspace;
    this.mutations = mutations;
    this.maxCommandOutputBytes = maxCommandOutputBytes;
    this.policy = commandPolicy;
  }

  async execute({ program, args, cwd: relativeCwd, timeoutSeconds }) {
    const classification = this.policy.validate(program, args);
    const commandCwd = this.workspace.resolve(relativeCwd);
    await this.workspace.rejectSymlinks(commandCwd);
    const info = await stat(commandCwd).catch((error) => { throw normalizeCoreError(error, CoreErrorCode.IO_ERROR); });
    if (!info.isDirectory()) throw coreError(CoreErrorCode.PATH_NOT_DIRECTORY, "Command cwd is not a directory");

    const launch = launchFor(program, args);
    const output = await runCapturedProcess(launch.executable, launch.args, {
      cwd: commandCwd,
      timeoutMs: timeoutSeconds * 1000,
      maxOutputBytes: this.maxCommandOutputBytes
    });
    const displayCommand = [program, ...args].map((value) => (/\s/.test(value) ? JSON.stringify(value) : value)).join(" ");
    const payload = {
      command: displayCommand,
      cwd: this.workspace.display(commandCwd),
      exit_code: output.exitCode,
      stdout: output.stdout,
      stderr: output.stderr,
      timed_out: output.timedOut,
      stdout_truncated: output.stdoutTruncated,
      stderr_truncated: output.stderrTruncated
    };
    return {
      text: JSON.stringify(payload, null, 2),
      details: {
        program,
        args,
        exitCode: output.exitCode,
        timedOut: output.timedOut,
        stdoutTruncated: output.stdoutTruncated,
        stderrTruncated: output.stderrTruncated,
        riskLevel: classification.riskLevel,
        transitiveExecution: classification.transitiveExecution,
        commandSource: classification.source
      }
    };
  }

  async installDependencies({ packageManager, mode, cwd: relativeCwd, timeoutSeconds }) {
    if (packageManager !== "npm") deny("Only npm dependency installation is currently supported");
    const commandCwd = this.workspace.resolve(relativeCwd);
    await this.workspace.rejectSymlinks(commandCwd);
    const info = await stat(commandCwd).catch((error) => { throw normalizeCoreError(error, CoreErrorCode.IO_ERROR); });
    if (!info.isDirectory()) throw coreError(CoreErrorCode.PATH_NOT_DIRECTORY, "Dependency install cwd is not a directory");

    const manifestPath = this.workspace.resolve(path.join(relativeCwd, "package.json"));
    const lockPath = this.workspace.resolve(path.join(relativeCwd, "package-lock.json"));
    await this.workspace.rejectSymlinks(manifestPath, true);
    await this.workspace.rejectSymlinks(lockPath, true);

    return this.mutations.runMany([commandCwd, manifestPath, lockPath], async () => {
      const manifestBuffer = await readFile(manifestPath).catch((error) => {
        if (error?.code === "ENOENT") {
          throw coreError(CoreErrorCode.PATH_NOT_FILE, "package.json was not found in the dependency install cwd");
        }
        throw normalizeCoreError(error, CoreErrorCode.IO_ERROR);
      });
      let manifest;
      try {
        manifest = JSON.parse(manifestBuffer.toString("utf8"));
      } catch {
        throw coreError(CoreErrorCode.INVALID_ARGUMENT, "package.json is not valid JSON");
      }

      const lockExists = await stat(lockPath).then((entry) => entry.isFile()).catch((error) => {
        if (error?.code === "ENOENT") return false;
        throw normalizeCoreError(error, CoreErrorCode.IO_ERROR);
      });
      const selectedMode = mode === "auto" ? (lockExists ? "ci" : "install") : mode;
      if (selectedMode === "ci" && !lockExists) {
        throw coreError(CoreErrorCode.INVALID_ARGUMENT, "npm ci requires package-lock.json");
      }

      const emptyUserConfig = path.join(os.tmpdir(), "luna-npm-empty-userconfig");
      const args = [
        selectedMode,
        "--ignore-scripts",
        "--no-audit",
        "--no-fund",
        "--registry=https://registry.npmjs.org/",
        `--userconfig=${emptyUserConfig}`
      ];
      if (selectedMode === "install") args.push("--package-lock=true");

      const launch = launchFor("npm", args);
      const output = await runCapturedProcess(launch.executable, launch.args, {
        cwd: commandCwd,
        timeoutMs: timeoutSeconds * 1000,
        maxOutputBytes: this.maxCommandOutputBytes,
        environmentOverrides: {
          NPM_CONFIG_IGNORE_SCRIPTS: "true",
          NPM_CONFIG_AUDIT: "false",
          NPM_CONFIG_FUND: "false",
          NPM_CONFIG_REGISTRY: "https://registry.npmjs.org/",
          NPM_CONFIG_USERCONFIG: emptyUserConfig
        }
      });
      const dependencyCount = ["dependencies", "devDependencies", "optionalDependencies", "peerDependencies"]
        .reduce((count, key) => count + Object.keys(manifest?.[key] || {}).length, 0);
      const payload = {
        success: output.exitCode === 0 && !output.timedOut,
        command: `npm ${args.join(" ")}`,
        cwd: this.workspace.display(commandCwd),
        package_manager: "npm",
        mode: selectedMode,
        package_name: typeof manifest?.name === "string" ? manifest.name : null,
        dependency_count: dependencyCount,
        manifest_sha256: sha256(manifestBuffer),
        lifecycle_scripts_enabled: false,
        registry: "https://registry.npmjs.org/",
        exit_code: output.exitCode,
        stdout: output.stdout,
        stderr: output.stderr,
        timed_out: output.timedOut,
        stdout_truncated: output.stdoutTruncated,
        stderr_truncated: output.stderrTruncated
      };
      return {
        text: JSON.stringify(payload, null, 2),
        structured: payload,
        details: {
          packageManager: "npm",
          mode: selectedMode,
          manifestSha256: payload.manifest_sha256,
          dependencyCount,
          lifecycleScriptsEnabled: false,
          registry: payload.registry,
          exitCode: output.exitCode,
          timedOut: output.timedOut,
          riskLevel: "network",
          transitiveExecution: false
        }
      };
    });
  }
}
