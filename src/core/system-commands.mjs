import { access, readFile } from "node:fs/promises";

import { CoreErrorCode, coreError } from "./errors.mjs";
import { sha256 } from "./hash.mjs";
import { runCapturedProcess } from "./process.mjs";

export const EXECUTION_PROFILES = Object.freeze([
  "restricted",
  "user",
  "container-root",
  "host-root"
]);

function deny(message) {
  throw coreError(CoreErrorCode.COMMAND_NOT_ALLOWED, message);
}

function currentUid() {
  return typeof process.getuid === "function" ? process.getuid() : null;
}

async function isContainerRuntime() {
  if (process.platform !== "linux") return false;
  if (process.env.container || process.env.KUBERNETES_SERVICE_HOST) return true;
  if (await access("/.dockerenv").then(() => true).catch(() => false)) return true;
  if (await access("/run/.containerenv").then(() => true).catch(() => false)) return true;
  const cgroup = await readFile("/proc/1/cgroup", "utf8").catch(() => "");
  return /(?:docker|containerd|kubepods|podman|lxc)/i.test(cgroup);
}

function displayArgument(value) {
  return /^[A-Za-z0-9_./:@%+=,-]+$/.test(value) ? value : JSON.stringify(value);
}

export class SystemCommandService {
  constructor({ workspace, maxCommandOutputBytes, executionProfile = "restricted", runtimeIdentity }) {
    if (!EXECUTION_PROFILES.includes(executionProfile)) {
      throw new Error(`Unsupported execution profile: ${executionProfile}`);
    }
    this.workspace = workspace;
    this.maxCommandOutputBytes = maxCommandOutputBytes;
    this.executionProfile = executionProfile;
    this.runtimeIdentity = runtimeIdentity;
  }

  static async inspectRuntime(executionProfile) {
    if (!EXECUTION_PROFILES.includes(executionProfile)) {
      throw new Error(`LUNA_EXECUTION_PROFILE must be one of: ${EXECUTION_PROFILES.join(", ")}`);
    }
    const uid = currentUid();
    const container = await isContainerRuntime();
    if (["container-root", "host-root"].includes(executionProfile) && process.platform !== "linux") {
      throw new Error(`${executionProfile} is Linux-only. On Windows, the user profile inherits the privileges of the account that launched Luna.`);
    }
    if (executionProfile === "user" && process.platform === "linux" && uid === 0) {
      throw new Error("The user execution profile refuses implicit root. Select container-root or host-root explicitly.");
    }
    if (executionProfile === "container-root") {
      if (process.platform !== "linux" || uid !== 0 || !container) {
        throw new Error("container-root requires Luna to run as UID 0 inside a detected Linux container.");
      }
    }
    if (executionProfile === "host-root") {
      if (process.platform !== "linux" || uid !== 0 || container) {
        throw new Error("host-root requires Luna to run as UID 0 on a non-container Linux host.");
      }
    }
    return Object.freeze({
      platform: process.platform,
      uid,
      container,
      root: process.platform === "linux" && uid === 0
    });
  }

  validate(program, args) {
    if (this.executionProfile === "restricted") {
      deny("System command execution is disabled; choose an explicit LUNA_EXECUTION_PROFILE");
    }
    if (typeof program !== "string" || !program.trim() || program.length > 300
      || program.includes("\0") || program.includes("\n") || program.includes("\r")) {
      deny("program must be a non-empty string of at most 300 characters without control characters");
    }
    if (!Array.isArray(args) || args.length > 100
      || args.some((arg) => typeof arg !== "string" || arg.length > 2000 || arg.includes("\0"))) {
      deny("args must contain at most 100 strings of at most 2000 characters");
    }
    const displayCommand = [program, ...args].map(displayArgument).join(" ");
    if (displayCommand.length > 800) {
      deny("The rendered command exceeds the 800 character approval display limit");
    }
    return displayCommand;
  }

  preview({ program, args }) {
    return this.validate(program, args);
  }

  async execute({ program, args, cwd: relativeCwd, timeoutSeconds }) {
    const displayCommand = this.validate(program, args);
    const commandCwd = this.workspace.resolve(relativeCwd);
    await this.workspace.rejectSymlinks(commandCwd);
    const output = await runCapturedProcess(program, args, {
      cwd: commandCwd,
      timeoutMs: timeoutSeconds * 1000,
      maxOutputBytes: this.maxCommandOutputBytes
    });
    const payload = {
      command: displayCommand,
      execution_profile: this.executionProfile,
      effective_uid: this.runtimeIdentity.uid,
      container: this.runtimeIdentity.container,
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
      structured: payload,
      details: {
        executionProfile: this.executionProfile,
        effectiveUid: this.runtimeIdentity.uid,
        container: this.runtimeIdentity.container,
        program,
        argumentCount: args.length,
        commandSha256: sha256(Buffer.from(displayCommand, "utf8")),
        exitCode: output.exitCode,
        timedOut: output.timedOut,
        stdoutTruncated: output.stdoutTruncated,
        stderrTruncated: output.stderrTruncated
      }
    };
  }
}
