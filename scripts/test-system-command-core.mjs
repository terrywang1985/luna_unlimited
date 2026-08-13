import os from "node:os";
import path from "node:path";
import { mkdtemp, rm } from "node:fs/promises";

import { createLunaCore } from "../src/core/runtime.mjs";

const temporaryRoot = await mkdtemp(path.join(os.tmpdir(), "luna-system-command-"));
const workspaceRoot = path.join(temporaryRoot, "workspace");

try {
  const restricted = await createLunaCore({
    workspaceRoot: path.join(temporaryRoot, "restricted-workspace"),
    logsDir: path.join(temporaryRoot, "restricted-logs"),
    checkpointRoot: path.join(temporaryRoot, "restricted-checkpoints"),
    maxFileBytes: 1024 * 1024,
    maxCommandOutputBytes: 64 * 1024,
    executionProfile: "restricted",
    runtimeIdentity: { platform: process.platform, uid: null, container: false, root: false }
  });
  if (restricted.policy.isActionEnabled("system.execute")) {
    throw new Error("restricted profile unexpectedly enabled system.execute");
  }
  const locked = restricted.setActionPermission("system.execute", true);
  if (!locked?.locked || restricted.policy.isActionEnabled("system.execute")) {
    throw new Error("Dashboard permission toggle bypassed the restricted startup profile");
  }

  const core = await createLunaCore({
    workspaceRoot,
    logsDir: path.join(temporaryRoot, "logs"),
    checkpointRoot: path.join(temporaryRoot, "checkpoints"),
    maxFileBytes: 1024 * 1024,
    maxCommandOutputBytes: 64 * 1024,
    executionProfile: "user",
    systemApprovalMode: "host",
    runtimeIdentity: { platform: process.platform, uid: 1000, container: false, root: false }
  });
  if (core.policy.requiresApproval("system.execute")) {
    throw new Error("Host approval mode unexpectedly required a second local approval");
  }

  const secretMarker = `approval-visible-${Date.now()}`;
  const hostApproved = await core.execute("system.execute", {
    program: process.execPath,
    args: ["-e", `console.log(${JSON.stringify(secretMarker)})`],
    cwd: ".",
    timeoutSeconds: 15
  }, {}, `SYSTEM COMMAND [user]\n${secretMarker}`);
  if (!hostApproved.ok || !hostApproved.data.structured.stdout.includes(secretMarker)) {
    throw new Error("Host-approved system command did not execute without duplicate local approval");
  }

  const dualApproval = await createLunaCore({
    workspaceRoot: path.join(temporaryRoot, "dual-workspace"),
    logsDir: path.join(temporaryRoot, "dual-logs"),
    checkpointRoot: path.join(temporaryRoot, "dual-checkpoints"),
    maxFileBytes: 1024 * 1024,
    maxCommandOutputBytes: 64 * 1024,
    executionProfile: "user",
    systemApprovalMode: "host-and-local",
    runtimeIdentity: { platform: process.platform, uid: 1000, container: false, root: false }
  });
  if (!dualApproval.policy.requiresApproval("system.execute")) {
    throw new Error("host-and-local mode did not require local approval");
  }
  const invocation = dualApproval.execute("system.execute", {
    program: process.execPath,
    args: ["-e", `console.log(${JSON.stringify(secretMarker)})`],
    cwd: ".",
    timeoutSeconds: 15
  }, {}, `SYSTEM COMMAND [user]\n${secretMarker}`);
  let pending = null;
  for (let attempt = 0; attempt < 30; attempt += 1) {
    pending = dualApproval.approvals.list().pending.find((item) => item.action === "system.execute");
    if (pending) break;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  if (!pending || !pending.summary.includes(secretMarker)) {
    throw new Error("System command did not pause with an exact local approval summary");
  }
  dualApproval.setApprovalEnabled(false);
  if (!dualApproval.approvals.get(pending.id)) {
    throw new Error("Disabling global approval incorrectly cancelled mandatory system approval");
  }
  dualApproval.decideApproval(pending.id, "approve");
  const result = await invocation;
  if (!result.ok || result.data.structured.exit_code !== 0 || !result.data.structured.stdout.includes(secretMarker)) {
    throw new Error("Approved system command did not execute successfully");
  }
  const event = dualApproval.audit.list(20).find((item) => item.tool === "system.execute" && item.status === "success");
  if (!event || JSON.stringify(event.details).includes(secretMarker) || !event.details.commandSha256) {
    throw new Error("System command audit must retain a hash and metadata without persisting command arguments");
  }

  console.log("PASS: restricted startup profile cannot be bypassed from the Dashboard");
  console.log("PASS: Host approval mode executes without duplicate local approval");
  console.log("PASS: optional host-and-local mode pauses for Dashboard approval");
  console.log("PASS: approved user-profile command returns structured output");
  console.log("PASS: persistent audit stores command hash and metadata without command arguments");
  await restricted.audit.flush();
  await core.audit.flush();
  await dualApproval.audit.flush();
} finally {
  await rm(temporaryRoot, { recursive: true, force: true });
}
