import { McpServer, ResourceTemplate } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { createMcpExpressApp } from "@modelcontextprotocol/sdk/server/express.js";
import { LATEST_PROTOCOL_VERSION } from "@modelcontextprotocol/sdk/types.js";
import { z } from "zod";

const relativePath = z.string().min(1).describe("Path relative to the authorized workspace");
const sha256 = z.string().regex(/^[a-f0-9]{64}$/i);
const checkpointId = z.string().regex(/^cp_\d{8}T\d{6}Z_[a-f0-9]{8}$/);

function toMcpResult(result) {
  if (result.ok) {
    const response = { content: [{ type: "text", text: result.data.text }] };
    if (result.data.structured) response.structuredContent = result.data.structured;
    return response;
  }
  return { content: [{ type: "text", text: result.error.message }], isError: true };
}

function action(core, actionId, request, context, summary = "") {
  return core.execute(actionId, request, context, summary).then(toMcpResult);
}

function gitStatusArgs(input) {
  const formatFlag = {
    short: "--short",
    porcelain_v1: "--porcelain=v1",
    porcelain_v2: "--porcelain=v2"
  }[input.format];
  return ["status", formatFlag, ...(input.branch ? ["--branch"] : [])];
}

function gitDiffArgs(input) {
  const args = ["diff"];
  if (input.cached) args.push("--cached");
  const formatFlag = {
    full: null,
    stat: "--stat",
    name_only: "--name-only",
    name_status: "--name-status"
  }[input.format];
  if (formatFlag) args.push(formatFlag);
  if (input.paths.length) args.push("--", ...input.paths);
  return args;
}

function gitLogArgs(input) {
  const args = ["log", `--max-count=${input.max_count}`];
  if (input.oneline) args.push("--oneline");
  if (input.decorate === "yes") args.push("--decorate");
  if (input.decorate === "no") args.push("--no-decorate");
  if (input.all) args.push("--all");
  return args;
}

function createMcpServer(core, context) {
  const server = new McpServer(
    { name: "luna-unlimited", version: "0.8.1" },
    {
      instructions:
        "Call luna.capabilities first. Tools are grouped by domain; select the operation field inside each domain tool. Use workspace.read(stat) before changing an existing file, code.patch for revision-protected code edits, artifact tools for binary files, and checkpoint.write(create) before risky refactors. system.execute is available only when the local owner explicitly selects an execution profile; it is destructive and requires Host confirmation, with optional additional local Dashboard approval."
    }
  );

  server.registerResource(
    "exported-workspace-artifact",
    new ResourceTemplate("luna-artifact://export/{token}", { list: undefined }),
    {
      title: "Authorized exported workspace artifact",
      description: "Short-lived content explicitly authorized through artifact.read(operation=export).",
      mimeType: "application/octet-stream"
    },
    async (uri, { token }) => {
      const result = await core.readArtifactResource(String(token), context);
      if (!result.ok) throw new Error(result.error.message);
      return {
        contents: [{ uri: uri.toString(), mimeType: result.data.mimeType, blob: result.data.blob }]
      };
    }
  );

  server.registerTool(
    "luna.capabilities",
    {
      title: "Discover Luna capabilities",
      description: "Return the compact public tool catalog, operation-level permissions, limits, safe workspace alias, and policy revision.",
      inputSchema: {},
      annotations: { readOnlyHint: true, openWorldHint: false, destructiveHint: false }
    },
    async () => action(core, "system.capabilities", {
      adapter: "mcp",
      protocolVersion: LATEST_PROTOCOL_VERSION
    }, context)
  );

  server.registerTool(
    "system.execute",
    {
      title: "Execute a locally approved system command",
      description: "Run one program with typed arguments under the locally selected user/container-root/host-root profile. This destructive tool requires Host confirmation; optional host-and-local mode adds a second Dashboard approval. Shell parsing is never implicit.",
      inputSchema: {
        operation: z.literal("run").default("run"),
        program: z.string().min(1).max(300),
        args: z.array(z.string().max(2000)).max(100).default([]),
        cwd: relativePath.default("."),
        timeout_seconds: z.number().int().min(1).max(900).default(120)
      },
      annotations: { readOnlyHint: false, openWorldHint: true, destructiveHint: true }
    },
    async ({ program, args, cwd, timeout_seconds }) => {
      const display = core.systemCommands.preview({ program, args });
      return action(core, "system.execute", {
        program,
        args,
        cwd,
        timeoutSeconds: timeout_seconds
      }, context, `SYSTEM COMMAND [${core.execution.profile}]\n${display}\ncwd: ${cwd}\nApproval mode: ${core.execution.approvalMode}.`);
    }
  );

  server.registerTool(
    "workspace.read",
    {
      title: "Read and inspect the workspace",
      description: "Perform one read-only workspace operation: list, stat, text, range, or search. Use stat to obtain the SHA-256 revision before writes.",
      inputSchema: { request: z.discriminatedUnion("operation", [
        z.object({ operation: z.literal("list"), path: relativePath.default(".") }),
        z.object({ operation: z.literal("stat"), path: relativePath }),
        z.object({ operation: z.literal("text"), path: relativePath }),
        z.object({
          operation: z.literal("range"),
          path: relativePath,
          start_line: z.number().int().min(1),
          end_line: z.number().int().min(1)
        }),
        z.object({
          operation: z.literal("search"),
          query: z.string().min(1).max(500),
          path: relativePath.default("."),
          glob: z.string().max(200).optional(),
          search_type: z.enum(["content", "filename"]).default("content"),
          max_results: z.number().int().min(1).max(200).default(100)
        })
      ]) },
      annotations: { readOnlyHint: true, openWorldHint: false, destructiveHint: false }
    },
    async ({ request: input }) => {
      if (input.operation === "list") return action(core, "workspace.list", { path: input.path }, context);
      if (input.operation === "stat") return action(core, "workspace.stat", { path: input.path }, context);
      if (input.operation === "text") return action(core, "workspace.read_text", { path: input.path }, context);
      if (input.operation === "range") {
        return action(core, "workspace.read_range", {
          path: input.path,
          startLine: input.start_line,
          endLine: input.end_line
        }, context);
      }
      return action(core, "workspace.search", {
        query: input.query,
        path: input.path,
        glob: input.glob,
        searchType: input.search_type,
        maxResults: input.max_results
      }, context);
    }
  );

  server.registerTool(
    "workspace.write",
    {
      title: "Create and update workspace text",
      description: "Perform one non-destructive text operation: text, replace, many, or mkdir. Existing files in many require SHA-256 revisions.",
      inputSchema: { request: z.discriminatedUnion("operation", [
        z.object({ operation: z.literal("text"), path: relativePath, content: z.string() }),
        z.object({
          operation: z.literal("replace"),
          path: relativePath,
          old_text: z.string().min(1),
          new_text: z.string(),
          expected_replacements: z.number().int().min(1).max(100).default(1)
        }),
        z.object({
          operation: z.literal("many"),
          files: z.array(z.object({
            path: relativePath,
            content: z.string(),
            expected_sha256: sha256.optional()
          })).min(1).max(50)
        }),
        z.object({ operation: z.literal("mkdir"), path: relativePath })
      ]) },
      annotations: { readOnlyHint: false, openWorldHint: false, destructiveHint: false }
    },
    async ({ request: input }) => {
      if (input.operation === "text") {
        return action(core, "workspace.write_text", { path: input.path, content: input.content }, context,
          `Write ${Buffer.byteLength(input.content, "utf8")} bytes to ${input.path}`);
      }
      if (input.operation === "replace") {
        return action(core, "workspace.replace_text", {
          path: input.path,
          oldText: input.old_text,
          newText: input.new_text,
          expectedReplacements: input.expected_replacements
        }, context, `Replace ${input.expected_replacements} occurrence(s) in ${input.path}`);
      }
      if (input.operation === "many") {
        return action(core, "workspace.write_many", {
          files: input.files.map((file) => ({
            path: file.path,
            content: file.content,
            expectedSha256: file.expected_sha256
          }))
        }, context, `Create or safely update ${input.files.length} file(s)`);
      }
      return action(core, "workspace.mkdir", { path: input.path }, context, `Create directory ${input.path}`);
    }
  );

  server.registerTool(
    "workspace.manage",
    {
      title: "Move or delete workspace paths",
      description: "Perform a destructive path operation: move or delete. Files require current SHA-256 revisions; sensitive paths and symlinks are rejected.",
      inputSchema: { request: z.discriminatedUnion("operation", [
        z.object({
          operation: z.literal("move"),
          source: relativePath,
          destination: relativePath,
          overwrite: z.boolean().default(false),
          expected_sha256: sha256.optional(),
          expected_destination_sha256: sha256.optional()
        }),
        z.object({
          operation: z.literal("delete"),
          path: relativePath,
          recursive: z.boolean().default(false),
          expected_sha256: sha256.optional()
        })
      ]) },
      annotations: { readOnlyHint: false, openWorldHint: false, destructiveHint: true }
    },
    async ({ request: input }) => {
      if (input.operation === "move") {
        return action(core, "workspace.move", {
          source: input.source,
          destination: input.destination,
          overwrite: input.overwrite,
          expectedSha256: input.expected_sha256,
          expectedDestinationSha256: input.expected_destination_sha256
        }, context, `Move ${input.source} to ${input.destination}${input.overwrite ? " with overwrite" : ""}`);
      }
      return action(core, "workspace.delete", {
        path: input.path,
        recursive: input.recursive,
        expectedSha256: input.expected_sha256
      }, context, `Permanently delete ${input.path}${input.recursive ? " recursively" : ""}`);
    }
  );

  server.registerTool(
    "code.patch",
    {
      title: "Apply an atomic code patch",
      description: "Dry-run or atomically apply a revision-protected code patch with explicit SHA-256 expectations and rollback on commit failure. Prefer *** Begin Patch with Add/Update/Delete File because it avoids fragile manual hunk line counts; standard unified diff (---/+++/@@) is also accepted.",
      inputSchema: {
        patch: z.string().min(1),
        expected_files: z.array(z.object({ path: relativePath, sha256: sha256.nullable() })).min(1).max(50),
        dry_run: z.boolean().default(false)
      },
      annotations: { readOnlyHint: false, openWorldHint: false, destructiveHint: true }
    },
    async ({ patch, expected_files, dry_run }) => action(core, "code.apply_patch", {
      patch,
      expectedFiles: expected_files.map((file) => ({ path: file.path, sha256: file.sha256 })),
      dryRun: dry_run
    }, context, `${dry_run ? "Dry-run" : "Apply"} atomic patch touching ${expected_files.length} file(s)`)
  );

  server.registerTool(
    "artifact.read",
    {
      title: "Inspect or export an artifact",
      description: "Inspect binary metadata or export a revision-bound workspace file to the connected Host.",
      inputSchema: { request: z.discriminatedUnion("operation", [
        z.object({ operation: z.literal("inspect"), path: relativePath }),
        z.object({ operation: z.literal("export"), path: relativePath })
      ]) },
      annotations: { readOnlyHint: true, openWorldHint: false, destructiveHint: false }
    },
    async ({ request: input }) => {
      if (input.operation === "inspect") return action(core, "artifact.inspect", { path: input.path }, context);
      const result = await core.execute("artifact.export", { path: input.path }, context, `Export ${input.path}`);
      const response = toMcpResult(result);
      if (result.ok) {
        response.content.push({
          type: "resource_link",
          uri: result.data.structured.resourceUri,
          name: result.data.structured.name,
          description: `Exported workspace artifact ${result.data.structured.path}`,
          mimeType: result.data.structured.mimeType,
          size: result.data.structured.bytes
        });
      }
      return response;
    }
  );

  server.registerTool(
    "artifact.import",
    {
      title: "Import an authorized Host artifact",
      description: "Save a Host-authorized PDF, spreadsheet or image into the workspace after public-source, signature, type, size and revision validation.",
      inputSchema: {
        file: z.object({
          download_url: z.string().url(),
          file_id: z.string().min(1),
          mime_type: z.string().optional(),
          file_name: z.string().optional()
        }),
        destination: relativePath,
        expected_sha256: sha256.nullable()
      },
      _meta: { "openai/fileParams": ["file"] },
      annotations: { readOnlyHint: false, openWorldHint: true, destructiveHint: false }
    },
    async ({ file, destination, expected_sha256 }) => action(core, "artifact.import", {
      source: {
        url: file.download_url,
        id: file.file_id,
        mimeType: file.mime_type,
        fileName: file.file_name
      },
      destination,
      expectedSha256: expected_sha256
    }, context, `Import authorized file ${file.file_name || "artifact"} to ${destination}`)
  );

  server.registerTool(
    "checkpoint.read",
    {
      title: "List workspace checkpoints",
      description: "List safe metadata for private local-snapshot checkpoints belonging to this workspace.",
      inputSchema: {},
      annotations: { readOnlyHint: true, openWorldHint: false, destructiveHint: false }
    },
    async () => action(core, "checkpoint.list", {}, context)
  );

  server.registerTool(
    "checkpoint.write",
    {
      title: "Create, restore or delete a checkpoint",
      description: "Create a private snapshot, transactionally restore one, or permanently delete checkpoint storage.",
      inputSchema: { request: z.discriminatedUnion("operation", [
        z.object({ operation: z.literal("create"), label: z.string().max(120).optional() }),
        z.object({ operation: z.literal("restore"), checkpoint_id: checkpointId }),
        z.object({ operation: z.literal("delete"), checkpoint_id: checkpointId })
      ]) },
      annotations: { readOnlyHint: false, openWorldHint: false, destructiveHint: true }
    },
    async ({ request: input }) => {
      if (input.operation === "create") {
        return action(core, "checkpoint.create", { label: input.label }, context,
          `Create checkpoint${input.label ? `: ${input.label}` : ""}`);
      }
      if (input.operation === "restore") {
        return action(core, "checkpoint.restore", { checkpointId: input.checkpoint_id }, context,
          `Restore checkpoint ${input.checkpoint_id}; newer managed files may be removed`);
      }
      return action(core, "checkpoint.delete", { checkpointId: input.checkpoint_id }, context,
        `Permanently delete checkpoint ${input.checkpoint_id}`);
    }
  );

  server.registerTool(
    "git.read",
    {
      title: "Read Git repository state",
      description: "Run a typed, read-only Git operation inside the workspace boundary: status, diff, or log. Arbitrary Git arguments are not accepted.",
      inputSchema: { request: z.discriminatedUnion("operation", [
        z.object({
          operation: z.literal("status"),
          cwd: relativePath.default("."),
          format: z.enum(["short", "porcelain_v1", "porcelain_v2"]).default("short"),
          branch: z.boolean().default(false),
          timeout_seconds: z.number().int().min(1).max(60).default(15)
        }),
        z.object({
          operation: z.literal("diff"),
          cwd: relativePath.default("."),
          cached: z.boolean().default(false),
          format: z.enum(["full", "stat", "name_only", "name_status"]).default("full"),
          paths: z.array(relativePath).max(50).default([]),
          timeout_seconds: z.number().int().min(1).max(60).default(15)
        }),
        z.object({
          operation: z.literal("log"),
          cwd: relativePath.default("."),
          max_count: z.number().int().min(1).max(100).default(20),
          oneline: z.boolean().default(true),
          decorate: z.enum(["auto", "yes", "no"]).default("auto"),
          all: z.boolean().default(false),
          timeout_seconds: z.number().int().min(1).max(60).default(15)
        })
      ]) },
      annotations: { readOnlyHint: true, openWorldHint: false, destructiveHint: false }
    },
    async ({ request: input }) => {
      const args = input.operation === "status"
        ? gitStatusArgs(input)
        : input.operation === "diff" ? gitDiffArgs(input) : gitLogArgs(input);
      return action(core, `git.${input.operation}`, {
        args,
        cwd: input.cwd,
        timeoutSeconds: input.timeout_seconds
      }, context);
    }
  );

  server.registerTool(
    "git.remote",
    {
      title: "Import from a Git remote",
      description: "Perform a typed Git network operation. v0.7 supports only safe public GitHub clone into a new workspace directory.",
      inputSchema: { request: z.discriminatedUnion("operation", [
        z.object({
          operation: z.literal("clone"),
          url: z.string().url(),
          destination: relativePath,
          ref: z.string().min(1).max(255).optional(),
          depth: z.number().int().min(1).max(50).default(1),
          timeout_seconds: z.number().int().min(1).max(600).default(180)
        })
      ]) },
      annotations: { readOnlyHint: false, openWorldHint: true, destructiveHint: false }
    },
    async ({ request: { url, destination, ref, depth, timeout_seconds } }) => action(core, "git.clone", {
      url,
      destination,
      ref: ref ?? null,
      depth,
      timeoutSeconds: timeout_seconds
    }, context, `Clone public GitHub repository into ${destination}`)
  );

  server.registerTool(
    "project.execute",
    {
      title: "Execute an approved project command",
      description: "Run an allowlisted npm or Go build/test command inside the selected workspace project. Shell syntax and arbitrary programs are rejected.",
      inputSchema: {
        program: z.enum(["go", "npm"]),
        args: z.array(z.string()).min(1).max(50),
        cwd: relativePath.default("."),
        timeout_seconds: z.number().int().min(1).max(300).default(120)
      },
      annotations: { readOnlyHint: false, openWorldHint: false, destructiveHint: false }
    },
    async ({ program, args, cwd, timeout_seconds }) => {
      const display = [program, ...args].map((value) => (/\s/.test(value) ? JSON.stringify(value) : value)).join(" ");
      return action(core, "project.execute", {
        program,
        args,
        cwd,
        timeoutSeconds: timeout_seconds
      }, context, `Run ${display} in ${cwd}`);
    }
  );

  server.registerTool(
    "project.dependencies",
    {
      title: "Install project dependencies",
      description: "Install npm dependencies with lifecycle scripts, audit and funding hooks disabled. This uses the public npm registry and mutates the workspace.",
      inputSchema: {
        package_manager: z.literal("npm").default("npm"),
        mode: z.enum(["auto", "install", "ci"]).default("auto"),
        cwd: relativePath.default("."),
        timeout_seconds: z.number().int().min(1).max(600).default(300)
      },
      annotations: { readOnlyHint: false, openWorldHint: true, destructiveHint: false }
    },
    async ({ package_manager, mode, cwd, timeout_seconds }) => action(core, "project.install_dependencies", {
      packageManager: package_manager,
      mode,
      cwd,
      timeoutSeconds: timeout_seconds
    }, context, `Install ${package_manager} dependencies in ${cwd} with lifecycle scripts disabled`)
  );

  return server;
}

export function createMcpApp({ host, core }) {
  const app = createMcpExpressApp({ host });

  app.post("/mcp", async (req, res) => {
    const context = {
      caller: {
        protocol: "mcp",
        clientId: null,
        clientName: null,
        sessionId: req.get("mcp-session-id") || null
      },
      workSessionId: null
    };
    const server = createMcpServer(core, context);
    const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined });

    res.on("close", () => {
      transport.close().catch(() => {});
      server.close().catch(() => {});
    });

    try {
      await server.connect(transport);
      await transport.handleRequest(req, res, req.body);
    } catch (error) {
      console.error("MCP request failed:", error);
      if (!res.headersSent) {
        res.status(500).json({
          jsonrpc: "2.0",
          error: { code: -32603, message: "Internal server error" },
          id: null
        });
      }
    }
  });

  app.get("/mcp", (_req, res) => {
    res.status(405).json({
      jsonrpc: "2.0",
      error: { code: -32000, message: "Method not allowed in stateless mode" },
      id: null
    });
  });

  app.delete("/mcp", (_req, res) => {
    res.status(405).json({
      jsonrpc: "2.0",
      error: { code: -32000, message: "Method not allowed in stateless mode" },
      id: null
    });
  });

  return app;
}
