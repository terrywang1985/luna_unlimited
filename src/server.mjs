import path from "node:path";
import { fileURLToPath } from "node:url";

import { registerAdminRoutes } from "./adapters/http-admin.mjs";
import { createMcpApp } from "./adapters/mcp.mjs";
import { createLunaCore } from "./core/runtime.mjs";

const moduleDir = path.dirname(fileURLToPath(import.meta.url));
const projectDir = path.resolve(moduleDir, "..");
const workspaceRoot = path.resolve(process.env.MCP_WORKSPACE_ROOT || path.join(projectDir, "workspace"));
const port = Number.parseInt(process.env.MCP_PORT || "18765", 10);
const host = process.env.MCP_HOST || "127.0.0.1";
const maxFileBytes = Number.parseInt(process.env.MCP_MAX_FILE_BYTES || String(1024 * 1024), 10);
const maxBatchBytes = Number.parseInt(process.env.MCP_MAX_BATCH_BYTES || String(8 * 1024 * 1024), 10);
const maxCommandOutputBytes = Number.parseInt(process.env.MCP_MAX_COMMAND_OUTPUT_BYTES || String(256 * 1024), 10);
const logsDir = path.join(projectDir, "logs");
const adminPagePath = path.join(projectDir, "public", "admin.html");
const startedAt = new Date();

if (!Number.isInteger(port) || port < 1 || port > 65535) {
  throw new Error("MCP_PORT must be an integer between 1 and 65535");
}
if (!Number.isInteger(maxFileBytes) || maxFileBytes < 1) {
  throw new Error("MCP_MAX_FILE_BYTES must be a positive integer");
}
if (!Number.isInteger(maxBatchBytes) || maxBatchBytes < maxFileBytes) {
  throw new Error("MCP_MAX_BATCH_BYTES must be an integer greater than or equal to MCP_MAX_FILE_BYTES");
}
if (!Number.isInteger(maxCommandOutputBytes) || maxCommandOutputBytes < 1024) {
  throw new Error("MCP_MAX_COMMAND_OUTPUT_BYTES must be at least 1024");
}

const core = await createLunaCore({
  workspaceRoot,
  logsDir,
  maxFileBytes,
  maxBatchBytes,
  maxCommandOutputBytes
});
const app = createMcpApp({ host, core });
registerAdminRoutes(app, { core, adminPagePath, logsDir, host, port, startedAt });

const httpServer = app.listen(port, host, (error) => {
  if (error) {
    console.error("Failed to start MCP server:", error);
    process.exitCode = 1;
    return;
  }
  console.log(`Luna Unlimited MCP listening at http://${host}:${port}/mcp`);
  console.log(`Workspace: ${workspaceRoot}`);
});

async function shutdown() {
  console.log("Shutting down MCP server...");
  await core.audit.flush();
  httpServer.close(() => process.exit(0));
}

process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);
