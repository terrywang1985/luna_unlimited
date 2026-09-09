import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { Readable } from "node:stream";

import { DownloadService } from "../src/core/downloads.mjs";
import { FileMutationQueue } from "../src/core/mutation-queue.mjs";
import { WorkspaceService } from "../src/core/workspace.mjs";

const root = await mkdtemp(path.join(os.tmpdir(), "luna-download-test-"));
try {
  const workspace = new WorkspaceService(root);
  const mutations = new FileMutationQueue();
  const payload = Buffer.concat(Array.from({ length: 1024 }, (_, i) => Buffer.from(`chunk-${i.toString().padStart(4, "0")}\n`)));
  const digest = createHash("sha256").update(payload).digest("hex");
  const openSource = async () => ({
    request: null,
    response: Object.assign(Readable.from([payload.subarray(0, 3000), payload.subarray(3000)]), {
      headers: { "content-length": String(payload.length) }
    })
  });
  const service = new DownloadService({ workspace, mutations, maxBytes: 1024 * 1024, openSource });

  const started = await service.start({
    url: "https://example.com/model.gguf",
    destination: "models/model.gguf",
    expectedSha256: digest,
    expectedBytes: payload.length,
    overwrite: false
  });
  assert.match(started.structured.download_id, /^dl_/);

  let status;
  for (let i = 0; i < 100; i++) {
    status = (await service.status({ downloadId: started.structured.download_id })).structured;
    if (["completed", "failed", "cancelled"].includes(status.state)) break;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  assert.equal(status.state, "completed");
  assert.equal(status.bytes, payload.length);
  assert.equal(status.actual_sha256, digest);
  assert.deepEqual(await readFile(path.join(root, "models/model.gguf")), payload);

  const bad = await service.start({
    url: "https://example.com/bad.gguf",
    destination: "models/bad.gguf",
    expectedSha256: "0".repeat(64),
    expectedBytes: payload.length,
    overwrite: false
  });
  for (let i = 0; i < 100; i++) {
    status = (await service.status({ downloadId: bad.structured.download_id })).structured;
    if (["completed", "failed", "cancelled"].includes(status.state)) break;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  assert.equal(status.state, "failed");
  assert.equal(status.error.code, "FILE_CHANGED");
  await assert.rejects(readFile(path.join(root, "models/bad.gguf")), { code: "ENOENT" });

  console.log("download service tests passed");
} finally {
  await rm(root, { recursive: true, force: true });
}
