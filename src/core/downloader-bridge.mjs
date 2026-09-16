const DEFAULT_ENDPOINT = "http://127.0.0.1:43871/mcp";

function parseMcpPayload(text, contentType = "") {
  if (contentType.includes("text/event-stream")) {
    for (const line of String(text).split(/\r?\n/)) {
      if (!line.startsWith("data:")) continue;
      const raw = line.slice(5).trim();
      if (!raw) continue;
      const payload = JSON.parse(raw);
      if (payload.error) throw new Error(payload.error.message || "AI Downloader MCP request failed");
      if (payload.result) return payload.result;
    }
    throw new Error("AI Downloader returned no MCP result");
  }
  const payload = JSON.parse(text);
  if (payload.error) throw new Error(payload.error.message || "AI Downloader MCP request failed");
  return payload.result ?? payload;
}

export class DownloaderBridgeService {
  constructor({ workspace, endpoint = process.env.LUNA_AI_DOWNLOADER_MCP_URL || DEFAULT_ENDPOINT, fetchImpl = globalThis.fetch } = {}) {
    this.workspace = workspace;
    this.endpoint = endpoint;
    this.fetchImpl = fetchImpl;
    this.nextId = 1;
  }

  async callTool(name, args = {}) {
    if (typeof this.fetchImpl !== "function") throw new Error("fetch is unavailable for AI Downloader bridge");
    const response = await this.fetchImpl(this.endpoint, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        accept: "application/json, text/event-stream"
      },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: this.nextId++,
        method: "tools/call",
        params: { name, arguments: args }
      })
    });
    const text = await response.text();
    if (!response.ok) throw new Error(`AI Downloader HTTP ${response.status}: ${text.slice(0, 500)}`);
    const result = parseMcpPayload(text, response.headers.get("content-type") || "");
    if (result?.isError) throw new Error(result.content?.[0]?.text || "AI Downloader tool failed");
    return result?.structuredContent ?? result;
  }

  wrap(value) {
    return {
      text: JSON.stringify(value, null, 2),
      structured: value,
      details: { downloaderEndpoint: this.endpoint }
    };
  }

  async start({ url, destination, filename = null, connections = 4 }) {
    const destinationPath = this.workspace.resolve(destination);
    await this.workspace.rejectSymlinks(destinationPath, true);
    const result = await this.callTool("download_start", {
      url,
      destination: destinationPath,
      ...(filename ? { filename } : {}),
      connections
    });
    return this.wrap(result);
  }

  async list() {
    return this.wrap(await this.callTool("download_list", {}));
  }

  async status({ downloadId }) {
    return this.wrap(await this.callTool("download_status", { download_id: downloadId }));
  }

  async pause({ downloadId }) {
    return this.wrap(await this.callTool("download_pause", { download_id: downloadId }));
  }

  async resume({ downloadId }) {
    return this.wrap(await this.callTool("download_resume", { download_id: downloadId }));
  }

  async cancel({ downloadId }) {
    return this.wrap(await this.callTool("download_cancel", { download_id: downloadId }));
  }
}

export { DEFAULT_ENDPOINT, parseMcpPayload };
