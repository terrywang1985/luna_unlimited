import path from "node:path";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";

const baseUrl = process.env.MCP_TEST_BASE_URL || "http://127.0.0.1:18765";
const client = new Client({ name: "luna-artifact-mcp-test", version: "0.6.5" });
const transport = new StreamableHTTPClientTransport(new URL(`${baseUrl}/mcp`));
const project = `artifact-mcp-test-${process.pid}`;
const png = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=", "base64");

function toolText(result) {
  return result.content?.find((item) => item.type === "text")?.text || "";
}

async function call(name, args = {}) {
  const result = await client.callTool({ name, arguments: args });
  const text = toolText(result);
  let payload = result.structuredContent || null;
  if (!result.isError && payload === null) {
    try { payload = JSON.parse(text); } catch {}
  }
  return { result, text, payload };
}

async function setPermission(tool, enabled) {
  const response = await fetch(`${baseUrl}/admin/api/permissions/${tool}`, {
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
  if (!response.ok) throw new Error(`Approval policy returned HTTP ${response.status}`);
}

async function waitForApproval(tool, targetPath) {
  for (let attempt = 0; attempt < 60; attempt += 1) {
    const response = await fetch(`${baseUrl}/admin/api/approvals`, { cache: "no-store" });
    const approvals = await response.json();
    const match = approvals.pending.find((approval) => approval.tool === tool && approval.path === targetPath);
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

const statusResponse = await fetch(`${baseUrl}/admin/api/status`, { cache: "no-store" });
if (!statusResponse.ok) throw new Error(`Status API returned HTTP ${statusResponse.status}`);
const initialStatus = await statusResponse.json();
const workspaceRoot = path.resolve(initialStatus.policy.workspaceRoot);
const projectRoot = path.join(workspaceRoot, project);
if (!projectRoot.startsWith(`${workspaceRoot}${path.sep}`)) throw new Error("Unsafe artifact test path");
const initialApproval = initialStatus.approval.enabled;
const initialPermissions = Object.fromEntries(initialStatus.permissions.map((tool) => [tool.name, tool.enabled]));
let connected = false;

try {
  await setApprovalPolicy(false);
  await client.connect(transport);
  connected = true;

  const listed = await client.listTools();
  const tools = new Map(listed.tools.map((tool) => [tool.name, tool]));
  for (const name of ["create_directory", "move_path", "delete_path", "inspect_artifact", "import_artifact", "export_artifact"]) {
    if (!tools.has(name)) throw new Error(`Missing v0.6 tool: ${name}`);
  }
  const importTool = tools.get("import_artifact");
  if (JSON.stringify(importTool._meta?.["openai/fileParams"]) !== JSON.stringify(["file"])) {
    throw new Error("import_artifact must declare exactly one Host file rewrite path: file");
  }
  const fileSchema = importTool.inputSchema?.properties?.file;
  for (const property of ["download_url", "file_id", "mime_type", "file_name"]) {
    if (!fileSchema?.properties?.[property]) throw new Error(`File parameter schema is missing ${property}`);
  }
  if (!fileSchema.required?.includes("download_url") || !fileSchema.required?.includes("file_id")) {
    throw new Error("File parameter schema does not require download_url and file_id");
  }
  for (const requiredField of ["file", "destination", "expected_sha256"]) {
    if (!importTool.inputSchema?.required?.includes(requiredField)) {
      throw new Error(`import_artifact must require ${requiredField}`);
    }
  }

  const capabilities = (await call("get_capabilities")).payload;
  if (capabilities.server.version !== "0.6.5" || !capabilities.features.artifactTransfer
    || !capabilities.features.fileOperations || !capabilities.features.artifactHostFileInput) {
    throw new Error("v0.6 capabilities are not advertised");
  }

  const createdDirectory = await call("create_directory", { path: `${project}/nested` });
  if (createdDirectory.result.isError || !createdDirectory.payload.created) throw new Error(`create_directory failed: ${createdDirectory.text}`);
  const filePath = `${project}/nested/source.txt`;
  const write = await call("write_text_file", { path: filePath, content: "move-and-delete\n" });
  if (write.result.isError) throw new Error(`Could not create file-operation fixture: ${write.text}`);
  const stat = (await call("stat_path", { path: filePath })).payload;
  const movedPath = `${project}/moved.txt`;
  const moved = await call("move_path", {
    source: filePath,
    destination: movedPath,
    expected_sha256: stat.sha256
  });
  if (moved.result.isError || moved.payload.destination !== movedPath) throw new Error(`move_path failed: ${moved.text}`);
  const deleted = await call("delete_path", { path: movedPath, expected_sha256: stat.sha256 });
  if (deleted.result.isError || !deleted.payload.deleted) throw new Error(`delete_path failed: ${deleted.text}`);

  await mkdir(projectRoot, { recursive: true });
  const imagePath = path.join(projectRoot, "fixture.png");
  await writeFile(imagePath, png);
  const inspected = await call("inspect_artifact", { path: `${project}/fixture.png` });
  if (inspected.result.isError || inspected.payload.mimeType !== "image/png" || inspected.payload.image?.width !== 1) {
    throw new Error(`inspect_artifact failed: ${inspected.text}`);
  }

  const exported = await call("export_artifact", { path: `${project}/fixture.png` });
  if (exported.result.isError) throw new Error(`export_artifact failed: ${exported.text}`);
  const resourceLink = exported.result.content?.find((item) => item.type === "resource_link");
  if (!resourceLink || resourceLink.mimeType !== "image/png") throw new Error("export_artifact did not return an MCP resource_link");
  const resource = await client.readResource({ uri: resourceLink.uri });
  const blob = resource.contents?.[0]?.blob;
  if (!blob || !Buffer.from(blob, "base64").equals(png)) throw new Error("Exported MCP resource bytes did not match the workspace artifact");

  await setPermission("import_artifact", false);
  const deniedImport = await call("import_artifact", {
    file: {
      download_url: "https://127.0.0.1/not-allowed.png",
      file_id: "file_denied",
      mime_type: "image/png",
      file_name: "not-allowed.png"
    },
    destination: `${project}/denied.png`,
    expected_sha256: null
  });
  if (!deniedImport.result.isError) throw new Error("Disabled import_artifact was not denied");
  await setPermission("import_artifact", true);
  const blockedImport = await call("import_artifact", {
    file: {
      download_url: "https://127.0.0.1/not-allowed.png",
      file_id: "file_private",
      mime_type: "image/png",
      file_name: "not-allowed.png"
    },
    destination: `${project}/private.png`,
    expected_sha256: null
  });
  if (!blockedImport.result.isError) throw new Error("Private-network artifact source was not rejected");

  const approvePath = `${project}/approval-delete.txt`;
  const denyPath = `${project}/denial-delete.txt`;
  await call("write_text_file", { path: approvePath, content: "approve\n" });
  await call("write_text_file", { path: denyPath, content: "deny\n" });
  const approveStat = (await call("stat_path", { path: approvePath })).payload;
  const denyStat = (await call("stat_path", { path: denyPath })).payload;
  await setApprovalPolicy(true);

  const approvedCall = call("delete_path", { path: approvePath, expected_sha256: approveStat.sha256 });
  const approval = await waitForApproval("delete_path", approvePath);
  await decideApproval(approval.id, "approve");
  const approved = await approvedCall;
  if (approved.result.isError) throw new Error("Approved delete_path did not execute");

  const deniedCall = call("delete_path", { path: denyPath, expected_sha256: denyStat.sha256 });
  const denial = await waitForApproval("delete_path", denyPath);
  await decideApproval(denial.id, "deny");
  const denied = await deniedCall;
  if (!denied.result.isError || !(await readFile(path.join(projectRoot, "denial-delete.txt"), "utf8"))) {
    throw new Error("Denied delete_path changed the workspace");
  }

  console.log("PASS: MCP exposes six v0.6.5 file-operation and artifact tools");
  console.log("PASS: import_artifact publishes one exact Host mount rewrite path with the complete file schema");
  console.log("PASS: create/move/delete round trip enforces file revisions");
  console.log("PASS: binary inspection and MCP resource-link export preserve exact image bytes");
  console.log("PASS: import permission and private-network source policy fail closed");
  console.log("PASS: Dashboard approval can approve or deny protected delete_path calls");
} finally {
  await setApprovalPolicy(false).catch(() => {});
  if (connected) {
    const denialFile = `${project}/denial-delete.txt`;
    const denialStat = await call("stat_path", { path: denialFile }).catch(() => null);
    if (denialStat?.payload?.exists) {
      await call("delete_path", { path: denialFile, expected_sha256: denialStat.payload.sha256 }).catch(() => {});
    }
    await client.close().catch(() => {});
  }
  for (const [tool, enabled] of Object.entries(initialPermissions)) {
    if (tool === "import_artifact") await setPermission(tool, enabled).catch(() => {});
  }
  await setApprovalPolicy(initialApproval).catch(() => {});
  await rm(projectRoot, { recursive: true, force: true }).catch(() => {});
}
