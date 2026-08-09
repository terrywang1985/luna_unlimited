import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";

const endpoint = new URL(process.env.MCP_TEST_URL || "http://127.0.0.1:18765/mcp");
const client = new Client({ name: "luna-real-workspace-test", version: "0.5.0" });
const transport = new StreamableHTTPClientTransport(endpoint);

try {
  await client.connect(transport);

  const listing = await client.callTool({ name: "list_directory", arguments: { path: "." } });
  const listingText = listing.content?.find((item) => item.type === "text")?.text || "";
  if (!listingText.includes("package.json") || !listingText.includes("src")) {
    throw new Error("Configured workspace does not expose the project root");
  }
  const listingRows = listingText.split(/\r?\n/);
  if (listingRows.includes("[file] .env") || listingRows.includes("[dir] .git")) {
    throw new Error("Sensitive entries were visible in the root listing");
  }

  const packageRead = await client.callTool({ name: "read_text_file", arguments: { path: "package.json" } });
  if (packageRead.isError) throw new Error("Could not read project package.json");

  const sensitiveRead = await client.callTool({ name: "read_text_file", arguments: { path: ".env" } });
  if (!sensitiveRead.isError) throw new Error("Sensitive .env read was not blocked");

  const sensitiveSearch = await client.callTool({
    name: "search_files",
    arguments: { query: ".env", path: ".", search_type: "filename", max_results: 50 }
  });
  const sensitiveSearchText = sensitiveSearch.content?.find((item) => item.type === "text")?.text || "";
  if (sensitiveSearchText !== "(no matches)") throw new Error("Sensitive files appeared in search results");

  const gitStatus = await client.callTool({
    name: "exec_command",
    arguments: { program: "git", args: ["status", "--short"], cwd: ".", timeout_seconds: 15 }
  });
  if (gitStatus.isError) throw new Error("Allowlisted git status command was rejected");
  const gitPayload = JSON.parse(gitStatus.content?.find((item) => item.type === "text")?.text || "{}");
  if (!("exit_code" in gitPayload)) throw new Error("git status did not return an exit code");

  const dangerousCommand = await client.callTool({
    name: "exec_command",
    arguments: { program: "git", args: ["-c", "core.pager=cat", "status"], cwd: ".", timeout_seconds: 15 }
  });
  if (!dangerousCommand.isError) throw new Error("Non-whitelisted git invocation was not rejected");

  console.log("PASS: configured workspace exposes real project files");
  console.log("PASS: sensitive project files remain hidden and unreadable");
  console.log("PASS: sensitive project files are excluded from search");
  console.log(`PASS: git status returned structured exit code ${gitPayload.exit_code}`);
  console.log("PASS: non-whitelisted command arguments were rejected");
} finally {
  await client.close();
}
