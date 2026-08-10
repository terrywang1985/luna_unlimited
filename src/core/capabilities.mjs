import path from "node:path";

export function buildCapabilities({ workspace, policy, limits, adapter = "unknown", protocolVersion = "unknown" }) {
  const snapshot = policy.snapshot();
  const tools = Object.fromEntries(policy.permissionRows().map((tool) => [
    tool.name,
    {
      enabled: tool.enabled,
      requiresApproval: policy.requiresApproval(tool.name),
      approvalProtected: policy.protectedTools.has(tool.name),
      level: tool.level
    }
  ]));

  return {
    server: { name: "luna-unlimited", version: "0.6.4" },
    protocol: { adapter, version: protocolVersion },
    workspace: { rootName: path.basename(workspace.root), writable: true },
    features: {
      read: true,
      search: true,
      stat: true,
      revision: true,
      batchWrite: true,
      exec: true,
      dependencyInstall: true,
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
      maxOperationEntries: limits.maxOperationEntries
    },
    policy: {
      version: snapshot.version,
      revision: snapshot.revision,
      approvalEnabled: snapshot.approvalEnabled,
      networkMode: "dependency-install-and-authorized-artifact-import"
    }
  };
}
