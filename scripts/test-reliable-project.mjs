import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";

const endpoint = new URL(process.env.MCP_TEST_URL || "http://127.0.0.1:18765/mcp");
const client = new Client({ name: "luna-reliable-project-test", version: "0.6.4" });
const transport = new StreamableHTTPClientTransport(endpoint);

function toolText(result) {
  return result.content?.find((item) => item.type === "text")?.text || "";
}

async function call(name, args = {}) {
  const result = await client.callTool({ name, arguments: args });
  return { result, text: toolText(result) };
}

async function statPath(path) {
  const { result, text } = await call("stat_path", { path });
  if (result.isError) throw new Error(`stat_path failed for ${path}: ${text}`);
  return JSON.parse(text);
}

async function safeFile(path, content) {
  const current = await statPath(path);
  return current.exists ? { path, content, expected_sha256: current.sha256 } : { path, content };
}

const projectPath = "reliable-project-test";
const manifestPath = `${projectPath}/package.json`;
const sourcePath = `${projectPath}/src/index.js`;
const testPath = `${projectPath}/test.js`;
const lifecycleMarkerPath = `${projectPath}/lifecycle-ran.txt`;

try {
  await client.connect(transport);

  const tools = await client.listTools();
  const toolNames = new Set(tools.tools.map((tool) => tool.name));
  for (const expected of ["get_capabilities", "stat_path", "write_files", "install_dependencies"]) {
    if (!toolNames.has(expected)) throw new Error(`Missing reliable-project tool: ${expected}`);
  }

  const capabilitiesCall = await call("get_capabilities");
  if (capabilitiesCall.result.isError) throw new Error("get_capabilities returned an MCP error");
  const capabilities = JSON.parse(capabilitiesCall.text);
  if (
    capabilities.server?.version !== "0.6.4"
    || capabilities.features?.batchWrite !== true
    || capabilities.features?.commandProjectBoundary !== true
  ) {
    throw new Error("Capability discovery did not expose the reliable-project feature set");
  }
  if (capabilities.workspace?.rootName?.includes(":\\") || "root" in (capabilities.workspace || {})) {
    throw new Error("get_capabilities leaked an absolute workspace root");
  }

  const manifest = `${JSON.stringify({
    name: "luna-reliable-project-fixture",
    version: "1.0.0",
    private: true,
    type: "module",
    scripts: {
      preinstall: "node -e \"require('node:fs').writeFileSync('lifecycle-ran.txt','unsafe')\"",
      test: "node test.js"
    }
  }, null, 2)}\n`;
  const source = "export function add(left, right) {\n  return left + right;\n}\n";
  const test = "import { add } from './src/index.js';\nif (add(2, 3) !== 5) throw new Error('add failed');\nconsole.log('fixture test passed');\n";
  const initialFiles = await Promise.all([
    safeFile(manifestPath, manifest),
    safeFile(sourcePath, source),
    safeFile(testPath, test)
  ]);
  const initialWrite = await call("write_files", { files: initialFiles });
  if (initialWrite.result.isError) throw new Error(`Initial batch write failed: ${initialWrite.text}`);
  const initialPayload = JSON.parse(initialWrite.text);
  if (initialPayload.files?.length !== 3) throw new Error("write_files did not report all committed files");

  const beforeUpdate = await statPath(sourcePath);
  const updatedSource = "export function add(left, right) {\n  return Number(left) + Number(right);\n}\n";
  const update = await call("write_files", {
    files: [{ path: sourcePath, content: updatedSource, expected_sha256: beforeUpdate.sha256 }]
  });
  if (update.result.isError) throw new Error(`Revision-checked update failed: ${update.text}`);

  const staleUpdate = await call("write_files", {
    files: [{ path: sourcePath, content: "stale overwrite\n", expected_sha256: beforeUpdate.sha256 }]
  });
  if (!staleUpdate.result.isError || !staleUpdate.text.includes("File changed")) {
    throw new Error("Stale SHA-256 update was not rejected");
  }

  const atomicProbe = `${projectPath}/atomic-${Date.now()}.txt`;
  const atomicFailure = await call("write_files", {
    files: [
      { path: atomicProbe, content: "must not commit\n" },
      { path: sourcePath, content: "stale overwrite\n", expected_sha256: beforeUpdate.sha256 }
    ]
  });
  if (!atomicFailure.result.isError) throw new Error("Invalid batch unexpectedly succeeded");
  if ((await statPath(atomicProbe)).exists) throw new Error("Batch validation failure partially committed an earlier file");

  const sensitiveProbe = `${projectPath}/safe-before-sensitive-${Date.now()}.txt`;
  const sensitiveBatch = await call("write_files", {
    files: [
      { path: sensitiveProbe, content: "must not commit\n" },
      { path: ".env", content: "blocked\n" }
    ]
  });
  if (!sensitiveBatch.result.isError) throw new Error("Sensitive path in batch was not rejected");
  if ((await statPath(sensitiveProbe)).exists) throw new Error("Sensitive batch failure partially committed a safe file");

  const install = await call("install_dependencies", {
    package_manager: "npm",
    mode: "install",
    cwd: projectPath,
    timeout_seconds: 120
  });
  if (install.result.isError) throw new Error(`install_dependencies returned an MCP error: ${install.text}`);
  const installPayload = JSON.parse(install.text);
  if (!installPayload.success || installPayload.lifecycle_scripts_enabled !== false) {
    throw new Error(`Controlled dependency install failed: ${install.text}`);
  }
  if ((await statPath(lifecycleMarkerPath)).exists) {
    throw new Error("npm lifecycle script executed despite install_dependencies safety policy");
  }

  const projectTest = await call("exec_command", {
    program: "npm",
    args: ["test"],
    cwd: projectPath,
    timeout_seconds: 30
  });
  if (projectTest.result.isError) throw new Error(`Project test command returned an MCP error: ${projectTest.text}`);
  const testPayload = JSON.parse(projectTest.text);
  if (testPayload.exit_code !== 0 || !testPayload.stdout.includes("fixture test passed")) {
    throw new Error(`Generated project did not pass its test: ${projectTest.text}`);
  }

  console.log("PASS: capability discovery exposes safe, non-sensitive runtime metadata");
  console.log("PASS: write_files creates a multi-file project and enforces SHA-256 revisions");
  console.log("PASS: invalid and sensitive batches do not partially commit files");
  console.log("PASS: dependency installation disables npm lifecycle scripts");
  console.log("PASS: generated project installs and passes its declared test");
} finally {
  await client.close().catch(() => {});
}
