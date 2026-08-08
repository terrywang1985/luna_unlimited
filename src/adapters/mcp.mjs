import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { createMcpExpressApp } from "@modelcontextprotocol/sdk/server/express.js";
import { LATEST_PROTOCOL_VERSION } from "@modelcontextprotocol/sdk/types.js";
import { z } from "zod";

function toMcpResult(result) {
  if (result.ok) {
    const response = { content: [{ type: "text", text: result.data.text }] };
    if (result.data.structured) response.structuredContent = result.data.structured;
    return response;
  }
  return { content: [{ type: "text", text: result.error.message }], isError: true };
}

function createMcpServer(core, context) {
  const server = new McpServer(
    { name: "luna-unlimited", version: "0.3.0" },
    {
      instructions:
        "Use these tools only inside the configured workspace. Call get_capabilities first. Use stat_path before overwriting an existing file, then pass its sha256 to write_files. Prefer write_files for reliable multi-file project creation."
    }
  );

  server.registerTool(
    "get_capabilities",
    {
      title: "Get Luna capabilities",
      description: "Discover enabled tools, approval requirements, safe workspace alias, limits, and policy revision.",
      inputSchema: {}
    },
    async () => toMcpResult(await core.execute(
      "get_capabilities",
      { adapter: "mcp", protocolVersion: LATEST_PROTOCOL_VERSION },
      context
    ))
  );

  server.registerTool(
    "stat_path",
    {
      title: "Stat path",
      description: "Inspect a workspace path and return type, size, mtime, and SHA-256 revision for writable text files.",
      inputSchema: {
        path: z.string().min(1).describe("File or directory path relative to the MCP workspace")
      }
    },
    async ({ path }) => toMcpResult(await core.execute("stat_path", { path }, context))
  );

  server.registerTool(
    "list_directory",
    {
      title: "List directory",
      description: "List files and folders inside the local MCP workspace.",
      inputSchema: { path: z.string().default(".").describe("Directory path relative to the MCP workspace") }
    },
    async ({ path }) => toMcpResult(await core.execute("list_directory", { path }, context))
  );

  server.registerTool(
    "read_text_file",
    {
      title: "Read text file",
      description: `Read a UTF-8 text file inside the local MCP workspace. Files larger than ${core.limits.maxFileBytes} bytes are rejected.`,
      inputSchema: { path: z.string().min(1).describe("File path relative to the MCP workspace") }
    },
    async ({ path }) => toMcpResult(await core.execute("read_text_file", { path }, context))
  );

  server.registerTool(
    "read_text_file_range",
    {
      title: "Read text file range",
      description: "Read a 1-based inclusive line range from a UTF-8 text file. At most 1000 lines are returned.",
      inputSchema: {
        path: z.string().min(1).describe("File path relative to the MCP workspace"),
        start_line: z.number().int().min(1).describe("First line to read, starting at 1"),
        end_line: z.number().int().min(1).describe("Last line to read, inclusive")
      }
    },
    async ({ path, start_line, end_line }) => toMcpResult(await core.execute(
      "read_text_file_range",
      { path, startLine: start_line, endLine: end_line },
      context
    ))
  );

  server.registerTool(
    "search_files",
    {
      title: "Search files",
      description: "Search UTF-8 file contents with ripgrep, or search file names, inside the authorized workspace.",
      inputSchema: {
        query: z.string().min(1).max(500).describe("Literal text or file-name fragment to search for"),
        path: z.string().default(".").describe("Directory path relative to the MCP workspace"),
        glob: z.string().max(200).optional().describe("Optional ripgrep glob such as *.go or **/*.ts"),
        search_type: z.enum(["content", "filename"]).default("content"),
        max_results: z.number().int().min(1).max(200).default(100)
      }
    },
    async ({ query, path, glob, search_type, max_results }) => toMcpResult(await core.execute(
      "search_files",
      { query, path, glob, searchType: search_type, maxResults: max_results },
      context
    ))
  );

  server.registerTool(
    "write_text_file",
    {
      title: "Write text file",
      description: "Create or replace a UTF-8 text file inside the local MCP workspace. Parent directories are created automatically.",
      inputSchema: {
        path: z.string().min(1).describe("File path relative to the MCP workspace"),
        content: z.string().describe("Complete UTF-8 content to write")
      }
    },
    async ({ path, content }) => {
      const bytes = Buffer.byteLength(content, "utf8");
      return toMcpResult(await core.execute(
        "write_text_file",
        { path, content },
        context,
        `Write ${bytes} bytes to ${path}`
      ));
    }
  );

  server.registerTool(
    "replace_text",
    {
      title: "Replace text safely",
      description: "Replace exact text in one UTF-8 file only when the match count equals expected_replacements.",
      inputSchema: {
        path: z.string().min(1).describe("File path relative to the MCP workspace"),
        old_text: z.string().min(1).describe("Exact text to find"),
        new_text: z.string().describe("Replacement text"),
        expected_replacements: z.number().int().min(1).max(100).default(1)
      }
    },
    async ({ path, old_text, new_text, expected_replacements }) => toMcpResult(await core.execute(
      "replace_text",
      { path, oldText: old_text, newText: new_text, expectedReplacements: expected_replacements },
      context,
      `Replace ${expected_replacements} occurrence(s) in ${path}`
    ))
  );

  server.registerTool(
    "write_files",
    {
      title: "Write multiple files safely",
      description:
        "Atomically create or update up to 50 UTF-8 files. Existing files require expected_sha256 from stat_path; all files are validated before commit and failures roll back committed files.",
      inputSchema: {
        files: z.array(z.object({
          path: z.string().min(1).describe("Target path relative to the MCP workspace"),
          content: z.string().describe("Complete UTF-8 content"),
          expected_sha256: z.string().regex(/^[a-f0-9]{64}$/i).optional()
            .describe("Required when updating an existing file; obtain it from stat_path")
        })).min(1).max(50)
      }
    },
    async ({ files }) => toMcpResult(await core.execute(
      "write_files",
      {
        files: files.map((file) => ({
          path: file.path,
          content: file.content,
          expectedSha256: file.expected_sha256
        }))
      },
      context,
      `Create or safely update ${files.length} file(s)`
    ))
  );

  server.registerTool(
    "exec_command",
    {
      title: "Execute approved development command",
      description:
        "Run a non-interactive allowlisted Git, Go, or npm build/test command. Shell syntax, redirection, pipes, and arbitrary programs are not accepted.",
      inputSchema: {
        program: z.enum(["git", "go", "npm"]),
        args: z.array(z.string()).min(1).max(50).describe("Argument array, for example [\"status\", \"--short\"]"),
        cwd: z.string().default(".").describe("Working directory relative to the MCP workspace"),
        timeout_seconds: z.number().int().min(1).max(300).default(120)
      }
    },
    async ({ program, args, cwd, timeout_seconds }) => {
      const displayCommand = [program, ...args].map((value) => (/\s/.test(value) ? JSON.stringify(value) : value)).join(" ");
      return toMcpResult(await core.execute(
        "exec_command",
        { program, args, cwd, timeoutSeconds: timeout_seconds },
        context,
        `Run ${displayCommand} in ${cwd}`
      ));
    }
  );

  server.registerTool(
    "install_dependencies",
    {
      title: "Install project dependencies safely",
      description:
        "Install npm dependencies declared in package.json using the public npm registry with lifecycle scripts, audit, and funding hooks disabled. This is a network and workspace mutation operation.",
      inputSchema: {
        package_manager: z.literal("npm").default("npm"),
        mode: z.enum(["auto", "install", "ci"]).default("auto")
          .describe("auto uses npm ci when package-lock.json exists, otherwise npm install"),
        cwd: z.string().default(".").describe("Project directory relative to the MCP workspace"),
        timeout_seconds: z.number().int().min(1).max(600).default(300)
      }
    },
    async ({ package_manager, mode, cwd, timeout_seconds }) => toMcpResult(await core.execute(
      "install_dependencies",
      { packageManager: package_manager, mode, cwd, timeoutSeconds: timeout_seconds },
      context,
      `Install ${package_manager} dependencies in ${cwd} with lifecycle scripts disabled`
    ))
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
