import path from "node:path";
import os from "node:os";
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
const maxCheckpointFiles = Number.parseInt(process.env.MCP_MAX_CHECKPOINT_FILES || "5000", 10);
const maxCheckpointBytes = Number.parseInt(process.env.MCP_MAX_CHECKPOINT_BYTES || String(128 * 1024 * 1024), 10);
const maxCheckpoints = Number.parseInt(process.env.MCP_MAX_CHECKPOINTS || "20", 10);
const maxArtifactBytes = Number.parseInt(process.env.MCP_MAX_ARTIFACT_BYTES || String(25 * 1024 * 1024), 10);
const maxOperationEntries = Number.parseInt(process.env.MCP_MAX_OPERATION_ENTRIES || "10000", 10);
const defaultStateDir = process.platform === "win32"
  ? path.join(process.env.LOCALAPPDATA || path.join(os.homedir(), "AppData", "Local"), "LunaUnlimited")
  : path.join(process.env.XDG_STATE_HOME || path.join(os.homedir(), ".local", "state"), "luna-unlimited");
const stateDir = path.resolve(process.env.LUNA_STATE_DIR || defaultStateDir);
const checkpointRoot = path.join(stateDir, "checkpoints");
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
if (!Number.isInteger(maxCheckpointFiles) || maxCheckpointFiles < 1) {
  throw new Error("MCP_MAX_CHECKPOINT_FILES must be a positive integer");
}
if (!Number.isInteger(maxCheckpointBytes) || maxCheckpointBytes < maxFileBytes) {
  throw new Error("MCP_MAX_CHECKPOINT_BYTES must be at least MCP_MAX_FILE_BYTES");
}
if (!Number.isInteger(maxCheckpoints) || maxCheckpoints < 1 || maxCheckpoints > 1000) {
  throw new Error("MCP_MAX_CHECKPOINTS must be between 1 and 1000");
}
if (!Number.isInteger(maxArtifactBytes) || maxArtifactBytes < 1024 || maxArtifactBytes > 256 * 1024 * 1024) {
  throw new Error("MCP_MAX_ARTIFACT_BYTES must be between 1024 and 268435456");
}
if (!Number.isInteger(maxOperationEntries) || maxOperationEntries < 1 || maxOperationEntries > 1000000) {
  throw new Error("MCP_MAX_OPERATION_ENTRIES must be between 1 and 1000000");
}

const core = await createLunaCore({
  workspaceRoot,
  logsDir,
  maxFileBytes,
  maxBatchBytes,
  maxCommandOutputBytes,
  checkpointRoot,
  maxCheckpointFiles,
  maxCheckpointBytes,
  maxCheckpoints,
  maxArtifactBytes,
  maxOperationEntries
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
