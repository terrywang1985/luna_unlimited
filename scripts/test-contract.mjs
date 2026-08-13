import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";

const baseUrl = process.env.MCP_TEST_BASE_URL || "http://127.0.0.1:18765";
const endpoint = new URL(process.env.MCP_TEST_URL || `${baseUrl}/mcp`);
const client = new Client({ name: "luna-v080-contract", version: "0.8.0" });
const transport = new StreamableHTTPClientTransport(endpoint);

const expectedTools = [
  "artifact.import",
  "artifact.read",
  "checkpoint.read",
  "checkpoint.write",
  "code.patch",
  "git.read",
  "git.remote",
  "luna.capabilities",
  "project.dependencies",
  "project.execute",
  "system.execute",
  "workspace.manage",
  "workspace.read",
  "workspace.write"
];

const expectedOperations = {
  "workspace.read": ["list", "range", "search", "stat", "text"],
  "workspace.write": ["many", "mkdir", "replace", "text"],
  "workspace.manage": ["delete", "move"],
  "artifact.read": ["export", "inspect"],
  "checkpoint.write": ["create", "delete", "restore"],
  "git.read": ["diff", "log", "status"],
  "git.remote": ["clone"]
};

function toolText(result) {
  return result.content?.find((item) => item.type === "text")?.text || "";
}

function sorted(values = []) {
  return [...values].sort();
}

function assertEqual(actual, expected, message) {
  if (JSON.stringify(actual) !== JSON.stringify(expected)) {
    throw new Error(`${message}\nExpected: ${JSON.stringify(expected)}\nActual:   ${JSON.stringify(actual)}`);
  }
}

async function setAction(actionId, enabled) {
  const response = await fetch(`${baseUrl}/admin/api/actions/${encodeURIComponent(actionId)}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ enabled })
  });
  if (!response.ok) throw new Error(`Action API returned HTTP ${response.status}`);
}

async function setApprovalPolicy(enabled) {
  const response = await fetch(`${baseUrl}/admin/api/approval-policy`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ enabled })
  });
  if (!response.ok) throw new Error(`Approval policy API returned HTTP ${response.status}`);
}

async function waitForApproval(actionId, targetPath) {
  for (let attempt = 0; attempt < 50; attempt += 1) {
    const response = await fetch(`${baseUrl}/admin/api/approvals`, { cache: "no-store" });
    if (!response.ok) throw new Error(`Approval API returned HTTP ${response.status}`);
    const data = await response.json();
    const approval = data.pending.find((item) => item.action === actionId && item.path === targetPath);
    if (approval) return approval;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error(`Approval request did not appear for ${actionId}:${targetPath}`);
}

async function decideApproval(id, decision) {
  const response = await fetch(`${baseUrl}/admin/api/approvals/${encodeURIComponent(id)}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ decision })
  });
  if (!response.ok) throw new Error(`Approval decision returned HTTP ${response.status}`);
}

const initialStatusResponse = await fetch(`${baseUrl}/admin/api/status`, { cache: "no-store" });
if (!initialStatusResponse.ok) throw new Error(`Status API returned HTTP ${initialStatusResponse.status}`);
const initialStatus = await initialStatusResponse.json();
const initialWritePermission = initialStatus.actions.find((item) => item.id === "workspace.write_text")?.enabled ?? true;
const initialApprovalEnabled = initialStatus.approval.enabled;

try {
  await setAction("workspace.write_text", true);
  await setApprovalPolicy(false);
  await client.connect(transport);

  const tools = await client.listTools();
  const byName = new Map(tools.tools.map((tool) => [tool.name, tool]));
  assertEqual(sorted(byName.keys()), expectedTools, "Compact public MCP tool catalog changed");

  for (const [name, operations] of Object.entries(expectedOperations)) {
    const branches = byName.get(name)?.inputSchema?.properties?.request?.oneOf || [];
    const actual = branches.map((branch) => branch.properties?.operation?.const).filter(Boolean).sort();
    assertEqual(actual, operations, `${name} operation contract changed`);
  }
  if (byName.has("read_text_file") || byName.has("write_text_file") || byName.has("clone_repository")) {
    throw new Error("Legacy flat MCP tools must not be exposed in v0.8");
  }

  const capabilitiesResult = await client.callTool({ name: "luna.capabilities", arguments: {} });
  const capabilities = capabilitiesResult.structuredContent;
  if (capabilities?.server?.version !== "0.8.0" || Object.keys(capabilities.tools || {}).length !== 14) {
    throw new Error("Capability catalog did not describe the v0.8 compact tools");
  }
  if (!capabilities.actions?.["workspace.write_text"] || capabilities.workspace?.rootName?.includes(":\\")) {
    throw new Error("Capability action summary is incomplete or leaked an absolute workspace path");
  }

  const listing = await client.callTool({
    name: "workspace.read",
    arguments: { request: { operation: "list", path: "." } }
  });
  if (listing.isError || !toolText(listing)) throw new Error("workspace.read(list) failed");

  const fixturePath = "contract-v070.txt";
  const marker = "alpha\ncontract-needle\nomega\n";
  const writeResult = await client.callTool({
    name: "workspace.write",
    arguments: { request: { operation: "text", path: fixturePath, content: marker } }
  });
  if (writeResult.isError || !toolText(writeResult).startsWith("Wrote ")) {
    throw new Error("workspace.write(text) success contract changed");
  }

  const readResult = await client.callTool({
    name: "workspace.read",
    arguments: { request: { operation: "text", path: fixturePath } }
  });
  if (readResult.isError || toolText(readResult) !== marker || readResult.structuredContent?.text !== marker) {
    throw new Error("workspace.read(text) round trip changed");
  }
  for (const field of ["path", "text", "bytes", "mtime", "sha256"]) {
    if (!(field in (readResult.structuredContent || {}))) throw new Error(`Text read lost field: ${field}`);
  }

  const rangeResult = await client.callTool({
    name: "workspace.read",
    arguments: { request: { operation: "range", path: fixturePath, start_line: 2, end_line: 3 } }
  });
  if (rangeResult.isError || toolText(rangeResult) !== "contract-needle\nomega") {
    throw new Error("workspace.read(range) contract changed");
  }

  const searchResult = await client.callTool({
    name: "workspace.read",
    arguments: {
      request: {
        operation: "search",
        query: "contract-needle",
        path: ".",
        glob: "*.txt",
        search_type: "content",
        max_results: 20
      }
    }
  });
  if (searchResult.isError || !toolText(searchResult).includes(fixturePath)) {
    throw new Error("workspace.read(search) contract changed");
  }

  const replaceResult = await client.callTool({
    name: "workspace.write",
    arguments: {
      request: {
        operation: "replace",
        path: fixturePath,
        old_text: "contract-needle",
        new_text: "contract-replaced",
        expected_replacements: 1
      }
    }
  });
  if (replaceResult.isError || !toolText(replaceResult).startsWith("Replaced 1 occurrence(s)")) {
    throw new Error("workspace.write(replace) success contract changed");
  }

  const traversal = await client.callTool({
    name: "workspace.read",
    arguments: { request: { operation: "text", path: "../outside.txt" } }
  });
  if (!traversal.isError) throw new Error("Path traversal must remain blocked");

  const sensitive = await client.callTool({
    name: "workspace.read",
    arguments: { request: { operation: "text", path: ".env" } }
  });
  if (!sensitive.isError) throw new Error("Sensitive path reads must remain blocked");

  const gitResult = await client.callTool({
    name: "git.read",
    arguments: { request: { operation: "status", cwd: ".", format: "short", timeout_seconds: 15 } }
  });
  if (gitResult.isError) throw new Error("git.read(status) unexpectedly became an MCP error");
  const gitPayload = JSON.parse(toolText(gitResult));
  for (const field of ["command", "cwd", "exit_code", "stdout", "stderr", "timed_out"]) {
    if (!(field in gitPayload)) throw new Error(`Git result lost field: ${field}`);
  }

  let rejectedLegacyProgram = false;
  try {
    const result = await client.callTool({
      name: "project.execute",
      arguments: { program: "git", args: ["status"], cwd: ".", timeout_seconds: 15 }
    });
    rejectedLegacyProgram = result.isError === true;
  } catch {
    rejectedLegacyProgram = true;
  }
  if (!rejectedLegacyProgram) throw new Error("project.execute must reject Git; Git belongs to git.read");

  await setAction("workspace.write_text", false);
  const disabledWrite = await client.callTool({
    name: "workspace.write",
    arguments: { request: { operation: "text", path: "contract-denied.txt", content: "denied" } }
  });
  if (!disabledWrite.isError) throw new Error("Disabled action must return an MCP error");

  const logsResponse = await fetch(`${baseUrl}/admin/api/logs?limit=100`, { cache: "no-store" });
  const logs = await logsResponse.json();
  if (!logs.events.some((event) => event.tool === "workspace.write_text"
    && event.path === "contract-denied.txt" && event.status === "denied")) {
    throw new Error("Action permission denial audit contract changed");
  }

  await setAction("workspace.write_text", true);
  await setApprovalPolicy(true);
  const approvedPath = "contract-approved.txt";
  const approvedCall = client.callTool({
    name: "workspace.write",
    arguments: { request: { operation: "text", path: approvedPath, content: "approved" } }
  });
  const approval = await waitForApproval("workspace.write_text", approvedPath);
  await decideApproval(approval.id, "approve");
  if ((await approvedCall).isError) throw new Error("Approved action must execute");

  const deniedPath = "contract-approval-denied.txt";
  const deniedCall = client.callTool({
    name: "workspace.write",
    arguments: { request: { operation: "text", path: deniedPath, content: "denied" } }
  });
  const denial = await waitForApproval("workspace.write_text", deniedPath);
  await decideApproval(denial.id, "deny");
  if (!(await deniedCall).isError) throw new Error("Denied action must return an MCP error");

  console.log("PASS: v0.8 exposes exactly 14 compact domain tools and no legacy flat tools");
  console.log("PASS: nested oneOf operation schemas are visible through tools/list");
  console.log("PASS: read/write/search/Git behavior remains available through domain operations");
  console.log("PASS: action-level permission, approval, audit and path safety remain enforced");
} finally {
  try { await setApprovalPolicy(initialApprovalEnabled); } catch {}
  try { await setAction("workspace.write_text", initialWritePermission); } catch {}
  await client.close().catch(() => {});
}
