import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";

const baseUrl = process.env.MCP_TEST_BASE_URL || "http://127.0.0.1:18765";
const permissionUrl = `${baseUrl}/admin/api/actions/workspace.write_text`;

async function setWritePermission(enabled) {
  const response = await fetch(permissionUrl, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ enabled })
  });
  if (!response.ok) throw new Error(`Permission API returned HTTP ${response.status}`);
}

async function setApprovalPolicy(enabled) {
  const response = await fetch(`${baseUrl}/admin/api/approval-policy`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ enabled })
  });
  if (!response.ok) throw new Error(`Approval policy API returned HTTP ${response.status}`);
}

async function waitForApproval(action, targetPath) {
  for (let attempt = 0; attempt < 50; attempt += 1) {
    const response = await fetch(`${baseUrl}/admin/api/approvals`, { cache: "no-store" });
    const approvals = await response.json();
    const match = approvals.pending.find((approval) => approval.action === action && approval.path === targetPath);
    if (match) return match;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error("Approval request did not appear in the dashboard queue");
}

const statusResponse = await fetch(`${baseUrl}/admin/api/status`);
if (!statusResponse.ok) throw new Error(`Status API returned HTTP ${statusResponse.status}`);
const status = await statusResponse.json();
if (!status.server.ready) throw new Error("MCP server is not ready");

const client = new Client({ name: "luna-local-admin-test", version: "0.1.0" });
const transport = new StreamableHTTPClientTransport(new URL(`${baseUrl}/mcp`));

try {
  await setWritePermission(false);
  await client.connect(transport);
  const result = await client.callTool({
    name: "workspace.write",
    arguments: { request: { operation: "text", path: "permission-test.txt", content: "This write must be blocked." } }
  });
  if (!result.isError) throw new Error("Disabled write tool was not blocked");

  const logsResponse = await fetch(`${baseUrl}/admin/api/logs?limit=20`);
  const logs = await logsResponse.json();
  const denied = logs.events.some(
    (event) => event.tool === "workspace.write_text" && event.path === "permission-test.txt" && event.status === "denied"
  );
  if (!denied) throw new Error("Denied tool call was not present in the audit log");

  await setWritePermission(true);
  await setApprovalPolicy(true);
  const approvedPath = "approval-test.txt";
  const toolCall = client.callTool({
    name: "workspace.write",
    arguments: { request: { operation: "text", path: approvedPath, content: "Approved through the dashboard API." } }
  });
  const approval = await waitForApproval("workspace.write_text", approvedPath);
  const decisionResponse = await fetch(`${baseUrl}/admin/api/approvals/${approval.id}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ decision: "approve" })
  });
  if (!decisionResponse.ok) throw new Error("Approval decision failed");
  const approvedResult = await toolCall;
  if (approvedResult.isError) throw new Error("Approved tool call did not execute");

  console.log("PASS: dashboard status API is available");
  console.log("PASS: disabled write permission blocked the MCP call");
  console.log("PASS: denied call appeared in the audit log");
  console.log("PASS: approval queue paused and resumed a protected MCP call");
} finally {
  await setApprovalPolicy(false);
  await client.close();
  await setWritePermission(true);
}
