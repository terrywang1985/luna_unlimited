import path from "node:path";
import https from "node:https";
import { randomBytes } from "node:crypto";
import { lstat, mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";

import { CoreErrorCode, coreError, normalizeCoreError } from "./errors.mjs";
import { isSha256, sha256 } from "./hash.mjs";
import { resolvePublicAddresses } from "./network.mjs";

const IMPORT_FORMATS = Object.freeze({
  ".pdf": ["application/pdf"],
  ".xlsx": ["application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"],
  ".xls": ["application/vnd.ms-excel"],
  ".png": ["image/png"],
  ".jpg": ["image/jpeg"],
  ".jpeg": ["image/jpeg"],
  ".gif": ["image/gif"],
  ".webp": ["image/webp"]
});

async function lstatOrMissing(targetPath) {
  try {
    return await lstat(targetPath);
  } catch (error) {
    if (error?.code === "ENOENT") return null;
    throw normalizeCoreError(error, CoreErrorCode.IO_ERROR);
  }
}

function normalizeMime(value) {
  return typeof value === "string" ? value.split(";", 1)[0].trim().toLocaleLowerCase() : null;
}

export function createPinnedLookup(address) {
  const pinned = { address: address.address, family: address.family };
  return (_hostname, options, callback) => {
    if (options && typeof options === "object" && options.all === true) {
      callback(null, [pinned]);
      return;
    }
    callback(null, pinned.address, pinned.family);
  };
}

function sourceShape(source) {
  const shape = {};
  for (const field of ["url", "id", "mimeType", "fileName"]) {
    shape[field] = {
      present: source != null && Object.hasOwn(source, field),
      type: source == null ? "missing" : typeof source[field]
    };
  }
  return shape;
}

function sourceScheme(sourceId) {
  const match = typeof sourceId === "string" ? /^([a-z][a-z0-9+.-]*):\/\//i.exec(sourceId) : null;
  return match ? match[1].toLocaleLowerCase() : "opaque";
}

export async function resolvePublicArtifactUrl(rawUrl) {
  let url;
  try {
    url = new URL(rawUrl);
  } catch {
    throw coreError(CoreErrorCode.ARTIFACT_SOURCE_NOT_ALLOWED, "Artifact source URL is invalid");
  }
  if (url.protocol !== "https:" || url.username || url.password || (url.port && url.port !== "443")) {
    throw coreError(CoreErrorCode.ARTIFACT_SOURCE_NOT_ALLOWED, "Artifact source must use credential-free HTTPS on port 443");
  }
  const hostname = url.hostname.toLocaleLowerCase();
  if (hostname === "localhost" || hostname.endsWith(".localhost") || hostname.endsWith(".local") || hostname.endsWith(".internal")) {
    throw coreError(CoreErrorCode.ARTIFACT_SOURCE_NOT_ALLOWED, "Local and private artifact sources are blocked");
  }
  const addresses = await resolvePublicAddresses(hostname);
  if (!addresses.length) {
    throw coreError(CoreErrorCode.ARTIFACT_SOURCE_NOT_ALLOWED, "Artifact source resolved to a non-public address");
  }
  return { url, address: addresses[0] };
}

async function requestArtifact(rawUrl, maxBytes, redirectsRemaining = 3) {
  const { url, address } = await resolvePublicArtifactUrl(rawUrl);
  return new Promise((resolve, reject) => {
    const request = https.get(url, {
      headers: { Accept: "*/*", "User-Agent": "luna-unlimited-artifact-import/0.6" },
      lookup: createPinnedLookup(address)
    }, (response) => {
      const statusCode = response.statusCode || 0;
      if ([301, 302, 303, 307, 308].includes(statusCode)) {
        response.resume();
        if (redirectsRemaining < 1 || !response.headers.location) {
          reject(coreError(CoreErrorCode.ARTIFACT_SOURCE_NOT_ALLOWED, "Artifact download exceeded redirect limit"));
          return;
        }
        const redirected = new URL(response.headers.location, url).toString();
        requestArtifact(redirected, maxBytes, redirectsRemaining - 1).then(resolve, reject);
        return;
      }
      if (statusCode < 200 || statusCode >= 300) {
        response.resume();
        reject(coreError(CoreErrorCode.ARTIFACT_DOWNLOAD_FAILED, `Artifact download returned HTTP ${statusCode}`));
        return;
      }
      const declaredLength = Number.parseInt(String(response.headers["content-length"] || "0"), 10);
      if (Number.isFinite(declaredLength) && declaredLength > maxBytes) {
        response.destroy();
        reject(coreError(CoreErrorCode.FILE_TOO_LARGE, `Artifact exceeds ${maxBytes} bytes`));
        return;
      }
      const chunks = [];
      let bytes = 0;
      response.on("data", (chunk) => {
        bytes += chunk.length;
        if (bytes > maxBytes) {
          response.destroy(coreError(CoreErrorCode.FILE_TOO_LARGE, `Artifact exceeds ${maxBytes} bytes`));
          return;
        }
        chunks.push(chunk);
      });
      response.on("end", () => resolve({
        buffer: Buffer.concat(chunks),
        responseMimeType: normalizeMime(response.headers["content-type"])
      }));
      response.on("error", reject);
    });
    request.setTimeout(60_000, () => request.destroy(coreError(CoreErrorCode.ARTIFACT_DOWNLOAD_FAILED, "Artifact download timed out")));
    request.on("error", reject);
  });
}

function startsWith(buffer, signature) {
  return buffer.length >= signature.length && buffer.subarray(0, signature.length).equals(signature);
}

function detectMimeType(buffer, extension = "") {
  if (startsWith(buffer, Buffer.from("%PDF-"))) return "application/pdf";
  if (startsWith(buffer, Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) return "image/png";
  if (startsWith(buffer, Buffer.from([0xff, 0xd8, 0xff]))) return "image/jpeg";
  if (startsWith(buffer, Buffer.from("GIF87a")) || startsWith(buffer, Buffer.from("GIF89a"))) return "image/gif";
  if (buffer.length >= 12 && buffer.toString("ascii", 0, 4) === "RIFF" && buffer.toString("ascii", 8, 12) === "WEBP") return "image/webp";
  if (startsWith(buffer, Buffer.from([0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1]))) return "application/vnd.ms-excel";
  if (startsWith(buffer, Buffer.from([0x50, 0x4b, 0x03, 0x04])) && extension === ".xlsx") {
    const marker = buffer.toString("latin1");
    if (marker.includes("[Content_Types].xml") && marker.includes("xl/")) {
      return "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet";
    }
  }
  return "application/octet-stream";
}

function jpegDimensions(buffer) {
  let offset = 2;
  while (offset + 9 < buffer.length) {
    if (buffer[offset] !== 0xff) return null;
    const marker = buffer[offset + 1];
    const length = buffer.readUInt16BE(offset + 2);
    if ([0xc0, 0xc1, 0xc2, 0xc3, 0xc5, 0xc6, 0xc7, 0xc9, 0xca, 0xcb, 0xcd, 0xce, 0xcf].includes(marker)) {
      return { width: buffer.readUInt16BE(offset + 7), height: buffer.readUInt16BE(offset + 5) };
    }
    if (length < 2) return null;
    offset += length + 2;
  }
  return null;
}

function imageDimensions(buffer, mimeType) {
  if (mimeType === "image/png" && buffer.length >= 24) {
    return { width: buffer.readUInt32BE(16), height: buffer.readUInt32BE(20) };
  }
  if (mimeType === "image/gif" && buffer.length >= 10) {
    return { width: buffer.readUInt16LE(6), height: buffer.readUInt16LE(8) };
  }
  if (mimeType === "image/jpeg") return jpegDimensions(buffer);
  if (mimeType === "image/webp" && buffer.length >= 30 && buffer.toString("ascii", 12, 16) === "VP8X") {
    return {
      width: 1 + buffer.readUIntLE(24, 3),
      height: 1 + buffer.readUIntLE(27, 3)
    };
  }
  return null;
}

function artifactKind(mimeType) {
  if (mimeType.startsWith("image/")) return "image";
  if (mimeType === "application/pdf") return "document";
  if (mimeType.includes("spreadsheet") || mimeType === "application/vnd.ms-excel") return "spreadsheet";
  return "binary";
}

function artifactMetadata(workspace, targetPath, buffer) {
  const extension = path.extname(targetPath).toLocaleLowerCase();
  const mimeType = detectMimeType(buffer, extension);
  const dimensions = imageDimensions(buffer, mimeType);
  const result = {
    path: workspace.display(targetPath),
    name: path.basename(targetPath),
    extension: extension || null,
    kind: artifactKind(mimeType),
    mimeType,
    bytes: buffer.length,
    sha256: sha256(buffer)
  };
  if (dimensions) result.image = dimensions;
  if (mimeType === "application/pdf") {
    const matches = buffer.toString("latin1").match(/\/Type\s*\/Page\b/g);
    result.pdf = { pageCountEstimate: matches?.length || null };
  }
  return result;
}

export class ArtifactService {
  constructor({ workspace, mutations, maxArtifactBytes, exportTokenTtlMs = 5 * 60 * 1000, maxExportTokens = 1000 }) {
    this.workspace = workspace;
    this.mutations = mutations;
    this.maxArtifactBytes = maxArtifactBytes;
    this.exportTokenTtlMs = exportTokenTtlMs;
    this.maxExportTokens = maxExportTokens;
    this.exportTokens = new Map();
    this.downloadSource = (source) => requestArtifact(source.url, this.maxArtifactBytes);
    this.renamePath = rename;
    this.removePath = rm;
    this.writeBytes = writeFile;
  }

  async inspect({ path: relativePath }) {
    const targetPath = this.workspace.resolve(relativePath);
    await this.workspace.rejectSymlinks(targetPath);
    const info = await lstatOrMissing(targetPath);
    if (!info || !info.isFile()) throw coreError(CoreErrorCode.PATH_NOT_FILE, "Artifact path is not a regular file");
    if (info.size > this.maxArtifactBytes) {
      throw coreError(CoreErrorCode.FILE_TOO_LARGE, `Artifact is too large (${info.size} bytes; limit is ${this.maxArtifactBytes})`);
    }
    const metadata = artifactMetadata(this.workspace, targetPath, await readFile(targetPath));
    return { text: JSON.stringify(metadata, null, 2), structured: metadata, details: metadata };
  }

  async preflightImport(destination, expectedSha256) {
    if (expectedSha256 !== null && !isSha256(expectedSha256)) {
      throw coreError(CoreErrorCode.INVALID_ARGUMENT, "expected_sha256 must be a SHA-256 digest or null for a new file");
    }
    const destinationPath = this.workspace.resolve(destination);
    const extension = path.extname(destinationPath).toLocaleLowerCase();
    if (!IMPORT_FORMATS[extension]) {
      throw coreError(CoreErrorCode.ARTIFACT_TYPE_NOT_ALLOWED, `Import type is not allowed for extension ${extension || "(none)"}`);
    }
    await this.workspace.rejectSymlinks(destinationPath, true);
    const existing = await lstatOrMissing(destinationPath);
    if (existing && !existing.isFile()) throw coreError(CoreErrorCode.PATH_NOT_FILE, "Artifact destination is not a file");
    if (existing && expectedSha256 === null) {
      throw coreError(CoreErrorCode.FILE_CHANGED, "Expected a new artifact but destination exists");
    }
    if (!existing && expectedSha256 !== null) {
      throw coreError(CoreErrorCode.FILE_CHANGED, "Expected artifact no longer exists", { actualSha256: null });
    }
    let actualSha256 = null;
    if (existing) {
      if (existing.size > this.maxArtifactBytes) {
        throw coreError(CoreErrorCode.FILE_TOO_LARGE, `Artifact is too large (${existing.size} bytes; limit is ${this.maxArtifactBytes})`);
      }
      actualSha256 = sha256(await readFile(destinationPath));
      if (actualSha256.toLocaleLowerCase() !== expectedSha256.toLocaleLowerCase()) {
        throw coreError(CoreErrorCode.FILE_CHANGED, "Artifact changed since it was inspected", {
          expectedSha256,
          actualSha256
        });
      }
    }
    return { destinationPath, extension, existing, actualSha256 };
  }

  validateImportedArtifact(destinationPath, buffer, source) {
    if (!buffer.length) throw coreError(CoreErrorCode.ARTIFACT_INVALID, "Imported artifact is empty");
    const extension = path.extname(destinationPath).toLocaleLowerCase();
    const allowedMimes = IMPORT_FORMATS[extension];
    if (!allowedMimes) {
      throw coreError(CoreErrorCode.ARTIFACT_TYPE_NOT_ALLOWED, `Import type is not allowed for extension ${extension || "(none)"}`);
    }
    const detectedMime = detectMimeType(buffer, extension);
    if (!allowedMimes.includes(detectedMime)) {
      throw coreError(CoreErrorCode.ARTIFACT_INVALID, `File signature does not match destination extension ${extension}`);
    }
    const declaredMime = normalizeMime(source.mimeType);
    if (declaredMime && declaredMime !== "application/octet-stream" && !allowedMimes.includes(declaredMime)) {
      throw coreError(CoreErrorCode.ARTIFACT_INVALID, "Declared MIME type does not match the destination type");
    }
    return detectedMime;
  }

  async import({ source, destination, expectedSha256 }) {
    if (!source || typeof source.url !== "string" || typeof source.id !== "string" || !source.id) {
      throw coreError(CoreErrorCode.INVALID_ARGUMENT, "source must contain an authorized URL and opaque source id", {
        sourceShape: sourceShape(source)
      });
    }
    const initialPreflight = await this.preflightImport(destination, expectedSha256);
    const destinationPath = initialPreflight.destinationPath;
    let downloaded;
    try {
      downloaded = await this.downloadSource(source);
    } catch (rawError) {
      const error = normalizeCoreError(rawError, CoreErrorCode.ARTIFACT_DOWNLOAD_FAILED);
      throw coreError(error.code, error.message, {
        ...error.details,
        sourceShape: sourceShape(source)
      });
    }
    if (!downloaded?.buffer || !Buffer.isBuffer(downloaded.buffer)) {
      throw coreError(CoreErrorCode.ARTIFACT_DOWNLOAD_FAILED, "Artifact source did not return bytes");
    }
    if (downloaded.buffer.length > this.maxArtifactBytes) {
      throw coreError(CoreErrorCode.FILE_TOO_LARGE, `Artifact exceeds ${this.maxArtifactBytes} bytes`);
    }
    const mimeType = this.validateImportedArtifact(destinationPath, downloaded.buffer, source);

    return this.mutations.run(destinationPath, async () => {
      await this.workspace.rejectSymlinks(destinationPath, true);
      const existing = await lstatOrMissing(destinationPath);
      if (existing && !existing.isFile()) throw coreError(CoreErrorCode.PATH_NOT_FILE, "Artifact destination is not a file");
      if (existing && expectedSha256 === null) {
        throw coreError(CoreErrorCode.FILE_CHANGED, "Expected a new artifact but destination exists");
      }
      if (!existing && expectedSha256 !== null) {
        throw coreError(CoreErrorCode.FILE_CHANGED, "Expected artifact no longer exists", { actualSha256: null });
      }
      let beforeSha256 = null;
      if (existing) {
        beforeSha256 = sha256(await readFile(destinationPath));
        if (beforeSha256.toLocaleLowerCase() !== expectedSha256.toLocaleLowerCase()) {
          throw coreError(CoreErrorCode.FILE_CHANGED, "Artifact changed since it was inspected", {
            expectedSha256,
            actualSha256: beforeSha256
          });
        }
      }

      await mkdir(path.dirname(destinationPath), { recursive: true });
      await this.workspace.rejectSymlinks(path.dirname(destinationPath));
      const temporaryPath = path.join(path.dirname(destinationPath), `.luna-import-${randomBytes(12).toString("hex")}`);
      const backupPath = existing
        ? path.join(path.dirname(destinationPath), `.luna-import-backup-${randomBytes(12).toString("hex")}`)
        : null;
      try {
        await this.writeBytes(temporaryPath, downloaded.buffer, { flag: "wx" });
        if (backupPath) await this.renamePath(destinationPath, backupPath);
        await this.renamePath(temporaryPath, destinationPath);
        if (backupPath) await this.removePath(backupPath, { force: false });
      } catch (rawError) {
        const rollbackErrors = [];
        try {
          if (await lstatOrMissing(temporaryPath)) await this.removePath(temporaryPath, { force: true });
          if (backupPath && await lstatOrMissing(backupPath)) {
            if (await lstatOrMissing(destinationPath)) await this.removePath(destinationPath, { force: true });
            await this.renamePath(backupPath, destinationPath);
          } else if (!existing && await lstatOrMissing(destinationPath)) {
            await this.removePath(destinationPath, { force: true });
          }
        } catch (error) {
          rollbackErrors.push(error instanceof Error ? error.message : String(error));
        }
        if (rollbackErrors.length) {
          throw coreError(CoreErrorCode.ROLLBACK_FAILED, "Artifact import failed and rollback was incomplete", { rollbackErrors });
        }
        const error = normalizeCoreError(rawError, CoreErrorCode.IO_ERROR);
        throw coreError(error.code, error.message, { ...error.details, rolledBack: true });
      }

      const metadata = artifactMetadata(this.workspace, destinationPath, downloaded.buffer);
      const result = {
        ...metadata,
        action: existing ? "updated" : "created",
        beforeSha256,
        sourceScheme: sourceScheme(source.id)
      };
      return {
        text: JSON.stringify(result, null, 2),
        structured: result,
        details: { ...result, committed: true }
      };
    });
  }

  async export({ path: relativePath }) {
    const inspected = await this.inspect({ path: relativePath });
    const targetPath = this.workspace.resolve(relativePath);
    const token = randomBytes(24).toString("base64url");
    const expiresAt = Date.now() + this.exportTokenTtlMs;
    for (const [existingToken, record] of this.exportTokens) {
      if (record.expiresAt < Date.now()) this.exportTokens.delete(existingToken);
    }
    while (this.exportTokens.size >= this.maxExportTokens) {
      this.exportTokens.delete(this.exportTokens.keys().next().value);
    }
    this.exportTokens.set(token, { targetPath, sha256: inspected.structured.sha256, expiresAt });
    const result = {
      ...inspected.structured,
      resourceUri: `luna-artifact://export/${token}`,
      expiresAt: new Date(expiresAt).toISOString()
    };
    return { text: JSON.stringify(result, null, 2), structured: result, details: { ...inspected.details, exportTokenCreated: true } };
  }

  async readExportResource(token) {
    const record = this.exportTokens.get(token);
    if (!record || record.expiresAt < Date.now()) {
      if (record) this.exportTokens.delete(token);
      throw coreError(CoreErrorCode.ARTIFACT_EXPORT_EXPIRED, "Artifact export link is missing or expired");
    }
    await this.workspace.rejectSymlinks(record.targetPath);
    const info = await lstatOrMissing(record.targetPath);
    if (!info || !info.isFile() || info.size > this.maxArtifactBytes) {
      throw coreError(CoreErrorCode.ARTIFACT_EXPORT_EXPIRED, "Exported artifact is no longer available");
    }
    const buffer = await readFile(record.targetPath);
    const actualSha256 = sha256(buffer);
    if (actualSha256 !== record.sha256) {
      throw coreError(CoreErrorCode.FILE_CHANGED, "Artifact changed after export link creation", {
        expectedSha256: record.sha256,
        actualSha256
      });
    }
    const metadata = artifactMetadata(this.workspace, record.targetPath, buffer);
    return { ...metadata, blob: buffer.toString("base64") };
  }
}
