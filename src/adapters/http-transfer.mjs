import express from "express";

function statusForCoreError(code) {
  if (["INVALID_ARGUMENT", "PATH_OUTSIDE_WORKSPACE", "SENSITIVE_PATH", "SYMBOLIC_LINK"].includes(code)) return 400;
  if (code === "FILE_TOO_LARGE") return 413;
  if (code === "FILE_CHANGED") return 409;
  return 500;
}

export function registerFileTransferRoutes(app, { core, maxUploadBytes }) {
  const rawBody = express.raw({ type: "*/*", limit: maxUploadBytes });

  app.post("/files/upload", rawBody, async (req, res) => {
    res.set("Cache-Control", "no-store");
    const relativePath = typeof req.query.path === "string" ? req.query.path.trim() : "";
    if (!relativePath) {
      res.status(400).json({ error: "path is required" });
      return;
    }
    if (!Buffer.isBuffer(req.body)) {
      res.status(400).json({ error: "binary request body is required" });
      return;
    }

    const result = await core.uploadBrowserFile(
      { path: relativePath, buffer: req.body },
      {
        caller: {
          clientId: "luna-cloud-file-transfer",
          clientName: "Luna Cloud File Transfer",
          protocol: "http"
        }
      }
    );
    if (!result.ok) {
      res.status(statusForCoreError(result.error.code)).json({ error: result.error.message, code: result.error.code });
      return;
    }
    res.status(201).json(result.data.structured);
  });
}
