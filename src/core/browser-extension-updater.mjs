import os from "node:os";
import path from "node:path";
import { createHash } from "node:crypto";
import { cp, mkdir, readFile, readdir, rename, rm, stat, writeFile } from "node:fs/promises";
import { inflateRawSync } from "node:zlib";

import { CoreErrorCode, coreError } from "./errors.mjs";

const MAX_PACKAGE_BYTES = 8 * 1024 * 1024;
const LUNA_BROWSER_NAME = "Luna Browser";

function sha256(buffer) {
  return createHash("sha256").update(buffer).digest("hex");
}

async function exists(target) {
  try { await stat(target); return true; } catch (error) { if (error?.code === "ENOENT") return false; throw error; }
}

function safeZipPath(name) {
  const normalized = String(name || "").replaceAll("\\", "/");
  if (!normalized || normalized.startsWith("/") || /^[A-Za-z]:/.test(normalized)) return null;
  const parts = normalized.split("/").filter(Boolean);
  if (parts.some((part) => part === "." || part === "..")) return null;
  return parts.join("/");
}

function findEocd(buffer) {
  const signature = 0x06054b50;
  const start = Math.max(0, buffer.length - 65557);
  for (let offset = buffer.length - 22; offset >= start; offset -= 1) {
    if (buffer.readUInt32LE(offset) === signature) return offset;
  }
  return -1;
}

export function readZipEntries(buffer) {
  if (!Buffer.isBuffer(buffer) || buffer.length < 22) throw coreError(CoreErrorCode.ARTIFACT_INVALID, "Extension package is not a valid ZIP file");
  const eocd = findEocd(buffer);
  if (eocd < 0) throw coreError(CoreErrorCode.ARTIFACT_INVALID, "Extension ZIP central directory is missing");
  const entryCount = buffer.readUInt16LE(eocd + 10);
  const centralOffset = buffer.readUInt32LE(eocd + 16);
  const entries = [];
  let cursor = centralOffset;
  for (let index = 0; index < entryCount; index += 1) {
    if (cursor + 46 > buffer.length || buffer.readUInt32LE(cursor) !== 0x02014b50) {
      throw coreError(CoreErrorCode.ARTIFACT_INVALID, "Extension ZIP central directory is malformed");
    }
    const flags = buffer.readUInt16LE(cursor + 8);
    const method = buffer.readUInt16LE(cursor + 10);
    const compressedSize = buffer.readUInt32LE(cursor + 20);
    const uncompressedSize = buffer.readUInt32LE(cursor + 24);
    const nameLength = buffer.readUInt16LE(cursor + 28);
    const extraLength = buffer.readUInt16LE(cursor + 30);
    const commentLength = buffer.readUInt16LE(cursor + 32);
    const localOffset = buffer.readUInt32LE(cursor + 42);
    const rawName = buffer.toString("utf8", cursor + 46, cursor + 46 + nameLength);
    cursor += 46 + nameLength + extraLength + commentLength;
    if (flags & 0x1) throw coreError(CoreErrorCode.ARTIFACT_INVALID, "Encrypted extension ZIP entries are not supported");
    if (![0, 8].includes(method)) throw coreError(CoreErrorCode.ARTIFACT_INVALID, `Unsupported ZIP compression method ${method}`);
    const relativePath = safeZipPath(rawName);
    if (!relativePath) throw coreError(CoreErrorCode.ARTIFACT_INVALID, `Unsafe ZIP entry path: ${rawName}`);
    if (rawName.endsWith("/")) {
      entries.push({ path: relativePath, directory: true, data: Buffer.alloc(0) });
      continue;
    }
    if (localOffset + 30 > buffer.length || buffer.readUInt32LE(localOffset) !== 0x04034b50) {
      throw coreError(CoreErrorCode.ARTIFACT_INVALID, `ZIP local header is missing for ${rawName}`);
    }
    const localNameLength = buffer.readUInt16LE(localOffset + 26);
    const localExtraLength = buffer.readUInt16LE(localOffset + 28);
    const dataOffset = localOffset + 30 + localNameLength + localExtraLength;
    const compressed = buffer.subarray(dataOffset, dataOffset + compressedSize);
    const data = method === 0 ? Buffer.from(compressed) : inflateRawSync(compressed);
    if (data.length !== uncompressedSize) throw coreError(CoreErrorCode.ARTIFACT_INVALID, `ZIP size mismatch for ${rawName}`);
    entries.push({ path: relativePath, directory: false, data });
  }
  return entries;
}

async function writeZipEntries(root, entries) {
  for (const entry of entries) {
    const target = path.join(root, ...entry.path.split("/"));
    const relative = path.relative(root, target);
    if (relative.startsWith("..") || path.isAbsolute(relative)) throw coreError(CoreErrorCode.ARTIFACT_INVALID, "ZIP path escaped staging root");
    if (entry.directory) {
      await mkdir(target, { recursive: true });
      continue;
    }
    await mkdir(path.dirname(target), { recursive: true });
    await writeFile(target, entry.data, { flag: "wx" });
  }
}

async function readManifest(directory) {
  try {
    return JSON.parse(await readFile(path.join(directory, "manifest.json"), "utf8"));
  } catch {
    return null;
  }
}

function knownBrowserRoots(localAppData) {
  if (!localAppData) return [];
  return [
    { browser: "chrome", root: path.join(localAppData, "Google", "Chrome", "User Data") },
    { browser: "chrome-beta", root: path.join(localAppData, "Google", "Chrome Beta", "User Data") },
    { browser: "edge", root: path.join(localAppData, "Microsoft", "Edge", "User Data") }
  ];
}

async function profileDirectories(userDataRoot) {
  if (!await exists(userDataRoot)) return [];
  const names = await readdir(userDataRoot, { withFileTypes: true });
  return names
    .filter((entry) => entry.isDirectory() && (entry.name === "Default" || entry.name.startsWith("Profile ")))
    .map((entry) => path.join(userDataRoot, entry.name));
}

export class BrowserExtensionUpdateService {
  constructor({ runtimeIdentity = {}, maxPackageBytes = MAX_PACKAGE_BYTES, localAppData = process.env.LOCALAPPDATA, updateRoot = null, browserRoots = null } = {}) {
    this.runtimeIdentity = runtimeIdentity;
    this.maxPackageBytes = Math.min(maxPackageBytes, MAX_PACKAGE_BYTES);
    this.localAppData = localAppData || null;
    this.updateRoot = updateRoot || path.join(this.localAppData || os.tmpdir(), "Luna", "browser-extension-updates");
    this.browserRoots = browserRoots || knownBrowserRoots(this.localAppData);
  }

  async discover() {
    const found = [];
    const explicit = process.env.LUNA_BROWSER_EXTENSION_DIR;
    if (explicit) {
      const manifest = await readManifest(explicit);
      if (manifest?.name === LUNA_BROWSER_NAME) found.push({ browser: "configured", profile: null, extensionId: null, path: path.resolve(explicit), version: String(manifest.version || "") });
    }
    for (const candidate of this.browserRoots) {
      for (const profile of await profileDirectories(candidate.root)) {
        const prefsPath = path.join(profile, "Preferences");
        if (!await exists(prefsPath)) continue;
        let prefs;
        try { prefs = JSON.parse(await readFile(prefsPath, "utf8")); } catch { continue; }
        const settings = prefs?.extensions?.settings;
        if (!settings || typeof settings !== "object") continue;
        for (const [extensionId, setting] of Object.entries(settings)) {
          if (setting?.manifest?.name !== LUNA_BROWSER_NAME || typeof setting?.path !== "string" || !setting.path) continue;
          const installPath = path.isAbsolute(setting.path) ? setting.path : path.resolve(profile, setting.path);
          const manifest = await readManifest(installPath);
          if (manifest?.name !== LUNA_BROWSER_NAME) continue;
          found.push({ browser: candidate.browser, profile: path.basename(profile), extensionId, path: installPath, version: String(manifest.version || setting.manifest.version || "") });
        }
      }
    }
    const deduped = [];
    const seen = new Set();
    for (const item of found) {
      const key = path.resolve(item.path).toLocaleLowerCase();
      if (seen.has(key)) continue;
      seen.add(key);
      deduped.push(item);
    }
    return deduped;
  }

  async status() {
    const installs = await this.discover();
    let pending = null;
    try { pending = JSON.parse(await readFile(path.join(this.updateRoot, "pending.json"), "utf8")); } catch {}
    const result = { platform: this.runtimeIdentity.platform || process.platform, installs, pending };
    return { text: JSON.stringify(result, null, 2), structured: result, details: { installCount: installs.length, pending: Boolean(pending) } };
  }

  async stage({ packageBase64, expectedSha256, version }) {
    if (typeof packageBase64 !== "string" || packageBase64.length < 4) throw coreError(CoreErrorCode.INVALID_ARGUMENT, "package_base64 is required");
    if (!/^[a-f0-9]{64}$/i.test(String(expectedSha256 || ""))) throw coreError(CoreErrorCode.INVALID_ARGUMENT, "expected_sha256 must be a SHA-256 digest");
    if (!/^\d+(?:\.\d+){0,3}$/.test(String(version || ""))) throw coreError(CoreErrorCode.INVALID_ARGUMENT, "version must be a numeric Chrome extension version");
    const buffer = Buffer.from(packageBase64, "base64");
    if (!buffer.length || buffer.length > this.maxPackageBytes) throw coreError(CoreErrorCode.FILE_TOO_LARGE, `Extension package must be between 1 and ${this.maxPackageBytes} bytes`);
    const actualSha256 = sha256(buffer);
    if (actualSha256 !== expectedSha256.toLocaleLowerCase()) throw coreError(CoreErrorCode.FILE_CHANGED, "Extension package SHA-256 mismatch", { expectedSha256, actualSha256 });

    const entries = readZipEntries(buffer);
    const manifestEntry = entries.find((entry) => entry.path === "manifest.json" && !entry.directory);
    if (!manifestEntry) throw coreError(CoreErrorCode.ARTIFACT_INVALID, "Extension package does not contain manifest.json");
    let manifest;
    try { manifest = JSON.parse(manifestEntry.data.toString("utf8")); } catch { throw coreError(CoreErrorCode.ARTIFACT_INVALID, "Extension manifest.json is invalid JSON"); }
    if (manifest?.manifest_version !== 3 || manifest?.name !== LUNA_BROWSER_NAME || String(manifest?.version || "") !== version) {
      throw coreError(CoreErrorCode.ARTIFACT_INVALID, "Extension package identity/version does not match Luna Browser", { name: manifest?.name, manifestVersion: manifest?.manifest_version, packageVersion: manifest?.version, requestedVersion: version });
    }

    await mkdir(this.updateRoot, { recursive: true });
    const stageId = `${version}-${actualSha256.slice(0, 12)}`;
    const finalDir = path.join(this.updateRoot, "staged", stageId);
    const tempDir = `${finalDir}.tmp-${process.pid}-${Date.now()}`;
    await rm(tempDir, { recursive: true, force: true });
    await mkdir(tempDir, { recursive: true });
    try {
      await writeZipEntries(tempDir, entries);
      await mkdir(path.dirname(finalDir), { recursive: true });
      await rm(finalDir, { recursive: true, force: true });
      await rename(tempDir, finalDir);
    } catch (error) {
      await rm(tempDir, { recursive: true, force: true }).catch(() => {});
      throw error;
    }
    const metadata = { stageId, version, sha256: actualSha256, bytes: buffer.length, stagedPath: finalDir, stagedAt: new Date().toISOString() };
    await writeFile(path.join(finalDir, ".luna-update.json"), JSON.stringify(metadata, null, 2));
    return { text: JSON.stringify(metadata, null, 2), structured: metadata, details: metadata };
  }

  async activate({ version, sha256: expectedSha256, extensionId = null }) {
    const stageId = `${version}-${String(expectedSha256 || "").slice(0, 12)}`;
    const stagedPath = path.join(this.updateRoot, "staged", stageId);
    if (!await exists(stagedPath)) throw coreError(CoreErrorCode.PATH_NOT_FOUND, `Staged extension package not found for ${version}`);
    const stagedManifest = await readManifest(stagedPath);
    if (stagedManifest?.name !== LUNA_BROWSER_NAME || String(stagedManifest.version || "") !== String(version)) throw coreError(CoreErrorCode.ARTIFACT_INVALID, "Staged extension identity/version is invalid");

    let installs = await this.discover();
    if (extensionId) installs = installs.filter((item) => item.extensionId === extensionId);
    if (installs.length !== 1) throw coreError(CoreErrorCode.INVALID_ARGUMENT, `Expected exactly one Luna Browser unpacked installation, found ${installs.length}`, { installs: installs.map(({ browser, profile, extensionId: id, version: v }) => ({ browser, profile, extensionId: id, version: v })) });
    const install = installs[0];
    const currentManifest = await readManifest(install.path);
    if (currentManifest?.name !== LUNA_BROWSER_NAME) throw coreError(CoreErrorCode.ARTIFACT_INVALID, "Target directory is no longer a Luna Browser installation");

    const backupId = `${Date.now()}-${String(currentManifest.version || "unknown")}`;
    const backupPath = path.join(this.updateRoot, "backups", backupId);
    await mkdir(path.dirname(backupPath), { recursive: true });
    await cp(install.path, backupPath, { recursive: true, force: false, errorOnExist: true });
    await cp(stagedPath, install.path, { recursive: true, force: true });
    await rm(path.join(install.path, ".luna-update.json"), { force: true });
    const updatedManifest = await readManifest(install.path);
    if (updatedManifest?.name !== LUNA_BROWSER_NAME || String(updatedManifest.version || "") !== String(version)) {
      await cp(backupPath, install.path, { recursive: true, force: true });
      throw coreError(CoreErrorCode.ROLLBACK_FAILED, "Extension activation verification failed; previous files were restored");
    }
    const pending = { version: String(version), sha256: String(expectedSha256 || "").toLocaleLowerCase(), extensionId: install.extensionId, installPath: install.path, previousVersion: String(currentManifest.version || ""), backupPath, activatedAt: new Date().toISOString(), confirmed: false };
    await mkdir(this.updateRoot, { recursive: true });
    await writeFile(path.join(this.updateRoot, "pending.json"), JSON.stringify(pending, null, 2));
    return { text: JSON.stringify(pending, null, 2), structured: pending, details: { ...pending, activated: true } };
  }

  async confirm({ version }) {
    let pending;
    try { pending = JSON.parse(await readFile(path.join(this.updateRoot, "pending.json"), "utf8")); } catch { throw coreError(CoreErrorCode.PATH_NOT_FOUND, "No pending Luna Browser update exists"); }
    if (String(version || "") !== String(pending.version || "")) throw coreError(CoreErrorCode.INVALID_ARGUMENT, `Pending update is ${pending.version}, not ${version}`);
    const manifest = await readManifest(pending.installPath);
    if (manifest?.name !== LUNA_BROWSER_NAME || String(manifest.version || "") !== String(version)) throw coreError(CoreErrorCode.ARTIFACT_INVALID, "Installed Luna Browser version does not match pending update");
    pending.confirmed = true;
    pending.confirmedAt = new Date().toISOString();
    await writeFile(path.join(this.updateRoot, "pending.json"), JSON.stringify(pending, null, 2));
    const result = { version: pending.version, confirmed: true, previousVersion: pending.previousVersion, backupPath: pending.backupPath };
    return { text: JSON.stringify(result, null, 2), structured: result, details: result };
  }

  async rollback() {
    let pending;
    try { pending = JSON.parse(await readFile(path.join(this.updateRoot, "pending.json"), "utf8")); } catch { throw coreError(CoreErrorCode.PATH_NOT_FOUND, "No pending Luna Browser update exists"); }
    if (!pending.backupPath || !await exists(pending.backupPath)) throw coreError(CoreErrorCode.PATH_NOT_FOUND, "Luna Browser rollback backup is missing");
    await cp(pending.backupPath, pending.installPath, { recursive: true, force: true });
    const manifest = await readManifest(pending.installPath);
    const result = { rolledBack: true, restoredVersion: String(manifest?.version || pending.previousVersion || ""), installPath: pending.installPath };
    pending.rolledBackAt = new Date().toISOString();
    await writeFile(path.join(this.updateRoot, "pending.json"), JSON.stringify(pending, null, 2));
    return { text: JSON.stringify(result, null, 2), structured: result, details: result };
  }
}
