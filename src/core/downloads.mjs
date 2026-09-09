import https from "node:https";
import path from "node:path";
import { createHash, randomBytes } from "node:crypto";
import { Transform } from "node:stream";
import { pipeline } from "node:stream/promises";
import { createWriteStream } from "node:fs";
import { lstat, mkdir, rename, rm } from "node:fs/promises";

import { createPinnedLookup, resolvePublicArtifactUrl } from "./artifacts.mjs";
import { CoreErrorCode, coreError, normalizeCoreError } from "./errors.mjs";
import { isSha256 } from "./hash.mjs";

const DEFAULT_MAX_DOWNLOAD_BYTES = 32 * 1024 * 1024 * 1024;
const MAX_JOBS = 64;

async function lstatOrMissing(target) {
  try {
    return await lstat(target);
  } catch (error) {
    if (error?.code === "ENOENT") return null;
    throw error;
  }
}

async function openHttpsSource(rawUrl, redirectsRemaining = 4) {
  const { url, address } = await resolvePublicArtifactUrl(rawUrl);
  return new Promise((resolve, reject) => {
    const request = https.get(url, {
      headers: { Accept: "*/*", "User-Agent": "luna-unlimited-download/0.8" },
      lookup: createPinnedLookup(address)
    }, async (response) => {
      const statusCode = response.statusCode || 0;
      if ([301, 302, 303, 307, 308].includes(statusCode)) {
        response.resume();
        if (redirectsRemaining < 1 || !response.headers.location) {
          reject(coreError(CoreErrorCode.ARTIFACT_DOWNLOAD_FAILED, "Download exceeded redirect limit"));
          return;
        }
        try {
          resolve(await openHttpsSource(new URL(response.headers.location, url).toString(), redirectsRemaining - 1));
        } catch (error) {
          reject(error);
        }
        return;
      }
      if (statusCode < 200 || statusCode >= 300) {
        response.resume();
        reject(coreError(CoreErrorCode.ARTIFACT_DOWNLOAD_FAILED, `Download returned HTTP ${statusCode}`));
        return;
      }
      resolve({ request, response, url: url.toString() });
    });
    request.setTimeout(60_000, () => request.destroy(coreError(CoreErrorCode.ARTIFACT_DOWNLOAD_FAILED, "Download connection timed out")));
    request.on("error", reject);
  });
}

function serializeJob(job) {
  const percent = job.expectedBytes > 0 ? Number(((job.bytes * 100) / job.expectedBytes).toFixed(2)) : null;
  return {
    download_id: job.id,
    state: job.state,
    source: job.source,
    destination: job.destination,
    bytes: job.bytes,
    expected_bytes: job.expectedBytes,
    percent,
    expected_sha256: job.expectedSha256,
    actual_sha256: job.actualSha256,
    error: job.error,
    created_at: job.createdAt,
    updated_at: job.updatedAt,
    completed_at: job.completedAt
  };
}

export class DownloadService {
  constructor({ workspace, mutations, maxBytes = DEFAULT_MAX_DOWNLOAD_BYTES, openSource = openHttpsSource } = {}) {
    this.workspace = workspace;
    this.mutations = mutations;
    this.maxBytes = maxBytes;
    this.openSource = openSource;
    this.jobs = new Map();
  }

  trimJobs() {
    if (this.jobs.size < MAX_JOBS) return;
    for (const [id, job] of this.jobs) {
      if (["completed", "failed", "cancelled"].includes(job.state)) {
        this.jobs.delete(id);
        if (this.jobs.size < MAX_JOBS) return;
      }
    }
  }

  async start({ url, destination, expectedSha256, expectedBytes, overwrite = false }) {
    if (typeof url !== "string" || !url.trim()) throw coreError(CoreErrorCode.INVALID_ARGUMENT, "url is required");
    if (!isSha256(expectedSha256)) throw coreError(CoreErrorCode.INVALID_ARGUMENT, "expected_sha256 must be a SHA-256 digest");
    if (!Number.isSafeInteger(expectedBytes) || expectedBytes < 1 || expectedBytes > this.maxBytes) {
      throw coreError(CoreErrorCode.INVALID_ARGUMENT, `expected_bytes must be between 1 and ${this.maxBytes}`);
    }

    const destinationPath = this.workspace.resolve(destination);
    await this.workspace.rejectSymlinks(destinationPath, true);
    const existing = await lstatOrMissing(destinationPath);
    if (existing && !existing.isFile()) throw coreError(CoreErrorCode.PATH_NOT_FILE, "Download destination is not a regular file");
    if (existing && !overwrite) throw coreError(CoreErrorCode.FILE_ALREADY_EXISTS, "Download destination already exists");

    this.trimJobs();
    const id = `dl_${Date.now()}_${randomBytes(5).toString("hex")}`;
    const job = {
      id,
      state: "queued",
      source: url.trim(),
      destination: this.workspace.display(destinationPath),
      destinationPath,
      expectedSha256: expectedSha256.toLowerCase(),
      expectedBytes,
      overwrite: Boolean(overwrite),
      bytes: 0,
      actualSha256: null,
      error: null,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      completedAt: null,
      request: null,
      cancelled: false
    };
    this.jobs.set(id, job);
    void this.run(job);

    const structured = serializeJob(job);
    return { text: JSON.stringify(structured, null, 2), structured, details: structured };
  }

  async run(job) {
    const parent = path.dirname(job.destinationPath);
    const temporaryPath = path.join(parent, `.luna-download-${job.id}.part`);
    try {
      job.state = "connecting";
      job.updatedAt = new Date().toISOString();
      await mkdir(parent, { recursive: true });
      await this.workspace.rejectSymlinks(parent);

      const source = await this.openSource(job.source);
      job.request = source.request || null;
      if (job.cancelled) {
        source.response?.destroy();
        throw coreError(CoreErrorCode.PROCESS_FAILED, "Download cancelled");
      }

      const declaredLength = Number.parseInt(String(source.response?.headers?.["content-length"] || "0"), 10);
      if (Number.isFinite(declaredLength) && declaredLength > 0 && declaredLength !== job.expectedBytes) {
        source.response.resume();
        throw coreError(CoreErrorCode.FILE_CHANGED, `Download size header mismatch (${declaredLength} != ${job.expectedBytes})`);
      }

      job.state = "downloading";
      job.updatedAt = new Date().toISOString();
      const hash = createHash("sha256");
      const meter = new Transform({
        transform: (chunk, _encoding, callback) => {
          job.bytes += chunk.length;
          job.updatedAt = new Date().toISOString();
          if (job.bytes > job.expectedBytes || job.bytes > this.maxBytes) {
            callback(coreError(CoreErrorCode.FILE_TOO_LARGE, "Download exceeded expected size"));
            return;
          }
          hash.update(chunk);
          callback(null, chunk);
        }
      });
      await pipeline(source.response, meter, createWriteStream(temporaryPath, { flags: "wx" }));
      job.request = null;

      if (job.cancelled) throw coreError(CoreErrorCode.PROCESS_FAILED, "Download cancelled");
      if (job.bytes !== job.expectedBytes) {
        throw coreError(CoreErrorCode.FILE_CHANGED, `Download size mismatch (${job.bytes} != ${job.expectedBytes})`);
      }
      const actualSha256 = hash.digest("hex");
      job.actualSha256 = actualSha256;
      if (actualSha256 !== job.expectedSha256) {
        throw coreError(CoreErrorCode.FILE_CHANGED, "Download SHA-256 mismatch", {
          expectedSha256: job.expectedSha256,
          actualSha256
        });
      }

      job.state = "committing";
      job.updatedAt = new Date().toISOString();
      await this.mutations.run(job.destinationPath, async () => {
        await this.workspace.rejectSymlinks(job.destinationPath, true);
        const existing = await lstatOrMissing(job.destinationPath);
        if (existing && !job.overwrite) throw coreError(CoreErrorCode.FILE_ALREADY_EXISTS, "Download destination appeared during transfer");
        if (existing) await rm(job.destinationPath, { force: false });
        await rename(temporaryPath, job.destinationPath);
      });

      job.state = "completed";
      job.completedAt = new Date().toISOString();
      job.updatedAt = job.completedAt;
    } catch (rawError) {
      try { await rm(temporaryPath, { force: true }); } catch {}
      const error = normalizeCoreError(rawError, CoreErrorCode.ARTIFACT_DOWNLOAD_FAILED);
      job.state = job.cancelled ? "cancelled" : "failed";
      job.error = { code: error.code, message: error.message };
      job.completedAt = new Date().toISOString();
      job.updatedAt = job.completedAt;
      job.request = null;
    }
  }

  async status({ downloadId = null } = {}) {
    if (downloadId) {
      const job = this.jobs.get(downloadId);
      if (!job) throw coreError(CoreErrorCode.PATH_NOT_FOUND, `Unknown download job: ${downloadId}`);
      const structured = serializeJob(job);
      return { text: JSON.stringify(structured, null, 2), structured, details: structured };
    }
    const structured = [...this.jobs.values()].slice(-20).reverse().map(serializeJob);
    return { text: JSON.stringify(structured, null, 2), structured, details: { count: structured.length } };
  }

  async cancel({ downloadId }) {
    const job = this.jobs.get(downloadId);
    if (!job) throw coreError(CoreErrorCode.PATH_NOT_FOUND, `Unknown download job: ${downloadId}`);
    if (["completed", "failed", "cancelled"].includes(job.state)) {
      const structured = serializeJob(job);
      return { text: JSON.stringify(structured, null, 2), structured, details: structured };
    }
    job.cancelled = true;
    job.request?.destroy(coreError(CoreErrorCode.PROCESS_FAILED, "Download cancelled"));
    job.updatedAt = new Date().toISOString();
    const structured = serializeJob(job);
    return { text: JSON.stringify(structured, null, 2), structured, details: structured };
  }
}
