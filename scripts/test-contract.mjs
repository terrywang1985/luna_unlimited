import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";

const baseUrl = process.env.MCP_TEST_BASE_URL || "http://127.0.0.1:18765";
const endpoint = new URL(process.env.MCP_TEST_URL || `${baseUrl}/mcp`);
const client = new Client({ name: "luna-contract-lock", version: "0.1.0" });
const transport = new StreamableHTTPClientTransport(endpoint);

const expectedSchemas = {
  list_directory: { properties: ["path"], required: [] },
  read_text_file: { properties: ["path"], required: ["path"] },
  read_text_file_range: { properties: ["end_line", "path", "start_line"], required: ["end_line", "path", "start_line"] },
  search_files: { properties: ["glob", "max_results", "path", "query", "search_type"], required: ["query"] },
  write_text_file: { properties: ["content", "path"], required: ["content", "path"] },
  replace_text: { properties: ["expected_replacements", "new_text", "old_text", "path"], required: ["new_text", "old_text", "path"] },
  exec_command: { properties: ["args", "cwd", "program", "timeout_seconds"], required: ["args", "program"] }
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

async function setPermission(tool, enabled) {
  const response = await fetch(`${baseUrl}/admin/api/permissions/${encodeURIComponent(tool)}`, {
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

async function waitForApproval(tool, targetPath) {
  for (let attempt = 0; attempt < 50; attempt += 1) {
    const response = await fetch(`${baseUrl}/admin/api/approvals`, { cache: "no-store" });
    if (!response.ok) throw new Error(`Approval API returned HTTP ${response.status}`);
    const data = await response.json();
    const approval = data.pending.find((item) => item.tool === tool && item.path === targetPath);
    if (approval) return approval;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error(`Approval request did not appear for ${tool}:${targetPath}`);
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
const initialWritePermission = initialStatus.permissions.find((item) => item.name === "write_text_file")?.enabled ?? true;
const initialApprovalEnabled = initialStatus.approval.enabled;

try {
  await setPermission("write_text_file", true);
  await setApprovalPolicy(false);
  await client.connect(transport);

  const tools = await client.listTools();
  const byName = new Map(tools.tools.map((tool) => [tool.name, tool]));

  for (const [name, contract] of Object.entries(expectedSchemas)) {
    const tool = byName.get(name);
    if (!tool) throw new Error(`Missing locked tool: ${name}`);
    const schema = tool.inputSchema || {};
    assertEqual(sorted(Object.keys(schema.properties || {})), sorted(contract.properties), `${name} parameter fields changed`);
    assertEqual(sorted(schema.required || []), sorted(contract.required), `${name} required parameters changed`);
  }

  const listing = await client.callTool({ name: "list_directory", arguments: { path: "." } });
  if (listing.isError) throw new Error("list_directory unexpectedly failed");
  const listingText = toolText(listing);
  if (!listingText || (!listingText.includes("[file]") && !listingText.includes("[dir]"))) {
    throw new Error("list_directory text format changed");
  }

  const fixturePath = "contract-lock-test.txt";
  const marker = "alpha\ncontract-needle\nomega\n";
  const writeResult = await client.callTool({
    name: "write_text_file",
    arguments: { path: fixturePath, content: marker }
  });
  if (writeResult.isError || !toolText(writeResult).startsWith("Wrote ")) {
    throw new Error("write_text_file success contract changed");
  }

  const readResult = await client.callTool({ name: "read_text_file", arguments: { path: fixturePath } });
  if (readResult.isError || toolText(readResult) !== marker) throw new Error("read_text_file round-trip contract changed");
  if (readResult.structuredContent?.text !== marker) {
    throw new Error("read_text_file structured result lost the file text");
  }
  for (const field of ["path", "text", "bytes", "mtime", "sha256"]) {
    if (!(field in (readResult.structuredContent || {}))) {
      throw new Error(`read_text_file structured result lost field: ${field}`);
    }
  }

  const rangeResult = await client.callTool({
    name: "read_text_file_range",
    arguments: { path: fixturePath, start_line: 2, end_line: 3 }
  });
  if (rangeResult.isError || toolText(rangeResult) !== "contract-needle\nomega") {
    throw new Error("read_text_file_range contract changed");
  }

  const searchResult = await client.callTool({
    name: "search_files",
    arguments: { query: "contract-needle", path: ".", glob: "*.txt", search_type: "content", max_results: 20 }
  });
  if (searchResult.isError || !toolText(searchResult).includes(fixturePath)) {
    throw new Error("search_files content-search contract changed");
  }

  const replaceResult = await client.callTool({
    name: "replace_text",
    arguments: { path: fixturePath, old_text: "contract-needle", new_text: "contract-replaced", expected_replacements: 1 }
  });
  if (replaceResult.isError || !toolText(replaceResult).startsWith("Replaced 1 occurrence(s)")) {
    throw new Error("replace_text success contract changed");
  }

  const replaceMismatch = await client.callTool({
    name: "replace_text",
    arguments: { path: fixturePath, old_text: "missing-value", new_text: "no-write", expected_replacements: 1 }
  });
  if (!replaceMismatch.isError) throw new Error("replace_text mismatch must remain an MCP error");

  const traversal = await client.callTool({ name: "read_text_file", arguments: { path: "../outside.txt" } });
  if (!traversal.isError) throw new Error("Path traversal must remain blocked");

  const sensitive = await client.callTool({ name: "read_text_file", arguments: { path: ".env" } });
  if (!sensitive.isError) throw new Error("Sensitive path reads must remain blocked");

  const execResult = await client.callTool({
    name: "exec_command",
    arguments: { program: "git", args: ["status", "--short"], cwd: ".", timeout_seconds: 15 }
  });
  if (execResult.isError) throw new Error("Allowlisted exec_command unexpectedly became an MCP error");
  const execPayload = JSON.parse(toolText(execResult));
  for (const field of ["command", "cwd", "exit_code", "stdout", "stderr", "timed_out", "stdout_truncated", "stderr_truncated"]) {
    if (!(field in execPayload)) throw new Error(`exec_command response lost field: ${field}`);
  }

  const blockedExec = await client.callTool({
    name: "exec_command",
    arguments: { program: "git", args: ["-c", "core.pager=cat", "status"], cwd: ".", timeout_seconds: 15 }
  });
  if (!blockedExec.isError) throw new Error("Non-whitelisted command invocation must remain blocked");

  await setPermission("write_text_file", false);
  const disabledWrite = await client.callTool({
    name: "write_text_file",
    arguments: { path: "contract-permission-denied.txt", content: "must not be written" }
  });
  if (!disabledWrite.isError) throw new Error("Disabled tool must return an MCP error");

  const logsResponse = await fetch(`${baseUrl}/admin/api/logs?limit=100`, { cache: "no-store" });
  if (!logsResponse.ok) throw new Error(`Logs API returned HTTP ${logsResponse.status}`);
  const logs = await logsResponse.json();
  const permissionAudit = logs.events.some(
    (event) => event.tool === "write_text_file" && event.path === "contract-permission-denied.txt" && event.status === "denied"
  );
  if (!permissionAudit) throw new Error("Permission denial audit contract changed");

  await setPermission("write_text_file", true);
  await setApprovalPolicy(true);

  const approvedPath = "contract-approval-approved.txt";
  const approvedCall = client.callTool({
    name: "write_text_file",
    arguments: { path: approvedPath, content: "approved" }
  });
  const approval = await waitForApproval("write_text_file", approvedPath);
  await decideApproval(approval.id, "approve");
  const approvedResult = await approvedCall;
  if (approvedResult.isError) throw new Error("Approved write must execute successfully");

  const deniedPath = "contract-approval-denied.txt";
  const deniedCall = client.callTool({
    name: "write_text_file",
    arguments: { path: deniedPath, content: "denied" }
  });
  const denial = await waitForApproval("write_text_file", deniedPath);
  await decideApproval(denial.id, "deny");
  const deniedResult = await deniedCall;
  if (!deniedResult.isError) throw new Error("Denied approval must return an MCP error");

  console.log("PASS: existing seven tool names and parameter contracts are locked");
  console.log("PASS: read/write/range/search/replace success contracts are locked");
  console.log("PASS: traversal, sensitive-path, replace-mismatch, and command-policy errors are locked");
  console.log("PASS: exec_command structured response fields are locked");
  console.log("PASS: permission denial and audit behavior are locked");
  console.log("PASS: approval pause/approve/deny behavior is locked");
} finally {
  try {
    await setApprovalPolicy(initialApprovalEnabled);
  } catch {}
  try {
    await setPermission("write_text_file", initialWritePermission);
  } catch {}
  await client.close().catch(() => {});
}
