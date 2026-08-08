import { randomUUID } from "node:crypto";
import { appendFile, readFile } from "node:fs/promises";

export class AuditStore {
  constructor({ auditLogPath, maxEntries = 500 }) {
    this.auditLogPath = auditLogPath;
    this.maxEntries = maxEntries;
    this.events = [];
    this.writeQueue = Promise.resolve();
  }

  async initialize() {
    try {
      const existing = await readFile(this.auditLogPath, "utf8");
      for (const line of existing.split(/\r?\n/).filter(Boolean).slice(-this.maxEntries)) {
        try {
          this.events.push(JSON.parse(line));
        } catch {
          // Ignore an incomplete final line after an interrupted write.
        }
      }
    } catch (error) {
      if (error?.code !== "ENOENT") throw error;
    }
  }

  record({ tool, path: targetPath = "", status, durationMs = 0, details = {}, context = null }) {
    const event = {
      id: randomUUID(),
      timestamp: new Date().toISOString(),
      tool,
      path: String(targetPath).slice(0, 500),
      status,
      durationMs,
      details: context ? { ...details, context } : details
    };

    this.events.push(event);
    if (this.events.length > this.maxEntries) {
      this.events.splice(0, this.events.length - this.maxEntries);
    }

    this.writeQueue = this.writeQueue
      .then(() => appendFile(this.auditLogPath, `${JSON.stringify(event)}\n`, "utf8"))
      .catch((error) => console.error("Failed to append audit log:", error));

    return event;
  }

  list(limit = 100) {
    return this.events.slice(-limit).reverse();
  }

  counts() {
    return this.events.reduce(
      (result, event) => {
        result.total += 1;
        result[event.status] = (result[event.status] || 0) + 1;
        return result;
      },
      { total: 0, success: 0, error: 0, denied: 0 }
    );
  }

  async flush() {
    await this.writeQueue;
  }
}
