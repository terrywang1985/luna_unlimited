import path from "node:path";
import { publicToolSummary } from "./actions.mjs";

export function buildCapabilities({ workspace, policy, limits, execution, adapter = "unknown", protocolVersion = "unknown" }) {
  const snapshot = policy.snapshot();
  const tools = publicToolSummary(policy);
  const actions = Object.fromEntries(policy.actionRows().map((action) => [
    action.id,
    {
      enabled: action.enabled,
      requiresApproval: policy.requiresApproval(action.id),
      approvalProtected: policy.protectedActions.has(action.id),
      level: action.level,
      tool: action.publicTool,
      operation: action.operation
    }
  ]));

  return {
    server: { name: "luna-unlimited", version: "0.8.0" },
    protocol: { adapter, version: protocolVersion },
    workspace: { rootName: path.basename(workspace.root), writable: true },
    features: {
      read: true,
      search: true,
      stat: true,
      revision: true,
      batchWrite: true,
      exec: true,
      systemExecution: execution.profile !== "restricted",
      rootExecution: execution.root && ["container-root", "host-root"].includes(execution.profile),
      dependencyInstall: true,
      publicRepositoryClone: true,
      commandProjectBoundary: true,
      patch: true,
      fileOperations: true,
      artifactTransfer: true,
      artifactImport: true,
      artifactHostFileInput: adapter === "mcp",
      artifactExport: true,
      binaryInspect: true,
      process: false,
      checkpoint: true,
      checkpointBackend: "local-snapshot"
    },
    tools,
    actions,
    limits: {
      maxFileBytes: limits.maxFileBytes,
      maxBatchBytes: limits.maxBatchBytes,
      maxCommandOutputBytes: limits.maxCommandOutputBytes,
      maxCommandSeconds: 300,
      maxBatchFiles: 50,
      maxCheckpoints: limits.maxCheckpoints,
      maxCheckpointFiles: limits.maxCheckpointFiles,
      maxCheckpointBytes: limits.maxCheckpointBytes,
      maxArtifactBytes: limits.maxArtifactBytes,
      maxOperationEntries: limits.maxOperationEntries,
      maxRepositoryFiles: limits.maxOperationEntries,
      maxRepositoryBytes: limits.maxCheckpointBytes
    },
    execution: {
      profile: execution.profile,
      platform: execution.platform,
      effectiveUid: execution.uid,
      container: execution.container,
      root: execution.root,
      requiresLocalApproval: true
    },
    policy: {
      version: snapshot.version,
      revision: snapshot.revision,
      approvalEnabled: snapshot.approvalEnabled,
      networkMode: "public-github-clone-dependency-install-and-authorized-artifact-import"
    }
  };
}
