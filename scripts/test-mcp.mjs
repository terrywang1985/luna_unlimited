import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";

const endpoint = new URL(process.env.MCP_TEST_URL || "http://127.0.0.1:18765/mcp");
const client = new Client({ name: "luna-local-files-smoke-test", version: "0.1.0" });
const transport = new StreamableHTTPClientTransport(endpoint);

try {
  await client.connect(transport);

  const tools = await client.listTools();
  const toolNames = tools.tools.map((tool) => tool.name);
  console.log(`Tools: ${toolNames.join(", ")}`);

  for (const expected of [
    "get_capabilities",
    "list_directory",
    "stat_path",
    "read_text_file",
    "read_text_file_range",
    "search_files",
    "write_text_file",
    "replace_text",
    "write_files",
    "apply_patch",
    "create_directory",
    "move_path",
    "delete_path",
    "inspect_artifact",
    "import_artifact",
    "export_artifact",
    "create_checkpoint",
    "list_checkpoints",
    "restore_checkpoint",
    "delete_checkpoint",
    "exec_command",
    "install_dependencies"
  ]) {
    if (!toolNames.includes(expected)) throw new Error(`Missing tool: ${expected}`);
  }

  const marker = `MCP smoke test passed at ${new Date().toISOString()}\nneedle-value\nomega\n`;
  const writeResult = await client.callTool({
    name: "write_text_file",
    arguments: { path: "mcp-smoke-test.txt", content: marker }
  });
  if (writeResult.isError) throw new Error("write_text_file returned an error");

  const readResult = await client.callTool({
    name: "read_text_file",
    arguments: { path: "mcp-smoke-test.txt" }
  });
  if (readResult.isError) throw new Error("read_text_file returned an error");

  const returnedText = readResult.content?.find((item) => item.type === "text")?.text;
  if (returnedText !== marker) throw new Error("Read content did not match written content");
  if (readResult.structuredContent?.text !== marker) {
    throw new Error("Structured read result did not include the file text");
  }

  const rangeResult = await client.callTool({
    name: "read_text_file_range",
    arguments: { path: "mcp-smoke-test.txt", start_line: 2, end_line: 3 }
  });
  const rangeText = rangeResult.content?.find((item) => item.type === "text")?.text;
  if (rangeText !== "needle-value\nomega") throw new Error("Line range result was incorrect");

  const contentSearch = await client.callTool({
    name: "search_files",
    arguments: { query: "needle-value", path: ".", glob: "*.txt", search_type: "content", max_results: 20 }
  });
  const contentSearchText = contentSearch.content?.find((item) => item.type === "text")?.text || "";
  if (!contentSearchText.includes("mcp-smoke-test.txt")) throw new Error("Content search did not find the fixture");

  const filenameSearch = await client.callTool({
    name: "search_files",
    arguments: { query: "mcp-smoke", path: ".", search_type: "filename", max_results: 20 }
  });
  const filenameSearchText = filenameSearch.content?.find((item) => item.type === "text")?.text || "";
  if (!filenameSearchText.includes("mcp-smoke-test.txt")) throw new Error("Filename search did not find the fixture");

  const replaceResult = await client.callTool({
    name: "replace_text",
    arguments: {
      path: "mcp-smoke-test.txt",
      old_text: "needle-value",
      new_text: "replacement-value",
      expected_replacements: 1
    }
  });
  if (replaceResult.isError) throw new Error("replace_text returned an error");

  const rejectedReplace = await client.callTool({
    name: "replace_text",
    arguments: {
      path: "mcp-smoke-test.txt",
      old_text: "missing-value",
      new_text: "must-not-write",
      expected_replacements: 1
    }
  });
  if (!rejectedReplace.isError) throw new Error("replace_text did not enforce expected_replacements");

  const execResult = await client.callTool({
    name: "exec_command",
    arguments: { program: "git", args: ["status", "--short"], cwd: ".", timeout_seconds: 15 }
  });
  if (execResult.isError) throw new Error("Allowlisted exec_command returned an MCP error");
  const execText = execResult.content?.find((item) => item.type === "text")?.text || "";
  const execPayload = JSON.parse(execText);
  if (!("exit_code" in execPayload) || !("stdout" in execPayload) || !("stderr" in execPayload)) {
    throw new Error("exec_command response is missing required fields");
  }

  const blockedRead = await client.callTool({
    name: "read_text_file",
    arguments: { path: "../.env" }
  });
  if (!blockedRead.isError) throw new Error("Path traversal was not rejected");

  console.log("PASS: write_text_file and read_text_file round trip succeeded");
  console.log("PASS: ranged reads, content search, and filename search succeeded");
  console.log("PASS: safe replace enforced exact replacement counts");
  console.log("PASS: allowlisted command execution returned structured output");
  console.log("PASS: path traversal outside workspace was rejected");
} finally {
  await client.close();
}
