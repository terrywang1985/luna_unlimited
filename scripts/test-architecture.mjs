import os from "node:os";
import path from "node:path";
import { mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";

import { createLunaCore } from "../src/core/runtime.mjs";
import { CoreErrorCode } from "../src/core/errors.mjs";

async function collectModules(directory) {
  const modules = [];
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const target = path.join(directory, entry.name);
    if (entry.isDirectory()) modules.push(...await collectModules(target));
    else if (entry.isFile() && entry.name.endsWith(".mjs")) modules.push(target);
  }
  return modules;
}

const projectRoot = path.resolve(import.meta.dirname, "..");
const coreModules = await collectModules(path.join(projectRoot, "src", "core"));
for (const modulePath of coreModules) {
  const source = await readFile(modulePath, "utf8");
  if (source.includes("@modelcontextprotocol/sdk") || /from\s+["']zod["']/.test(source)) {
    throw new Error(`Core protocol boundary violated by ${path.relative(projectRoot, modulePath)}`);
  }
}

const temporaryRoot = await mkdtemp(path.join(os.tmpdir(), "luna-core-architecture-"));
const workspaceRoot = path.join(temporaryRoot, "workspace");
const logsDir = path.join(temporaryRoot, "logs");

try {
  const core = await createLunaCore({
    workspaceRoot,
    logsDir,
    maxFileBytes: 1024 * 1024,
    maxCommandOutputBytes: 256 * 1024
  });
  const context = {
    caller: { clientId: "architecture-test", clientName: "test-host", sessionId: "session-1", protocol: "direct" },
    workSessionId: "work-1"
  };

  const write = await core.execute("write_text_file", { path: "round-trip.txt", content: "core-ok" }, context);
  if (!write.ok || write.data.text !== "Wrote 7 bytes to round-trip.txt") {
    throw new Error("Direct Core write result contract failed");
  }

  const read = await core.execute("read_text_file", { path: "round-trip.txt" }, context);
  if (!read.ok || read.data.text !== "core-ok") throw new Error("Direct Core read result contract failed");

  const stat = await core.execute("stat_path", { path: "round-trip.txt" }, context);
  const expectedSha256 = stat.data.structured.sha256;
  if (!stat.ok || !/^[a-f0-9]{64}$/.test(expectedSha256)) {
    throw new Error("stat_path did not return a stable content hash");
  }

  const batch = await core.execute("write_files", {
    files: [
      { path: "round-trip.txt", content: "core-updated", expectedSha256 },
      { path: "nested/new.txt", content: "new-file" }
    ]
  }, context);
  if (!batch.ok || batch.data.structured.files.length !== 2 || batch.data.details.committed !== true) {
    throw new Error("Atomic write_files direct Core contract failed");
  }

  const stale = await core.execute("write_files", {
    files: [{ path: "round-trip.txt", content: "stale-write", expectedSha256 }]
  }, context);
  if (stale.ok || stale.error.code !== CoreErrorCode.FILE_CHANGED) {
    throw new Error("Stale hash was not rejected as FILE_CHANGED");
  }

  const unchanged = await readFile(path.join(workspaceRoot, "round-trip.txt"), "utf8");
  if (unchanged !== "core-updated") throw new Error("Stale write changed the file");

  const order = [];
  await Promise.all([
    core.mutations.run(path.join(workspaceRoot, "queue.txt"), async () => {
      order.push("first-start");
      await new Promise((resolve) => setTimeout(resolve, 25));
      await writeFile(path.join(workspaceRoot, "queue.txt"), "first", "utf8");
      order.push("first-end");
    }),
    core.mutations.run(path.join(workspaceRoot, "queue.txt"), async () => {
      order.push("second-start");
      await writeFile(path.join(workspaceRoot, "queue.txt"), "second", "utf8");
      order.push("second-end");
    })
  ]);
  if (order.join(",") !== "first-start,first-end,second-start,second-end") {
    throw new Error(`Per-file mutation queue did not serialize writes: ${order.join(",")}`);
  }

  const traversal = await core.execute("read_text_file", { path: "../outside.txt" }, context);
  if (traversal.ok || traversal.error.code !== CoreErrorCode.PATH_OUTSIDE_WORKSPACE) {
    throw new Error("Core traversal error is not structured as PATH_OUTSIDE_WORKSPACE");
  }

  core.setToolPermission("write_text_file", false);
  const disabled = await core.execute("write_text_file", { path: "denied.txt", content: "denied" }, context);
  if (disabled.ok || disabled.error.code !== CoreErrorCode.TOOL_DISABLED) {
    throw new Error("Core permission error is not structured as TOOL_DISABLED");
  }

  const readAudit = core.audit.list(20).find((event) => event.tool === "read_text_file" && event.status === "success");
  if (readAudit?.details?.context?.clientId !== "architecture-test" || readAudit.details.context.workSessionId !== "work-1") {
    throw new Error("CallerContext / WorkSessionContext was not retained for audit");
  }

  console.log("PASS: Core modules do not depend on MCP SDK or Zod");
  console.log("PASS: direct Core file operations return protocol-neutral DTOs");
  console.log("PASS: Core errors expose stable structured error codes");
  console.log("PASS: caller and work-session metadata are audit-only context");
  console.log("PASS: content hashes reject stale edits and multi-file writes commit atomically");
  console.log("PASS: per-file mutation queues serialize concurrent writers");
  await core.audit.flush();
} finally {
  await rm(temporaryRoot, { recursive: true, force: true });
}
