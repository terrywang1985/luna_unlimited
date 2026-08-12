import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";

const baseUrl = process.env.MCP_TEST_BASE_URL || "http://127.0.0.1:18765";
const client = new Client({ name: "luna-patch-mcp-test", version: "0.7.0" });
const transport = new StreamableHTTPClientTransport(new URL(`${baseUrl}/mcp`));
const project = `patch-mcp-test-${process.pid}`;

function toolText(result) {
  return result.content?.find((item) => item.type === "text")?.text || "";
}

async function call(name, args = {}) {
  const mapped = {
    get_capabilities: ["luna.capabilities", {}],
    stat_path: ["workspace.read", { request: { operation: "stat", ...args } }],
    read_text_file: ["workspace.read", { request: { operation: "text", ...args } }],
    write_files: ["workspace.write", { request: { operation: "many", ...args } }],
    apply_patch: ["code.patch", args]
  }[name] || [name, args];
  const result = await client.callTool({ name: mapped[0], arguments: mapped[1] });
  const text = toolText(result);
  let payload = result.structuredContent || null;
  if (!result.isError && payload === null) {
    try {
      payload = JSON.parse(text);
    } catch {}
  }
  return { result, text, payload };
}

async function setApprovalPolicy(enabled) {
  const response = await fetch(`${baseUrl}/admin/api/approval-policy`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ enabled })
  });
  if (!response.ok) throw new Error(`Approval policy returned HTTP ${response.status}`);
}

async function setPermission(enabled) {
  const response = await fetch(`${baseUrl}/admin/api/actions/code.apply_patch`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ enabled })
  });
  if (!response.ok) throw new Error(`apply_patch permission returned HTTP ${response.status}`);
}

async function waitForApproval(tool) {
  for (let attempt = 0; attempt < 60; attempt += 1) {
    const response = await fetch(`${baseUrl}/admin/api/approvals`, { cache: "no-store" });
    const approvals = await response.json();
    const match = approvals.pending.find((approval) => approval.action === tool);
    if (match) return match;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error(`Approval request did not appear for ${tool}`);
}

async function decideApproval(id, decision) {
  const response = await fetch(`${baseUrl}/admin/api/approvals/${id}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ decision })
  });
  if (!response.ok) throw new Error(`Approval decision returned HTTP ${response.status}`);
}

async function statPath(path) {
  const response = await call("stat_path", { path });
  if (response.result.isError) throw new Error(`stat_path failed: ${response.text}`);
  return response.payload;
}

const statusResponse = await fetch(`${baseUrl}/admin/api/status`, { cache: "no-store" });
if (!statusResponse.ok) throw new Error(`Status API returned HTTP ${statusResponse.status}`);
const initialStatus = await statusResponse.json();
const initialApproval = initialStatus.approval.enabled;
const initialPermission = initialStatus.actions.find((action) => action.id === "code.apply_patch")?.enabled === true;
let connected = false;

try {
  await setApprovalPolicy(false);
  await client.connect(transport);
  connected = true;

  const tools = new Set((await client.listTools()).tools.map((tool) => tool.name));
  if (!tools.has("code.patch")) throw new Error("MCP does not expose code.patch");

  const capabilities = (await call("get_capabilities")).payload;
  if (capabilities.server.version !== "0.7.0" || capabilities.features.patch !== true) {
    throw new Error("Patch capability/version is not advertised");
  }
  if (!capabilities.actions["code.apply_patch"]?.approvalProtected) throw new Error("code.apply_patch is not approval protected");

  await setPermission(false);
  const permissionDenied = await call("apply_patch", {
    patch: `--- /dev/null\n+++ b/${project}/permission-denied.txt\n@@ -0,0 +1 @@\n+blocked\n`,
    expected_files: [{ path: `${project}/permission-denied.txt`, sha256: null }]
  });
  if (!permissionDenied.result.isError || (await statPath(`${project}/permission-denied.txt`)).exists) {
    throw new Error("Disabled apply_patch permission did not block the MCP call");
  }
  await setPermission(true);

  const alphaPath = `${project}/alpha.txt`;
  const betaPath = `${project}/beta.txt`;
  const initial = await call("write_files", {
    files: [
      { path: alphaPath, content: "alpha\nbeta\n" },
      { path: betaPath, content: "temporary\n" }
    ]
  });
  if (initial.result.isError) throw new Error(`Could not create patch fixture: ${initial.text}`);
  const alphaStat = await statPath(alphaPath);
  const betaStat = await statPath(betaPath);

  const firstPatch = `--- a/${alphaPath}
+++ b/${alphaPath}
@@ -1,2 +1,2 @@
 alpha
-beta
+BETA
--- a/${betaPath}
+++ /dev/null
@@ -1 +0,0 @@
-temporary
--- /dev/null
+++ b/${project}/created.txt
@@ -0,0 +1 @@
+created-by-patch
`;
  const expectedFiles = [
    { path: alphaPath, sha256: alphaStat.sha256 },
    { path: betaPath, sha256: betaStat.sha256 },
    { path: `${project}/created.txt`, sha256: null }
  ];
  const preview = await call("apply_patch", { patch: firstPatch, expected_files: expectedFiles, dry_run: true });
  if (preview.result.isError || !preview.payload.dryRun || preview.payload.committed) {
    throw new Error(`apply_patch dry-run failed: ${preview.text}`);
  }
  if ((await call("read_text_file", { path: alphaPath })).text !== "alpha\nbeta\n") {
    throw new Error("Dry-run changed the workspace");
  }

  const committed = await call("apply_patch", { patch: firstPatch, expected_files: expectedFiles });
  if (committed.result.isError || !committed.payload.committed || committed.payload.files.length !== 3) {
    throw new Error(`apply_patch commit failed: ${committed.text}`);
  }
  if ((await call("read_text_file", { path: alphaPath })).text !== "alpha\nBETA\n") {
    throw new Error("MCP patch did not update the existing file");
  }
  if ((await statPath(betaPath)).exists || (await call("read_text_file", { path: `${project}/created.txt` })).text !== "created-by-patch\n") {
    throw new Error("MCP patch create/delete result is incorrect");
  }

  await setApprovalPolicy(true);
  const approvedStat = await statPath(alphaPath);
  const approvalPatch = `--- a/${alphaPath}\n+++ b/${alphaPath}\n@@ -2 +2 @@\n-BETA\n+approved\n`;
  const approvedCall = call("apply_patch", {
    patch: approvalPatch,
    expected_files: [{ path: alphaPath, sha256: approvedStat.sha256 }]
  });
  const approval = await waitForApproval("code.apply_patch");
  await decideApproval(approval.id, "approve");
  const approved = await approvedCall;
  if (approved.result.isError || (await call("read_text_file", { path: alphaPath })).text !== "alpha\napproved\n") {
    throw new Error("Approved apply_patch did not execute");
  }

  const deniedStat = await statPath(alphaPath);
  const denialPatch = `--- a/${alphaPath}\n+++ b/${alphaPath}\n@@ -2 +2 @@\n-approved\n+denied\n`;
  const deniedCall = call("apply_patch", {
    patch: denialPatch,
    expected_files: [{ path: alphaPath, sha256: deniedStat.sha256 }]
  });
  const denial = await waitForApproval("code.apply_patch");
  await decideApproval(denial.id, "deny");
  const denied = await deniedCall;
  if (!denied.result.isError || (await call("read_text_file", { path: alphaPath })).text !== "alpha\napproved\n") {
    throw new Error("Denied apply_patch changed workspace content");
  }

  await setApprovalPolicy(false);
  const finalAlpha = await statPath(alphaPath);
  const finalCreated = await statPath(`${project}/created.txt`);
  const cleanupPatch = `--- a/${alphaPath}
+++ /dev/null
@@ -1,2 +0,0 @@
-alpha
-approved
--- a/${project}/created.txt
+++ /dev/null
@@ -1 +0,0 @@
-created-by-patch
`;
  const cleanup = await call("apply_patch", {
    patch: cleanupPatch,
    expected_files: [
      { path: alphaPath, sha256: finalAlpha.sha256 },
      { path: `${project}/created.txt`, sha256: finalCreated.sha256 }
    ]
  });
  if (cleanup.result.isError) throw new Error(`Patch cleanup failed: ${cleanup.text}`);

  const logsResponse = await fetch(`${baseUrl}/admin/api/logs?limit=200`, { cache: "no-store" });
  const logs = await logsResponse.json();
  if (!logs.events.some((event) => event.tool === "code.apply_patch" && event.status === "success" && event.details.phase === "committed")) {
    throw new Error("Committed patch audit event is missing");
  }
  if (!logs.events.some((event) => event.tool === "code.apply_patch" && event.status === "denied")) {
    throw new Error("Denied patch audit event is missing");
  }

  console.log("PASS: MCP advertises v0.7.0 atomic code.patch capability");
  console.log("PASS: MCP dry-run and create/update/delete round trip succeeded");
  console.log("PASS: Dashboard approval can approve or deny apply_patch without bypassing Core policy");
  console.log("PASS: local permission disables apply_patch and committed/denied calls remain auditable");
} finally {
  await setApprovalPolicy(initialApproval).catch(() => {});
  await setPermission(initialPermission).catch(() => {});
  if (connected) await client.close().catch(() => {});
}
