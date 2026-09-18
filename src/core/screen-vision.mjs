import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { existsSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { CoreErrorCode, coreError } from "./errors.mjs";

const DEFAULT_MODEL = "locate-anything-q6_k";
const DEFAULT_MODEL_FILE = resolve("models", "locate-anything-q6_k.gguf");
const DEFAULT_RUNNER = process.platform === "win32"
  ? resolve("blocate", "examples", "cli", "locate-anything-cli.exe")
  : "locate-anything-cli";
const DEFAULT_MODE = "hybrid";
const DEFAULT_TIMEOUT_MS = 120000;
const DEFAULT_OVERLAY_HELPER = resolve(dirname(fileURLToPath(import.meta.url)), "../../scripts/desktop-overlay.ps1");

function invalid(message) {
  throw coreError(CoreErrorCode.INVALID_ARGUMENT, message);
}

function normalizeQuery(value) {
  const query = String(value || "").trim();
  if (!query || query.length > 500) invalid("query must contain 1 to 500 characters");
  return query;
}

function detectionPrompt(query) {
  const cleaned = String(query).replace(/[.。！？!?]+$/, "");
  return `Locate all the instances that matches the following description: ${cleaned}.`;
}

function optionalHwnd(value) {
  if (value === undefined || value === null || value === "") return null;
  const normalized = String(value).trim();
  if (!/^\d{1,20}$/.test(normalized)) invalid("hwnd must be a decimal window handle string");
  return normalized;
}

function boundedInteger(value, name, fallback, min, max) {
  const resolved = value === undefined || value === null ? fallback : value;
  if (!Number.isInteger(resolved) || resolved < min || resolved > max) invalid(`${name} must be an integer between ${min} and ${max}`);
  return resolved;
}

export function parseGroundingPoint(text) {
  const raw = String(text || "").trim();
  const match = raw.match(/<box>((?:<\d+>)+)<\/box>/);
  if (!match) {
    throw coreError(CoreErrorCode.PROCESS_FAILED, "LocateAnything did not return a grounding point or box", { raw: raw.slice(0, 500) });
  }
  const coordinates = [...match[1].matchAll(/<(\d+)>/g)].map((item) => Number.parseInt(item[1], 10));
  if (![2, 4].includes(coordinates.length) || coordinates.some((value) => !Number.isInteger(value) || value < 0 || value > 1000)) {
    throw coreError(CoreErrorCode.PROCESS_FAILED, "LocateAnything returned malformed 0-1000 coordinates", {
      coordinates,
      raw: raw.slice(0, 500)
    });
  }
  const x = coordinates.length === 2 ? coordinates[0] / 1000 : ((coordinates[0] + coordinates[2]) / 2) / 1000;
  const y = coordinates.length === 2 ? coordinates[1] / 1000 : ((coordinates[1] + coordinates[3]) / 2) / 1000;
  return { x, y };
}

function decodeImageDataUrl(dataUrl) {
  const match = String(dataUrl || "").match(/^data:image\/(jpeg|jpg|png);base64,(.+)$/s);
  if (!match) throw coreError(CoreErrorCode.PROCESS_FAILED, "Desktop screenshot returned an unsupported image data URL");
  return { extension: match[1] === "png" ? "png" : "jpg", bytes: Buffer.from(match[2], "base64") };
}

function parseDetectionJson(stdout) {
  const raw = String(stdout || "").trim();
  const start = raw.lastIndexOf('{"detections"');
  const candidate = start >= 0 ? raw.slice(start) : raw;
  let parsed;
  try { parsed = JSON.parse(candidate); } catch {
    throw coreError(CoreErrorCode.PROCESS_FAILED, "LocateAnything CLI did not return valid detection JSON", { raw: raw.slice(-1000) });
  }
  const detection = Array.isArray(parsed?.detections) ? parsed.detections[0] : null;
  const box = detection?.box;
  if (!Array.isArray(box) || box.length !== 4 || box.some((value) => !Number.isFinite(value))) {
    throw coreError(CoreErrorCode.PROCESS_FAILED, "LocateAnything CLI returned no usable detection box", { parsed });
  }
  return { label: String(detection.label || ""), box: box.map(Number), detections: parsed.detections };
}

function runCliProcess(runner, args, timeoutMs, env, onChild = () => {}) {
  return new Promise((resolvePromise, rejectPromise) => {
    let stdout = "";
    let stderr = "";
    let settled = false;
    const child = spawn(runner, args, { windowsHide: true, stdio: ["ignore", "pipe", "pipe"], env });
    onChild(child);
    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      try { child.kill(); } catch {}
      rejectPromise(coreError(CoreErrorCode.COMMAND_TIMEOUT, "Luna Eyes inference timed out"));
    }, timeoutMs);
    timer.unref?.();
    child.stdout?.on("data", (chunk) => { if (stdout.length < 1024 * 1024) stdout += chunk.toString(); });
    child.stderr?.on("data", (chunk) => { if (stderr.length < 1024 * 1024) stderr += chunk.toString(); });
    child.once("error", (error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      rejectPromise(coreError(CoreErrorCode.PROCESS_FAILED, `Failed to start LocateAnything CLI: ${error.message}`));
    });
    child.once("close", (code) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (code !== 0) {
        rejectPromise(coreError(CoreErrorCode.PROCESS_FAILED, `LocateAnything CLI exited with code ${code}: ${stderr.slice(-1000)}`, { stdout: stdout.slice(-1000), stderr: stderr.slice(-2000) }));
        return;
      }
      resolvePromise({ stdout, stderr });
    });
  });
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function enabledByEnvironment(name, fallback = true) {
  const value = process.env[name];
  if (value === undefined || value === null || value === "") return fallback;
  return !/^(0|false|no|off)$/i.test(String(value));
}

export class ScreenVisionOverlay {
  constructor({
    enabled = process.platform === "win32" && enabledByEnvironment(
      "LUNA_DESKTOP_OVERLAY",
      enabledByEnvironment("LUNA_EYES_OVERLAY", true)
    ),
    helperPath = process.env.LUNA_DESKTOP_OVERLAY_HELPER || process.env.LUNA_EYES_OVERLAY_HELPER || DEFAULT_OVERLAY_HELPER,
    spawnProcess = spawn,
    stateFile = join(tmpdir(), `luna-eyes-overlay-${process.pid}.json`)
  } = {}) {
    this.enabled = Boolean(enabled);
    this.helperPath = helperPath;
    this.spawnProcess = spawnProcess;
    this.stateFile = stateFile;
    this.child = null;
    this.mode = "hidden";
    this.point = null;
    this.label = "Luna Eyes";
    this.cancelPid = null;
    this.lastError = null;
    this.hideTimer = null;
  }

  status() {
    return {
      enabled: this.enabled,
      visible: Boolean(this.child && this.child.exitCode === null),
      mode: this.mode,
      helper: this.helperPath,
      cancel_pid: this.cancelPid,
      error: this.lastError
    };
  }

  writeState() {
    if (!this.enabled || !["observe", "control"].includes(this.mode)) return false;
    const payload = {
      mode: this.mode,
      point: this.point,
      label: this.label,
      cancel_pid: this.cancelPid,
      parent_pid: process.pid,
      updated_at: Date.now()
    };
    writeFileSync(this.stateFile, JSON.stringify(payload), "utf8");
    return true;
  }

  setCancelablePid(pid = null) {
    this.cancelPid = Number.isInteger(pid) && pid > 0 ? pid : null;
    try { return this.writeState(); } catch (error) {
      this.lastError = error?.message || String(error);
      return false;
    }
  }

  show(mode = "observe", point = null, label = "Luna Eyes") {
    if (!this.enabled) return false;
    if (!["observe", "control"].includes(mode)) return false;
    try {
      if (this.hideTimer) {
        clearTimeout(this.hideTimer);
        this.hideTimer = null;
      }
      this.mode = mode;
      this.point = point && Number.isFinite(point.x) && Number.isFinite(point.y)
        ? { x: Math.round(point.x), y: Math.round(point.y) }
        : null;
      this.label = String(label || "Luna Eyes").slice(0, 80);
      this.cancelPid = null;
      this.writeState();
      this.lastError = null;
      if (this.child && this.child.exitCode === null) return true;

      const child = this.spawnProcess("powershell.exe", [
        "-NoProfile",
        "-NonInteractive",
        "-STA",
        "-ExecutionPolicy", "Bypass",
        "-File", this.helperPath,
        "-StateFile", this.stateFile,
        "-ParentPid", String(process.pid)
      ], {
        windowsHide: true,
        stdio: "ignore",
        env: process.env
      });
      this.child = child;
      child.once("error", (error) => {
        this.lastError = error?.message || String(error);
        if (this.child === child) this.child = null;
      });
      child.once("exit", () => {
        if (this.child === child) this.child = null;
      });
      child.unref?.();
      return true;
    } catch (error) {
      this.lastError = error?.message || String(error);
      return false;
    }
  }

  hide(delayMs = 0) {
    const delay = Number.isFinite(delayMs) ? Math.max(0, Math.round(delayMs)) : 0;
    if (delay > 0) {
      if (this.hideTimer) clearTimeout(this.hideTimer);
      this.hideTimer = setTimeout(() => {
        this.hideTimer = null;
        this.hide();
      }, delay);
      this.hideTimer.unref?.();
      return;
    }
    if (this.hideTimer) {
      clearTimeout(this.hideTimer);
      this.hideTimer = null;
    }
    this.mode = "hidden";
    this.point = null;
    this.cancelPid = null;
    const child = this.child;
    this.child = null;
    try { child?.kill(); } catch {}
    try { rmSync(this.stateFile, { force: true }); } catch {}
  }
}

function detectionArgs({ modelFile, imagePath, prompt, mode, threads }) {
  return [
    "detect",
    "--model", modelFile,
    "--input", imagePath,
    "--prompt", prompt,
    "--mode", mode,
    "--threads", String(threads)
  ];
}

export class ScreenVisionService {
  constructor({
    desktop,
    model = process.env.LUNA_EYES_MODEL || DEFAULT_MODEL,
    timeoutMs = DEFAULT_TIMEOUT_MS,
    runner = process.env.LUNA_EYES_RUNNER || DEFAULT_RUNNER,
    modelFile = process.env.LUNA_EYES_MODEL_FILE || DEFAULT_MODEL_FILE,
    mode = process.env.LUNA_EYES_MODE || DEFAULT_MODE,
    threads = Number.parseInt(process.env.LUNA_EYES_THREADS || "0", 10),
    detect = null,
    fileExists = existsSync,
    overlay = null
  } = {}) {
    this.desktop = desktop;
    this.model = String(model || DEFAULT_MODEL).trim();
    this.timeoutMs = timeoutMs;
    this.runner = String(runner || "").trim();
    this.modelFile = String(modelFile || DEFAULT_MODEL_FILE).trim();
    this.mode = ["hybrid", "slow", "fast"].includes(String(mode)) ? String(mode) : DEFAULT_MODE;
    this.threads = Number.isInteger(threads) && threads >= 0 ? threads : 0;
    this.detect = typeof detect === "function" ? detect : null;
    this.fileExists = fileExists;
    this.overlay = overlay || new ScreenVisionOverlay();
    this.child = null;
  }

  async status() {
    const runnerReady = Boolean(this.detect) || this.fileExists(this.runner);
    const modelReady = Boolean(this.detect) || this.fileExists(this.modelFile);
    const structured = {
      available: runnerReady && modelReady,
      running: Boolean(this.child && this.child.exitCode === null),
      backend: "locate-anything.cpp-cli",
      model: this.model,
      model_file: this.modelFile,
      runner: this.runner,
      mode: this.mode,
      threads: this.threads,
      overlay: this.overlay.status(),
      runner_ready: runnerReady,
      model_ready: modelReady
    };
    return { text: JSON.stringify(structured, null, 2), structured, details: { available: structured.available } };
  }

  async ensureAvailable() {
    if (this.detect) return;
    if (!this.fileExists(this.runner)) throw coreError(CoreErrorCode.TOOL_DISABLED, `Luna Eyes runner is missing: ${this.runner}`);
    if (!this.fileExists(this.modelFile)) throw coreError(CoreErrorCode.TOOL_DISABLED, `Luna Eyes model is missing: ${this.modelFile}`);
  }

  async release() {
    const child = this.child;
    if (!child || child.exitCode !== null) {
      const structured = { released: false, reason: "no LocateAnything CLI process is active" };
      return { text: JSON.stringify(structured), structured, details: structured };
    }
    const pid = child.pid;
    child.kill();
    this.child = null;
    const structured = { released: true, pid };
    return { text: JSON.stringify(structured), structured, details: structured };
  }

  async find(request = {}, { retainOverlay = false } = {}) {
    const query = normalizeQuery(request.query);
    const hwnd = optionalHwnd(request.hwnd);
    const maxWidth = boundedInteger(request.max_width, "max_width", 1344, 640, 2560);
    const quality = boundedInteger(request.quality, "quality", 78, 40, 90);

    await this.ensureAvailable();

    const capture = await this.desktop.execute({ operation: "screenshot", hwnd, max_width: maxWidth, quality }, { activityOverlay: false });
    const image = capture.structured;
    if (!image?.data_url || !Number.isFinite(image.source_x) || !Number.isFinite(image.source_y)) {
      throw coreError(CoreErrorCode.PROCESS_FAILED, "Desktop screenshot did not include the data required for visual grounding");
    }

    let success = false;
    let tempPath = null;
    this.overlay.show("observe", null, this.model);
    try {
      const encoded = decodeImageDataUrl(image.data_url);
      tempPath = join(tmpdir(), `luna-eyes-${process.pid}-${randomUUID()}.${encoded.extension}`);
      writeFileSync(tempPath, encoded.bytes);
      const prompt = detectionPrompt(query);
      const detectionResult = this.detect
        ? await this.detect({ imagePath: tempPath, prompt, mode: this.mode, threads: this.threads, image })
        : await runCliProcess(this.runner, detectionArgs({
          modelFile: this.modelFile,
          imagePath: tempPath,
          prompt,
          mode: this.mode,
          threads: this.threads
        }), this.timeoutMs, process.env, (child) => {
          this.child = child;
          this.overlay.setCancelablePid?.(child.pid);
          child.once("exit", () => { if (this.child === child) this.child = null; });
        });
      const raw = typeof detectionResult === "string" ? detectionResult : detectionResult?.stdout ?? JSON.stringify(detectionResult);
      const detection = detectionResult?.detections
        ? parseDetectionJson(JSON.stringify(detectionResult))
        : parseDetectionJson(raw);
      const [x1, y1, x2, y2] = detection.box;
      const normalized = {
        x: Math.max(0, Math.min(1, ((x1 + x2) / 2) / image.width)),
        y: Math.max(0, Math.min(1, ((y1 + y2) / 2) / image.height))
      };
      const sourceWidth = Number.isFinite(image.source_width) ? image.source_width : image.width;
      const sourceHeight = Number.isFinite(image.source_height) ? image.source_height : image.height;
      const screen = {
        x: Math.round(image.source_x + normalized.x * sourceWidth),
        y: Math.round(image.source_y + normalized.y * sourceHeight)
      };
      const screenBox = {
        x1: Math.round(image.source_x + (x1 / image.width) * sourceWidth),
        y1: Math.round(image.source_y + (y1 / image.height) * sourceHeight),
        x2: Math.round(image.source_x + (x2 / image.width) * sourceWidth),
        y2: Math.round(image.source_y + (y2 / image.height) * sourceHeight)
      };
      const structured = {
        query,
        point: normalized,
        screen,
        box: detection.box,
        screen_box: screenBox,
        label: detection.label,
        detections: detection.detections,
        capture: {
          hwnd,
          width: image.width,
          height: image.height,
          source_x: image.source_x,
          source_y: image.source_y,
          source_width: sourceWidth,
          source_height: sourceHeight
        },
        model: this.model,
        backend: "locate-anything.cpp-cli",
        mode: this.mode,
        raw: String(raw).slice(0, 500)
      };
      success = true;
      return {
        text: `${query} -> normalized [${normalized.x.toFixed(4)}, ${normalized.y.toFixed(4)}], screen (${screen.x}, ${screen.y})`,
        structured,
        details: { operation: "find", model: this.model, query }
      };
    } finally {
      if (tempPath) {
        try { rmSync(tempPath, { force: true }); } catch {}
      }
      if (!retainOverlay || !success) this.overlay.hide();
    }
  }

  async click(request = {}) {
    const button = String(request.button || "left").toLowerCase();
    if (!["left", "right", "middle"].includes(button)) invalid("button must be left, right, or middle");
    try {
      const found = await this.find(request, { retainOverlay: true });
      this.overlay.show("control", found.structured.screen, this.model);
      const clicked = await this.desktop.execute(
        { operation: "click", x: found.structured.screen.x, y: found.structured.screen.y, button },
        { activityOverlay: false }
      );
      await sleep(300);
      const structured = { ...found.structured, clicked: true, button, desktop: clicked.structured };
      return {
        text: `Located and clicked \"${found.structured.query}\" at (${found.structured.screen.x}, ${found.structured.screen.y}).`,
        structured,
        details: { operation: "click", model: this.model, query: found.structured.query }
      };
    } finally {
      this.overlay.hide();
    }
  }
}
