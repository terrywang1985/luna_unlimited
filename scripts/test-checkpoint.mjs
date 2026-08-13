import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";

const baseUrl = process.env.MCP_TEST_BASE_URL || "http://127.0.0.1:18765";
const client = new Client({ name: "luna-checkpoint-mcp-test", version: "0.8.0" });
const transport = new StreamableHTTPClientTransport(new URL(`${baseUrl}/mcp`));
let initialApprovalEnabled = false;

function toolText(result) {
  return result.content?.find((item) => item.type === "text")?.text || "";
}

async function call(name, args = {}) {
  const mapped = {
    get_capabilities: ["luna.capabilities", {}],
    stat_path: ["workspace.read", { request: { operation: "stat", ...args } }],
    read_text_file: ["workspace.read", { request: { operation: "text", ...args } }],
    write_files: ["workspace.write", { request: { operation: "many", ...args } }],
    create_checkpoint: ["checkpoint.write", { request: { operation: "create", ...args } }],
    list_checkpoints: ["checkpoint.read", {}],
    restore_checkpoint: ["checkpoint.write", { request: { operation: "restore", ...args } }],
    delete_checkpoint: ["checkpoint.write", { request: { operation: "delete", ...args } }]
  }[name] || [name, args];
  const result = await client.callTool({ name: mapped[0], arguments: mapped[1] });
  return { result, text: toolText(result) };
}

async function statPath(filePath) {
  const { result, text } = await call("stat_path", { path: filePath });
  if (result.isError) throw new Error(`stat_path failed: ${text}`);
  return JSON.parse(text);
}

async function safeFile(filePath, content) {
  const current = await statPath(filePath);
  return current.exists ? { path: filePath, content, expected_sha256: current.sha256 } : { path: filePath, content };
}

async function setApprovalEnabled(enabled) {
  const response = await fetch(`${baseUrl}/admin/api/approval-policy`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ enabled })
  });
  if (!response.ok) throw new Error(`Approval policy returned HTTP ${response.status}`);
}

async function waitForApproval(tool, targetPath) {
  for (let attempt = 0; attempt < 50; attempt += 1) {
    const response = await fetch(`${baseUrl}/admin/api/approvals`, { cache: "no-store" });
    const approvals = await response.json();
    const approval = approvals.pending.find((item) => item.action === tool && item.path === targetPath);
    if (approval) return approval;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error(`Approval did not appear for ${tool}:${targetPath}`);
}

async function decideApproval(id, decision) {
  const response = await fetch(`${baseUrl}/admin/api/approvals/${encodeURIComponent(id)}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ decision })
  });
  if (!response.ok) throw new Error(`Approval decision returned HTTP ${response.status}`);
}

const project = "checkpoint-mcp-test";
const firstPath = `${project}/first.txt`;
const secondPath = `${project}/nested/second.txt`;
const newPath = `${project}/created-after-${Date.now()}.txt`;
let checkpointId = null;

try {
  await client.connect(transport);
  const initialStatusResponse = await fetch(`${baseUrl}/admin/api/status`, { cache: "no-store" });
  const initialStatus = await initialStatusResponse.json();
  initialApprovalEnabled = initialStatus.approval.enabled;
  await setApprovalEnabled(false);
  const tools = await client.listTools();
  const toolNames = new Set(tools.tools.map((tool) => tool.name));
  for (const expected of ["checkpoint.read", "checkpoint.write"]) {
    if (!toolNames.has(expected)) throw new Error(`Missing checkpoint tool: ${expected}`);
  }

  const capabilitiesCall = await call("get_capabilities");
  const capabilities = JSON.parse(capabilitiesCall.text);
  if (capabilities.server.version !== "0.8.0" || capabilities.features.checkpoint !== true) {
    throw new Error("Checkpoint capability was not advertised");
  }
  if (
    capabilities.actions["checkpoint.restore"]?.approvalProtected !== true
    || capabilities.actions["checkpoint.delete"]?.approvalProtected !== true
  ) {
    throw new Error("Checkpoint restore/delete approval classification is missing");
  }

  const baselineFiles = await Promise.all([
    safeFile(firstPath, "checkpoint-first\n"),
    safeFile(secondPath, "checkpoint-second\n")
  ]);
  const baseline = await call("write_files", { files: baselineFiles });
  if (baseline.result.isError) throw new Error(`Could not prepare checkpoint fixture: ${baseline.text}`);

  const created = await call("create_checkpoint", { label: "MCP checkpoint round trip" });
  if (created.result.isError) throw new Error(`create_checkpoint failed: ${created.text}`);
  checkpointId = JSON.parse(created.text).id;

  const mutations = await Promise.all([
    safeFile(firstPath, "mutated-first\n"),
    safeFile(secondPath, "mutated-second\n"),
    safeFile(newPath, "new-after-checkpoint\n")
  ]);
  const changed = await call("write_files", { files: mutations });
  if (changed.result.isError) throw new Error(`Could not mutate checkpoint fixture: ${changed.text}`);

  const restored = await call("restore_checkpoint", { checkpoint_id: checkpointId });
  if (restored.result.isError) throw new Error(`restore_checkpoint failed: ${restored.text}`);
  const restorePayload = JSON.parse(restored.text);
  if (restorePayload.rolledBack !== false || restorePayload.deletedFiles < 1) {
    throw new Error(`checkpoint.write(restore) did not report a committed restore and deleted file: ${restored.text}`);
  }

  const firstRead = await call("read_text_file", { path: firstPath });
  const secondRead = await call("read_text_file", { path: secondPath });
  if (firstRead.text !== "checkpoint-first\n" || secondRead.text !== "checkpoint-second\n") {
    throw new Error("MCP checkpoint restore did not recover baseline contents");
  }
  if ((await statPath(newPath)).exists) throw new Error("MCP checkpoint restore did not remove new file");

  const listed = await call("list_checkpoints");
  const listPayload = JSON.parse(listed.text);
  if (!listPayload.checkpoints.some((entry) => entry.id === checkpointId)) {
    throw new Error("list_checkpoints did not return MCP-created checkpoint");
  }

  const approvalMutation = await call("write_files", {
    files: [await safeFile(firstPath, "approval-approved-change\n")]
  });
  if (approvalMutation.result.isError) throw new Error(`Could not prepare approval restore: ${approvalMutation.text}`);
  await setApprovalEnabled(true);
  const approvedRestoreCall = call("restore_checkpoint", { checkpoint_id: checkpointId });
  const approval = await waitForApproval("checkpoint.restore", checkpointId);
  await decideApproval(approval.id, "approve");
  const approvedRestore = await approvedRestoreCall;
  if (approvedRestore.result.isError || (await call("read_text_file", { path: firstPath })).text !== "checkpoint-first\n") {
    throw new Error("Approved checkpoint restore did not execute");
  }

  await setApprovalEnabled(false);
  const denialMutation = await call("write_files", {
    files: [await safeFile(firstPath, "approval-denied-change\n")]
  });
  if (denialMutation.result.isError) throw new Error(`Could not prepare denied restore: ${denialMutation.text}`);
  await setApprovalEnabled(true);
  const deniedRestoreCall = call("restore_checkpoint", { checkpoint_id: checkpointId });
  const denial = await waitForApproval("checkpoint.restore", checkpointId);
  await decideApproval(denial.id, "deny");
  const deniedRestore = await deniedRestoreCall;
  if (!deniedRestore.result.isError) throw new Error("Denied checkpoint restore unexpectedly executed");
  if ((await call("read_text_file", { path: firstPath })).text !== "approval-denied-change\n") {
    throw new Error("Denied checkpoint restore changed workspace content");
  }

  await setApprovalEnabled(false);
  const finalRestore = await call("restore_checkpoint", { checkpoint_id: checkpointId });
  if (finalRestore.result.isError) throw new Error(`Final fixture restore failed: ${finalRestore.text}`);

  const deleted = await call("delete_checkpoint", { checkpoint_id: checkpointId });
  if (deleted.result.isError || JSON.parse(deleted.text).deleted !== true) {
    throw new Error(`delete_checkpoint failed: ${deleted.text}`);
  }
  checkpointId = null;

  const logsResponse = await fetch(`${baseUrl}/admin/api/logs?limit=100`, { cache: "no-store" });
  const logs = await logsResponse.json();
  for (const tool of ["checkpoint.create", "checkpoint.restore", "checkpoint.delete"]) {
    if (!logs.events.some((event) => event.tool === tool && event.status === "success")) {
      throw new Error(`Checkpoint audit event missing for ${tool}`);
    }
  }

  console.log("PASS: MCP exposes create/list/restore/delete checkpoint tools");
  console.log("PASS: non-Git checkpoint round trip restores files and removes later files");
  console.log("PASS: checkpoint operations expose safe metadata and audit events");
  console.log("PASS: restore and delete are classified as approval-protected operations");
  console.log("PASS: restore pauses for Dashboard approval and denial leaves files unchanged");
} finally {
  await setApprovalEnabled(false).catch(() => {});
  if (checkpointId) await call("delete_checkpoint", { checkpoint_id: checkpointId }).catch(() => {});
  await client.close().catch(() => {});
  await setApprovalEnabled(initialApprovalEnabled).catch(() => {});
}
