import path from "node:path";
import { readFile } from "node:fs/promises";

async function getTunnelStatus(logsDir) {
  try {
    const healthBase = (await readFile(path.join(logsDir, "tunnel-health.url"), "utf8")).trim();
    if (!healthBase.startsWith("http://127.0.0.1:")) throw new Error("Unexpected tunnel health URL");
    const response = await fetch(`${healthBase}/readyz`, { signal: AbortSignal.timeout(800) });
    return { ready: response.ok, statusCode: response.status, healthBase };
  } catch {
    return { ready: false, statusCode: null, healthBase: null };
  }
}

export function registerAdminRoutes(app, { core, adminPagePath, logsDir, host, port, startedAt }) {
  app.get("/admin", (_req, res) => {
    res.sendFile(adminPagePath);
  });

  app.get("/admin/api/status", async (_req, res) => {
    res.set("Cache-Control", "no-store");
    const tunnel = await getTunnelStatus(logsDir);
    const coreStatus = core.adminStatus();
    res.json({
      server: {
        ready: true,
        name: "luna-unlimited",
        version: "0.6.5",
        endpoint: `http://${host}:${port}/mcp`,
        adminUrl: `http://${host}:${port}/admin`,
        startedAt: startedAt.toISOString(),
        uptimeSeconds: Math.floor((Date.now() - startedAt.getTime()) / 1000)
      },
      tunnel,
      ...coreStatus
    });
  });

  app.get("/admin/api/logs", (req, res) => {
    res.set("Cache-Control", "no-store");
    const requestedLimit = Number.parseInt(String(req.query.limit || "100"), 10);
    const limit = Number.isFinite(requestedLimit) ? Math.min(Math.max(requestedLimit, 1), 500) : 100;
    res.json({ events: core.audit.list(limit) });
  });

  app.post("/admin/api/permissions/:tool", (req, res) => {
    if (typeof req.body?.enabled !== "boolean") {
      res.status(400).json({ error: "enabled must be a boolean" });
      return;
    }
    const result = core.setToolPermission(req.params.tool, req.body.enabled);
    if (!result) {
      res.status(404).json({ error: "Unknown tool" });
      return;
    }
    res.json(result);
  });

  app.get("/admin/api/approvals", (_req, res) => {
    res.set("Cache-Control", "no-store");
    res.json(core.approvals.list());
  });

  app.post("/admin/api/approval-policy", (req, res) => {
    if (typeof req.body?.enabled !== "boolean") {
      res.status(400).json({ error: "enabled must be a boolean" });
      return;
    }
    res.json(core.setApprovalEnabled(req.body.enabled));
  });

  app.post("/admin/api/approvals/:id", (req, res) => {
    const decision = req.body?.decision;
    if (!["approve", "deny"].includes(decision)) {
      res.status(400).json({ error: "decision must be approve or deny" });
      return;
    }
    const result = core.decideApproval(req.params.id, decision);
    if (!result) {
      res.status(404).json({ error: "Approval request not found or already resolved" });
      return;
    }
    res.json(result);
  });

  app.get("/healthz", (_req, res) => {
    res.json({
      ok: true,
      server: "luna-unlimited",
      workspace: core.workspace.root,
      admin: `http://${host}:${port}/admin`
    });
  });
}
