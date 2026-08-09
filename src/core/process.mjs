import path from "node:path";
import { spawn } from "node:child_process";

const BLOCKED_COMMAND_ENVIRONMENT_NAMES = new Set([
  "AR",
  "BASH_ENV",
  "CC",
  "COMSPEC_OVERRIDE",
  "CXX",
  "ENV",
  "GOENV",
  "GOFLAGS",
  "GOMOD",
  "GOMODCACHE",
  "GONOPROXY",
  "GONOSUMDB",
  "GOPATH",
  "GOPRIVATE",
  "GOPROXY",
  "GOROOT",
  "GOSUMDB",
  "GOTOOLCHAIN",
  "GOTOOLDIR",
  "GOWORK",
  "LESS",
  "LV",
  "NODE_OPTIONS",
  "NODE_PATH",
  "PAGER",
  "PKG_CONFIG",
  "PS4",
  "SHELLOPTS"
]);

function isBlockedCommandEnvironmentName(name) {
  const normalized = name.toLocaleUpperCase();
  if (/(KEY|TOKEN|SECRET|PASSWORD|COOKIE|AUTH|CREDENTIAL)/i.test(normalized)) return true;
  if (BLOCKED_COMMAND_ENVIRONMENT_NAMES.has(normalized)) return true;
  if (normalized.startsWith("GIT_")) return true;
  if (normalized.startsWith("NPM_CONFIG_")) return true;
  if (normalized.startsWith("NPM_PACKAGE_")) return true;
  if (normalized.startsWith("CGO_")) return true;
  if (normalized === "LD_PRELOAD" || normalized.startsWith("DYLD_")) return true;
  return false;
}

export function createSafeCommandEnvironment(environment = process.env) {
  const safeEnvironment = {};
  for (const [name, value] of Object.entries(environment)) {
    if (isBlockedCommandEnvironmentName(name)) continue;
    if (value !== undefined) safeEnvironment[name] = value;
  }
  safeEnvironment.NO_COLOR = "1";
  safeEnvironment.FORCE_COLOR = "0";
  safeEnvironment.LANG = "C.UTF-8";
  safeEnvironment.LC_ALL = "C.UTF-8";
  return safeEnvironment;
}

export function runCapturedProcess(executable, args, { cwd, timeoutMs, maxOutputBytes, environmentOverrides = {} }) {
  return new Promise((resolve, reject) => {
    const child = spawn(executable, args, {
      cwd,
      env: { ...createSafeCommandEnvironment(), ...environmentOverrides },
      windowsHide: true,
      shell: false,
      stdio: ["ignore", "pipe", "pipe"]
    });

    let stdout = "";
    let stderr = "";
    let stdoutBytes = 0;
    let stderrBytes = 0;
    let stdoutTruncated = false;
    let stderrTruncated = false;
    let timedOut = false;
    let settled = false;

    const appendChunk = (chunk, streamName) => {
      const text = chunk.toString("utf8");
      const currentBytes = streamName === "stdout" ? stdoutBytes : stderrBytes;
      const remaining = Math.max(0, maxOutputBytes - currentBytes);
      const buffer = Buffer.from(text, "utf8");
      const accepted = buffer.subarray(0, remaining).toString("utf8");

      if (streamName === "stdout") {
        stdout += accepted;
        stdoutBytes += Math.min(buffer.length, remaining);
        if (buffer.length > remaining) stdoutTruncated = true;
      } else {
        stderr += accepted;
        stderrBytes += Math.min(buffer.length, remaining);
        if (buffer.length > remaining) stderrTruncated = true;
      }
    };

    child.stdout.on("data", (chunk) => appendChunk(chunk, "stdout"));
    child.stderr.on("data", (chunk) => appendChunk(chunk, "stderr"));

    const timer = setTimeout(() => {
      timedOut = true;
      if (process.platform === "win32" && child.pid) {
        const killer = spawn("taskkill.exe", ["/PID", String(child.pid), "/T", "/F"], {
          windowsHide: true,
          shell: false,
          stdio: "ignore"
        });
        killer.unref();
      } else {
        child.kill("SIGKILL");
      }
    }, timeoutMs);
    timer.unref?.();

    child.once("error", (error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      reject(error);
    });

    child.once("close", (exitCode, signal) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve({
        exitCode: exitCode ?? (timedOut ? -1 : null),
        signal,
        stdout,
        stderr,
        timedOut,
        stdoutTruncated,
        stderrTruncated
      });
    });
  });
}

export function launchFor(program, args) {
  if (process.platform === "win32" && program === "npm") {
    const npmCliPath = path.join(path.dirname(process.execPath), "node_modules", "npm", "bin", "npm-cli.js");
    return { executable: process.execPath, args: [npmCliPath, ...args] };
  }
  return { executable: program, args };
}
