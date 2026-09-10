import { spawn } from "node:child_process";
import { rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { CoreErrorCode, coreError } from "./errors.mjs";

const DEFAULT_ENDPOINT = "http://127.0.0.1:18880/v1/chat/completions";
const DEFAULT_MODEL = "showui-2b";
const DEFAULT_MODEL_FILE = resolve("models", "showui-2b-q4_k_m.gguf");
const DEFAULT_MMPROJ_FILE = resolve("models", "mmproj-qwen2vl-2b-q8_0.gguf");
const DEFAULT_DEVICE = "Vulkan1";
const DEFAULT_TIMEOUT_MS = 45000;
const DEFAULT_START_TIMEOUT_MS = 180000;
const DEFAULT_IDLE_MS = 120000;
const DEFAULT_OVERLAY_HELPER = resolve(dirname(fileURLToPath(import.meta.url)), "../../scripts/desktop-overlay.ps1");
const GROUNDING_SYSTEM = "Based on the screenshot of the page, I give a text description and you give its corresponding location. The coordinate represents a clickable location [x, y] for an element, which is a relative coordinate on the screenshot, scaled from 0 to 1.";

function invalid(message) {
  throw coreError(CoreErrorCode.INVALID_ARGUMENT, message);
}

function normalizeQuery(value) {
  const query = String(value || "").trim();
  if (!query || query.length > 500) invalid("query must contain 1 to 500 characters");
  return query;
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
  const match = raw.match(/[\[(]\s*(-?(?:\d+(?:\.\d+)?|\.\d+))\s*,\s*(-?(?:\d+(?:\.\d+)?|\.\d+))\s*[\])]/);
  if (!match) {
    throw coreError(CoreErrorCode.PROCESS_FAILED, "Luna Eyes model did not return a [x, y] grounding point", { raw: raw.slice(0, 500) });
  }
  const x = Number.parseFloat(match[1]);
  const y = Number.parseFloat(match[2]);
  if (!Number.isFinite(x) || !Number.isFinite(y) || x < 0 || x > 1 || y < 0 || y > 1) {
    throw coreError(CoreErrorCode.PROCESS_FAILED, "Luna Eyes returned an out-of-range grounding point", { x, y, raw: raw.slice(0, 500) });
  }
  return { x, y };
}

function modelsEndpoint(endpoint) {
  try {
    const url = new URL(endpoint);
    url.pathname = url.pathname.replace(/\/chat\/completions\/?$/, "/models");
    url.search = "";
    return url.toString();
  } catch {
    return null;
  }
}

async function fetchJson(url, init, timeoutMs) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch(url, { ...init, signal: controller.signal });
    const text = await response.text();
    let json = null;
    try { json = text ? JSON.parse(text) : null; } catch {}
    if (!response.ok) {
      throw coreError(CoreErrorCode.PROCESS_FAILED, `Luna Eyes endpoint returned HTTP ${response.status}: ${text.slice(0, 500)}`, {
        status: response.status,
        body: text.slice(0, 1000)
      });
    }
    return json;
  } catch (error) {
    if (error?.name === "AbortError") throw coreError(CoreErrorCode.COMMAND_TIMEOUT, "Luna Eyes inference timed out");
    if (error?.code) throw error;
    throw coreError(CoreErrorCode.PROCESS_FAILED, `Luna Eyes endpoint is unavailable: ${error?.message || error}`);
  } finally {
    clearTimeout(timer);
  }
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
    enabled = process.platform === "win32" && enabledByEnvironment("LUNA_EYES_OVERLAY", true),
    helperPath = process.env.LUNA_EYES_OVERLAY_HELPER || DEFAULT_OVERLAY_HELPER,
    spawnProcess = spawn,
    stateFile = join(tmpdir(), `luna-eyes-overlay-${process.pid}.json`)
  } = {}) {
    this.enabled = Boolean(enabled);
    this.helperPath = helperPath;
    this.spawnProcess = spawnProcess;
    this.stateFile = stateFile;
    this.child = null;
    this.mode = "hidden";
    this.lastError = null;
  }

  status() {
    return {
      enabled: this.enabled,
      visible: Boolean(this.child && this.child.exitCode === null),
      mode: this.mode,
      helper: this.helperPath,
      error: this.lastError
    };
  }

  show(mode = "observe", point = null, label = "Luna Eyes") {
    if (!this.enabled) return false;
    if (!["observe", "control"].includes(mode)) return false;
    try {
      const payload = {
        mode,
        point: point && Number.isFinite(point.x) && Number.isFinite(point.y)
          ? { x: Math.round(point.x), y: Math.round(point.y) }
          : null,
        label: String(label || "Luna Eyes").slice(0, 80),
        parent_pid: process.pid,
        updated_at: Date.now()
      };
      writeFileSync(this.stateFile, JSON.stringify(payload), "utf8");
      this.mode = mode;
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

  hide() {
    this.mode = "hidden";
    const child = this.child;
    this.child = null;
    try { child?.kill(); } catch {}
    try { rmSync(this.stateFile, { force: true }); } catch {}
  }
}

function runnerArgs(endpoint, { modelFile, mmprojFile, device, alias }) {
  const url = new URL(endpoint);
  return [
    "-m", modelFile,
    "--mmproj", mmprojFile,
    "--mmproj-offload",
    "--device", device,
    "--alias", alias,
    "--host", url.hostname,
    "--port", url.port || "18880",
    "-c", "4096",
    "-ngl", "99",
    "--parallel", "1",
    "--cache-ram", "0"
  ];
}

export class ScreenVisionService {
  constructor({
    desktop,
    endpoint = process.env.LUNA_EYES_ENDPOINT || DEFAULT_ENDPOINT,
    model = process.env.LUNA_EYES_MODEL || DEFAULT_MODEL,
    timeoutMs = DEFAULT_TIMEOUT_MS,
    startTimeoutMs = DEFAULT_START_TIMEOUT_MS,
    idleMs = Number.parseInt(process.env.LUNA_EYES_IDLE_MS || String(DEFAULT_IDLE_MS), 10),
    managed = !/^(0|false|no|off)$/i.test(String(process.env.LUNA_EYES_MANAGED || "true")),
    runner = process.env.LUNA_EYES_RUNNER || (process.platform === "win32" ? resolve("bvk", "bin", "llama-server.exe") : "llama-server"),
    modelFile = process.env.LUNA_EYES_MODEL_FILE || DEFAULT_MODEL_FILE,
    mmprojFile = process.env.LUNA_EYES_MMPROJ_FILE || DEFAULT_MMPROJ_FILE,
    device = process.env.LUNA_EYES_DEVICE || DEFAULT_DEVICE,
    overlay = null
  } = {}) {
    this.desktop = desktop;
    this.endpoint = String(endpoint || DEFAULT_ENDPOINT).trim();
    this.model = String(model || DEFAULT_MODEL).trim();
    this.timeoutMs = timeoutMs;
    this.startTimeoutMs = startTimeoutMs;
    this.idleMs = Number.isInteger(idleMs) && idleMs >= 10000 ? idleMs : DEFAULT_IDLE_MS;
    this.managed = Boolean(managed);
    this.runner = String(runner || "").trim();
    this.modelFile = String(modelFile || DEFAULT_MODEL_FILE).trim();
    this.mmprojFile = String(mmprojFile || DEFAULT_MMPROJ_FILE).trim();
    this.device = String(device || DEFAULT_DEVICE).trim();
    this.overlay = overlay || new ScreenVisionOverlay();
    this.child = null;
    this.starting = null;
    this.idleTimer = null;
  }

  async status() {
    const endpoint = modelsEndpoint(this.endpoint);
    if (!endpoint) {
      const structured = { available: false, running: false, managed: this.managed, endpoint: this.endpoint, model: this.model, error: "invalid endpoint" };
      return { text: JSON.stringify(structured, null, 2), structured, details: structured };
    }
    try {
      const models = await fetchJson(endpoint, { method: "GET", headers: { Accept: "application/json" } }, 1500);
      const structured = {
        available: true,
        running: true,
        owned: Boolean(this.child && this.child.exitCode === null),
        managed: this.managed,
        idle_ms: this.idleMs,
        endpoint: this.endpoint,
        model: this.model,
        model_file: this.modelFile,
        mmproj_file: this.mmprojFile,
        device: this.device,
        overlay: this.overlay.status(),
        models: Array.isArray(models?.data) ? models.data.map((item) => ({ id: item?.id, capabilities: item?.capabilities })).slice(0, 20) : []
      };
      return { text: JSON.stringify(structured, null, 2), structured, details: { available: true } };
    } catch (error) {
      const structured = {
        available: false,
        running: false,
        owned: Boolean(this.child && this.child.exitCode === null),
        managed: this.managed,
        idle_ms: this.idleMs,
        endpoint: this.endpoint,
        model: this.model,
        model_file: this.modelFile,
        mmproj_file: this.mmprojFile,
        device: this.device,
        overlay: this.overlay.status(),
        error: error?.message || String(error)
      };
      return { text: JSON.stringify(structured, null, 2), structured, details: { available: false } };
    }
  }

  scheduleIdleRelease() {
    if (!this.child || this.child.exitCode !== null) return;
    if (this.idleTimer) clearTimeout(this.idleTimer);
    this.idleTimer = setTimeout(() => {
      this.release().catch(() => {});
    }, this.idleMs);
    this.idleTimer.unref?.();
  }

  async ensureAvailable() {
    const health = modelsEndpoint(this.endpoint);
    if (!health) throw coreError(CoreErrorCode.INVALID_ARGUMENT, "Luna Eyes endpoint is invalid");
    try {
      await fetchJson(health, { method: "GET", headers: { Accept: "application/json" } }, 1000);
      this.scheduleIdleRelease();
      return;
    } catch {}

    if (!this.managed) {
      throw coreError(CoreErrorCode.TOOL_DISABLED, "Luna Eyes is not running and managed on-demand startup is disabled");
    }
    if (this.starting) return this.starting;

    this.starting = (async () => {
      let spawnError = null;
      const child = spawn(this.runner, runnerArgs(this.endpoint, {
        modelFile: this.modelFile,
        mmprojFile: this.mmprojFile,
        device: this.device,
        alias: this.model
      }), {
        windowsHide: true,
        stdio: "ignore",
        env: process.env
      });
      this.child = child;
      child.once("error", (error) => { spawnError = error; });
      child.once("exit", () => {
        if (this.child === child) this.child = null;
      });

      const deadline = Date.now() + this.startTimeoutMs;
      while (Date.now() < deadline) {
        if (spawnError) {
          throw coreError(CoreErrorCode.PROCESS_FAILED, `Failed to start Luna Eyes runner: ${spawnError.message}`);
        }
        if (child.exitCode !== null) {
          throw coreError(CoreErrorCode.PROCESS_FAILED, `Luna Eyes runner exited during startup with code ${child.exitCode}`);
        }
        try {
          await fetchJson(health, { method: "GET", headers: { Accept: "application/json" } }, 1000);
          this.scheduleIdleRelease();
          return;
        } catch {}
        await sleep(500);
      }
      child.kill();
      throw coreError(CoreErrorCode.COMMAND_TIMEOUT, "Luna Eyes runner did not become ready in time");
    })();

    try {
      await this.starting;
    } finally {
      this.starting = null;
    }
  }

  async release() {
    if (this.idleTimer) {
      clearTimeout(this.idleTimer);
      this.idleTimer = null;
    }
    const child = this.child;
    if (!child || child.exitCode !== null) {
      const structured = { released: false, reason: "no managed Luna Eyes runner is active" };
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

    const capture = await this.desktop.execute({ operation: "screenshot", hwnd, max_width: maxWidth, quality });
    const image = capture.structured;
    if (!image?.data_url || !Number.isFinite(image.source_x) || !Number.isFinite(image.source_y)) {
      throw coreError(CoreErrorCode.PROCESS_FAILED, "Desktop screenshot did not include the data required for visual grounding");
    }

    let success = false;
    this.overlay.show("observe", null, this.model);
    try {
      const payload = {
        model: this.model,
        temperature: 0,
        max_tokens: 64,
        messages: [{
          role: "user",
          content: [
            { type: "text", text: GROUNDING_SYSTEM },
            { type: "image_url", image_url: { url: image.data_url } },
            { type: "text", text: query }
          ]
        }]
      };
      const response = await fetchJson(this.endpoint, {
        method: "POST",
        headers: { "Content-Type": "application/json", Accept: "application/json" },
        body: JSON.stringify(payload)
      }, this.timeoutMs);
      this.scheduleIdleRelease();
      const raw = response?.choices?.[0]?.message?.content ?? response?.choices?.[0]?.text ?? "";
      const normalized = parseGroundingPoint(raw);
      const sourceWidth = Number.isFinite(image.source_width) ? image.source_width : image.width;
      const sourceHeight = Number.isFinite(image.source_height) ? image.source_height : image.height;
      const screen = {
        x: Math.round(image.source_x + normalized.x * sourceWidth),
        y: Math.round(image.source_y + normalized.y * sourceHeight)
      };
      const structured = {
        query,
        point: normalized,
        screen,
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
        raw: String(raw).slice(0, 500)
      };
      success = true;
      return {
        text: `${query} -> normalized [${normalized.x.toFixed(4)}, ${normalized.y.toFixed(4)}], screen (${screen.x}, ${screen.y})`,
        structured,
        details: { operation: "find", model: this.model, query }
      };
    } finally {
      if (!retainOverlay || !success) this.overlay.hide();
    }
  }

  async click(request = {}) {
    const button = String(request.button || "left").toLowerCase();
    if (!["left", "right", "middle"].includes(button)) invalid("button must be left, right, or middle");
    try {
      const found = await this.find(request, { retainOverlay: true });
      this.overlay.show("control", found.structured.screen, this.model);
      const clicked = await this.desktop.execute({ operation: "click", x: found.structured.screen.x, y: found.structured.screen.y, button });
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
