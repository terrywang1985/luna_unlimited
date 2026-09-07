import path from "node:path";
import { fileURLToPath } from "node:url";

import { CoreErrorCode, coreError } from "./errors.mjs";
import { runCapturedProcess } from "./process.mjs";

const DEFAULT_HELPER = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../scripts/desktop-host.ps1");
const DESKTOP_OUTPUT_LIMIT = 10 * 1024 * 1024;

function invalid(message) {
  throw coreError(CoreErrorCode.INVALID_ARGUMENT, message);
}

function finiteInteger(value, name, min = -100000, max = 100000) {
  if (!Number.isInteger(value) || value < min || value > max) invalid(`${name} must be an integer between ${min} and ${max}`);
  return value;
}

function optionalHwnd(value) {
  if (value === undefined || value === null || value === "") return null;
  const normalized = String(value).trim();
  if (!/^\d{1,20}$/.test(normalized)) invalid("hwnd must be a decimal window handle string");
  return normalized;
}

function normalizeButton(value = "left") {
  const button = String(value).toLowerCase();
  if (!["left", "right", "middle"].includes(button)) invalid("button must be left, right, or middle");
  return button;
}

function normalizeRequest(request = {}) {
  const operation = String(request.operation || "").trim();
  switch (operation) {
    case "windows":
      return { operation };
    case "screenshot":
      return {
        operation,
        hwnd: optionalHwnd(request.hwnd),
        max_width: finiteInteger(request.max_width ?? 1600, "max_width", 640, 2560),
        quality: finiteInteger(request.quality ?? 70, "quality", 40, 90)
      };
    case "focus":
      return { operation, hwnd: optionalHwnd(request.hwnd) ?? invalid("hwnd is required") };
    case "move":
      return { operation, x: finiteInteger(request.x, "x"), y: finiteInteger(request.y, "y") };
    case "click":
    case "double_click":
      return {
        operation,
        x: finiteInteger(request.x, "x"),
        y: finiteInteger(request.y, "y"),
        button: normalizeButton(request.button)
      };
    case "drag":
      return {
        operation,
        from_x: finiteInteger(request.from_x, "from_x"),
        from_y: finiteInteger(request.from_y, "from_y"),
        to_x: finiteInteger(request.to_x, "to_x"),
        to_y: finiteInteger(request.to_y, "to_y"),
        button: normalizeButton(request.button),
        duration_ms: finiteInteger(request.duration_ms ?? 500, "duration_ms", 50, 5000)
      };
    case "scroll":
      return {
        operation,
        delta: finiteInteger(request.delta, "delta", -12000, 12000),
        x: request.x === undefined ? null : finiteInteger(request.x, "x"),
        y: request.y === undefined ? null : finiteInteger(request.y, "y")
      };
    case "type": {
      const text = String(request.text ?? "");
      if (!text || text.length > 10000) invalid("text must contain 1 to 10000 characters");
      return { operation, text };
    }
    case "key": {
      const key = String(request.key || "").trim();
      if (!key || key.length > 120 || !/^[A-Za-z0-9+_-]+$/.test(key)) invalid("key must be a key or + separated key chord such as CTRL+SHIFT+S");
      return { operation, key };
    }
    default:
      invalid("unsupported desktop operation");
  }
}

export class DesktopService {
  constructor({ enabled = false, helperPath = DEFAULT_HELPER, maxOutputBytes = DESKTOP_OUTPUT_LIMIT } = {}) {
    this.enabled = Boolean(enabled && process.platform === "win32");
    this.helperPath = helperPath;
    this.maxOutputBytes = Math.max(DESKTOP_OUTPUT_LIMIT, maxOutputBytes || 0);
  }

  async execute(request) {
    if (!this.enabled) {
      throw coreError(CoreErrorCode.TOOL_DISABLED, "Desktop control is disabled. On Windows restart Luna Unlimited with -EnableDesktop.");
    }
    if (process.platform !== "win32") {
      throw coreError(CoreErrorCode.COMMAND_NOT_ALLOWED, "Desktop control is currently supported only on Windows.");
    }

    const payload = normalizeRequest(request);
    const encoded = Buffer.from(JSON.stringify(payload), "utf8").toString("base64");
    const output = await runCapturedProcess("powershell.exe", [
      "-NoProfile",
      "-NonInteractive",
      "-ExecutionPolicy", "Bypass",
      "-File", this.helperPath,
      "-PayloadBase64", encoded
    ], {
      cwd: path.dirname(this.helperPath),
      timeoutMs: payload.operation === "screenshot" ? 20000 : 10000,
      maxOutputBytes: this.maxOutputBytes
    });

    if (output.timedOut) throw coreError(CoreErrorCode.COMMAND_TIMEOUT, `desktop.${payload.operation} timed out`);
    if (output.exitCode !== 0) {
      throw coreError(CoreErrorCode.PROCESS_FAILED, output.stderr.trim() || `desktop.${payload.operation} failed`, {
        exitCode: output.exitCode
      });
    }
    if (output.stdoutTruncated) {
      throw coreError(CoreErrorCode.OPERATION_LIMIT_EXCEEDED, "Desktop result exceeded the safe transport size limit");
    }

    let structured;
    try {
      structured = JSON.parse(output.stdout.trim());
    } catch {
      throw coreError(CoreErrorCode.PROCESS_FAILED, "Desktop helper returned invalid JSON");
    }
    if (structured?.ok === false) {
      throw coreError(CoreErrorCode.PROCESS_FAILED, structured.error || `desktop.${payload.operation} failed`);
    }

    const summary = payload.operation === "screenshot"
      ? `Captured desktop screenshot (${structured.width}x${structured.height}, ${structured.mime_type}).`
      : JSON.stringify(structured, null, 2);
    return {
      text: summary,
      structured,
      details: {
        operation: payload.operation,
        screenshotBytes: payload.operation === "screenshot" ? Math.round((structured.data_url?.length || 0) * 0.75) : 0
      }
    };
  }
}

export { normalizeRequest as normalizeDesktopRequest };
