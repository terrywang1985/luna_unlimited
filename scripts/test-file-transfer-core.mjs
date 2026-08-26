import assert from "node:assert/strict";
import os from "node:os";
import path from "node:path";
import { mkdtemp, readFile, rm } from "node:fs/promises";

import { BrowserFileTransferService } from "../src/core/file-transfer.mjs";
import { FileMutationQueue } from "../src/core/mutation-queue.mjs";
import { WorkspaceService } from "../src/core/workspace.mjs";

const root = await mkdtemp(path.join(os.tmpdir(), "luna-upload-test-"));
try {
  const workspace = new WorkspaceService(root);
  const service = new BrowserFileTransferService({
    workspace,
    mutations: new FileMutationQueue(),
    maxBytes: 1024 * 1024
  });
  const bytes = Buffer.from([0, 1, 2, 3, 255, 10, 20]);
  const result = await service.upload({ path: "incoming/sample.bin", buffer: bytes });
  assert.equal(result.structured.path, "incoming/sample.bin");
  assert.deepEqual(await readFile(path.join(root, "incoming", "sample.bin")), bytes);

  await assert.rejects(
    service.upload({ path: "incoming/sample.bin", buffer: Buffer.from("replace") }),
    (error) => error?.code === "FILE_CHANGED"
  );
  await assert.rejects(
    service.upload({ path: "../escape.bin", buffer: Buffer.from("x") }),
    (error) => error?.code === "PATH_OUTSIDE_WORKSPACE"
  );
  console.log("ok - browser file transfer core");
} finally {
  await rm(root, { recursive: true, force: true });
}
