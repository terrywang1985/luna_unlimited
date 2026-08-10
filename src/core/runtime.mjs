import path from "node:path";
import { mkdir } from "node:fs/promises";

import { ApprovalManager } from "./approval.mjs";
import { ArtifactService } from "./artifacts.mjs";
import { AuditStore } from "./audit.mjs";
import { buildCapabilities } from "./capabilities.mjs";
import { CheckpointService } from "./checkpoints.mjs";
import { CommandService } from "./commands.mjs";
import { auditContext, createWorkSessionContext } from "./context.mjs";
import { CoreErrorCode, coreError, normalizeCoreError } from "./errors.mjs";
import { FileService } from "./files.mjs";
import { FileOperationsService } from "./file-operations.mjs";
import { FileMutationQueue } from "./mutation-queue.mjs";
import { PatchService } from "./patch.mjs";
import { PolicyService } from "./policy.mjs";
import { SearchService } from "./search.mjs";
import { WorkspaceService } from "./workspace.mjs";

export class LunaCore {
  constructor({
    workspaceRoot,
    logsDir,
    maxFileBytes,
    maxBatchBytes = maxFileBytes * 8,
    maxCommandOutputBytes,
    checkpointRoot,
    maxCheckpointFiles = 5000,
    maxCheckpointBytes = 128 * 1024 * 1024,
    maxCheckpoints = 20,
    maxArtifactBytes = 25 * 1024 * 1024,
    maxOperationEntries = 10000,
    maxAuditEntries = 500
  }) {
    this.workspace = new WorkspaceService(workspaceRoot);
    this.limits = {
      maxFileBytes,
      maxBatchBytes,
      maxCommandOutputBytes,
      maxCheckpointFiles,
      maxCheckpointBytes,
      maxCheckpoints,
      maxArtifactBytes,
      maxOperationEntries
    };
    this.policy = new PolicyService();
    this.approvals = new ApprovalManager({ policy: this.policy });
    this.audit = new AuditStore({ auditLogPath: path.join(logsDir, "audit.jsonl"), maxEntries: maxAuditEntries });
    this.mutations = new FileMutationQueue();
    this.files = new FileService({
      workspace: this.workspace,
      mutations: this.mutations,
      maxFileBytes,
      maxBatchBytes,
      maxCommandOutputBytes
    });
    this.fileOperations = new FileOperationsService({
      workspace: this.workspace,
      mutations: this.mutations,
      maxOperationEntries
    });
    this.artifacts = new ArtifactService({
      workspace: this.workspace,
      mutations: this.mutations,
      maxArtifactBytes
    });
    this.search = new SearchService({ workspace: this.workspace, maxCommandOutputBytes });
    this.patch = new PatchService({
      workspace: this.workspace,
      mutations: this.mutations,
      maxFileBytes,
      maxBatchBytes
    });
    this.commands = new CommandService({ workspace: this.workspace, mutations: this.mutations, maxCommandOutputBytes });
    this.checkpoints = new CheckpointService({
      workspace: this.workspace,
      mutations: this.mutations,
      checkpointRoot,
      excludedPaths: [logsDir],
      maxCheckpointFiles,
      maxCheckpointBytes,
      maxCheckpoints
    });

    this.toolHandlers = {
      get_capabilities: (request) => this.getCapabilities(request),
      list_directory: (request) => this.files.listDirectory(request),
      stat_path: (request) => this.files.statPath(request),
      read_text_file: (request) => this.files.readTextFile(request),
      read_text_file_range: (request) => this.files.readTextFileRange(request),
      search_files: (request) => this.search.searchFiles(request),
      write_text_file: (request) => this.files.writeTextFile(request),
      replace_text: (request) => this.files.replaceText(request),
      write_files: (request) => this.files.writeFiles(request),
      apply_patch: (request) => this.patch.apply(request),
      create_directory: (request) => this.fileOperations.createDirectory(request),
      move_path: (request) => this.fileOperations.movePath(request),
      delete_path: (request) => this.fileOperations.deletePath(request),
      inspect_artifact: (request) => this.artifacts.inspect(request),
      import_artifact: (request) => this.artifacts.import(request),
      export_artifact: (request) => this.artifacts.export(request),
      create_checkpoint: (request) => this.checkpoints.create(request),
      list_checkpoints: () => this.checkpoints.list(),
      restore_checkpoint: (request) => this.checkpoints.restore(request),
      delete_checkpoint: (request) => this.checkpoints.delete(request),
      exec_command: (request) => this.commands.execute(request),
      install_dependencies: (request) => this.commands.installDependencies(request)
    };
  }

  getCapabilities({ adapter = "unknown", protocolVersion = "unknown" } = {}) {
    const result = buildCapabilities({
      workspace: this.workspace,
      policy: this.policy,
      limits: this.limits,
      adapter,
      protocolVersion
    });
    return { text: JSON.stringify(result, null, 2), structured: result, details: { policyRevision: result.policy.revision } };
  }

  async initialize({ logsDir }) {
    await mkdir(this.workspace.root, { recursive: true });
    await mkdir(logsDir, { recursive: true });
    await this.checkpoints.initialize();
    await this.audit.initialize();
  }

  async execute(tool, request, inputContext = {}, approvalSummary = "") {
    const started = performance.now();
    const context = createWorkSessionContext(inputContext);
    const targetPath = request.path
      ?? request.destination
      ?? request.source
      ?? request.cwd
      ?? request.checkpointId
      ?? request.label
      ?? (Array.isArray(request.expectedFiles) ? request.expectedFiles.map((file) => file.path).join(", ").slice(0, 500) : undefined)
      ?? (Array.isArray(request.files) ? request.files.map((file) => file.path).join(", ").slice(0, 500) : ".");
    const handler = this.toolHandlers[tool];
    if (!handler) {
      return this.failure(coreError(CoreErrorCode.INVALID_ARGUMENT, `Unknown tool: ${tool}`));
    }

    if (!this.policy.isToolEnabled(tool)) {
      const error = coreError(CoreErrorCode.TOOL_DISABLED, `${tool} is disabled by the local permission policy`);
      const audit = this.audit.record({
        tool,
        path: targetPath,
        status: "denied",
        durationMs: Math.round(performance.now() - started),
        details: { reason: "Tool disabled in local permissions" },
        context: auditContext(context)
      });
      return this.failure(error, audit);
    }

    const approval = await this.approvals.request(tool, targetPath, approvalSummary);
    if (!approval.approved) {
      const error = coreError(CoreErrorCode.APPROVAL_DENIED, `${tool} was denied by the local approval policy`, {
        reason: approval.reason
      });
      const audit = this.audit.record({
        tool,
        path: targetPath,
        status: "denied",
        durationMs: Math.round(performance.now() - started),
        details: { reason: approval.reason },
        context: auditContext(context)
      });
      return this.failure(error, audit);
    }

    try {
      const data = await handler(request, context);
      const audit = this.audit.record({
        tool,
        path: targetPath,
        status: "success",
        durationMs: Math.round(performance.now() - started),
        details: data.details || {},
        context: auditContext(context)
      });
      return { ok: true, data, meta: { durationMs: audit.durationMs, auditId: audit.id } };
    } catch (rawError) {
      const error = normalizeCoreError(rawError);
      const audit = this.audit.record({
        tool,
        path: targetPath,
        status: "error",
        durationMs: Math.round(performance.now() - started),
        details: { error: error.message, errorCode: error.code, ...error.details },
        context: auditContext(context)
      });
      return this.failure(error, audit);
    }
  }

  failure(error, audit = null) {
    return {
      ok: false,
      error: { code: error.code, message: error.message, details: error.details || {} },
      meta: audit ? { durationMs: audit.durationMs, auditId: audit.id } : {}
    };
  }

  async readArtifactResource(token, inputContext = {}) {
    const started = performance.now();
    const context = createWorkSessionContext(inputContext);
    try {
      const data = await this.artifacts.readExportResource(token);
      const audit = this.audit.record({
        tool: "export_artifact.resource",
        path: data.path,
        status: "success",
        durationMs: Math.round(performance.now() - started),
        details: { bytes: data.bytes, sha256: data.sha256, mimeType: data.mimeType },
        context: auditContext(context)
      });
      return { ok: true, data, meta: { durationMs: audit.durationMs, auditId: audit.id } };
    } catch (rawError) {
      const error = normalizeCoreError(rawError);
      const audit = this.audit.record({
        tool: "export_artifact.resource",
        path: "artifact-export-token",
        status: "error",
        durationMs: Math.round(performance.now() - started),
        details: { error: error.message, errorCode: error.code },
        context: auditContext(context)
      });
      return this.failure(error, audit);
    }
  }

  setToolPermission(tool, enabled) {
    if (!this.policy.setToolEnabled(tool, enabled)) return null;
    this.audit.record({ tool: "admin.permission", path: tool, status: "success", details: { enabled } });
    return { name: tool, enabled: this.policy.isToolEnabled(tool) };
  }

  setApprovalEnabled(enabled) {
    this.policy.setApprovalEnabled(enabled);
    if (!enabled) this.approvals.disableAndDenyPending();
    this.audit.record({ tool: "admin.approval_policy", status: "success", details: { enabled } });
    return { enabled: this.policy.approvalEnabled };
  }

  decideApproval(id, decision) {
    const approval = this.approvals.get(id);
    if (!approval) return null;
    const approved = decision === "approve";
    this.approvals.finish(id, approved, approved ? "approved_in_dashboard" : "denied_in_dashboard");
    this.audit.record({
      tool: "admin.approval",
      path: approval.path,
      status: approved ? "success" : "denied",
      details: { approvalId: approval.id, targetTool: approval.tool, decision }
    });
    return { id: approval.id, decision };
  }

  adminStatus() {
    const policy = this.policy.snapshot();
    return {
      policy: {
        workspaceRoot: this.workspace.root,
        maxFileBytes: this.limits.maxFileBytes,
        maxBatchBytes: this.limits.maxBatchBytes,
        maxCommandOutputBytes: this.limits.maxCommandOutputBytes,
        absolutePaths: false,
        symbolicLinks: false,
        approvalMode: policy.approvalEnabled ? "approval-required" : "observe-only",
        approvalAvailable: true,
        approvalTimeoutSeconds: policy.approvalTimeoutSeconds,
        protectedTools: policy.protectedTools,
        checkpointBackend: this.checkpoints.backend,
        maxCheckpoints: this.limits.maxCheckpoints,
        maxCheckpointFiles: this.limits.maxCheckpointFiles,
        maxCheckpointBytes: this.limits.maxCheckpointBytes,
        maxArtifactBytes: this.limits.maxArtifactBytes,
        maxOperationEntries: this.limits.maxOperationEntries
      },
      permissions: this.policy.permissionRows(),
      approval: {
        enabled: policy.approvalEnabled,
        pendingCount: this.approvals.size,
        timeoutSeconds: policy.approvalTimeoutSeconds
      },
      counts: this.audit.counts()
    };
  }
}

export async function createLunaCore(options) {
  const core = new LunaCore(options);
  await core.initialize({ logsDir: options.logsDir });
  return core;
}
