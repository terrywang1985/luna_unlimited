import path from "node:path";
import { randomBytes } from "node:crypto";
import { lstat, mkdir, rename, rm, writeFile } from "node:fs/promises";

import { CoreErrorCode, coreError, normalizeCoreError } from "./errors.mjs";
import { sha256 } from "./hash.mjs";

async function lstatOrMissing(target) {
  try {
    return await lstat(target);
  } catch (error) {
    if (error?.code === "ENOENT") return null;
    throw error;
  }
}

export class BrowserFileTransferService {
  constructor({ workspace, mutations, maxBytes }) {
    this.workspace = workspace;
    this.mutations = mutations;
    this.maxBytes = maxBytes;
  }

  async upload({ path: relativePath, buffer }) {
    if (!Buffer.isBuffer(buffer)) {
      throw coreError(CoreErrorCode.INVALID_ARGUMENT, "upload body must be binary bytes");
    }
    if (buffer.length > this.maxBytes) {
      throw coreError(CoreErrorCode.FILE_TOO_LARGE, `Upload exceeds ${this.maxBytes} bytes`);
    }

    const destinationPath = this.workspace.resolve(relativePath);
    await this.workspace.rejectSymlinks(destinationPath, true);

    return this.mutations.run(destinationPath, async () => {
      await this.workspace.rejectSymlinks(destinationPath, true);
      const existing = await lstatOrMissing(destinationPath);
      if (existing) {
        throw coreError(CoreErrorCode.FILE_CHANGED, "Upload destination already exists");
      }

      const parent = path.dirname(destinationPath);
      await mkdir(parent, { recursive: true });
      await this.workspace.rejectSymlinks(parent);

      const temporaryPath = path.join(parent, `.luna-upload-${randomBytes(12).toString("hex")}`);
      try {
        await writeFile(temporaryPath, buffer, { flag: "wx" });
        await rename(temporaryPath, destinationPath);
      } catch (rawError) {
        try {
          await rm(temporaryPath, { force: true });
        } catch {}
        throw normalizeCoreError(rawError, CoreErrorCode.IO_ERROR);
      }

      const result = {
        path: this.workspace.display(destinationPath),
        bytes: buffer.length,
        sha256: sha256(buffer),
        action: "created"
      };
      return {
        text: JSON.stringify(result, null, 2),
        structured: result,
        details: result
      };
    });
  }
}
