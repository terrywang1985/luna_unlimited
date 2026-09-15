import path from "node:path";
import { readFile } from "node:fs/promises";

const projectRoot = path.resolve(import.meta.dirname, "..");
const source = await readFile(path.join(projectRoot, "start-server.ps1"), "utf8");

const requiredFragments = [
  "Get-ListeningProcessId",
  "Get-NetTCPConnection",
  "/healthz",
  '$health.server -eq "luna-unlimited"',
  "Get-CimInstance Win32_Process",
  "server\\.mjs",
  "Refusing to stop it",
  "Stop-Process -Id $ownerProcessId -Force",
  "Stop-ExistingLunaServer -Port $mcpPort"
];

for (const fragment of requiredFragments) {
  if (!source.includes(fragment)) {
    throw new Error(`Windows startup safety regression: missing ${JSON.stringify(fragment)}`);
  }
}

const verifyHealth = source.indexOf('$health.server -eq "luna-unlimited"');
const verifyCommand = source.indexOf("$commandLooksLikeLuna =");
const refusal = source.indexOf("Refusing to stop it");
const stopProcess = source.indexOf("Stop-Process -Id $ownerProcessId -Force");

if (!(verifyHealth >= 0 && verifyCommand > verifyHealth && refusal > verifyCommand && stopProcess > refusal)) {
  throw new Error("Windows startup safety checks must precede Stop-Process");
}

if (!source.includes('MCP_PORT must be an integer between 10001 and 65535.')) {
  throw new Error("Windows startup must validate MCP_PORT before replacing an existing server");
}

console.log("Windows startup replacement safety: ok");
