import { randomUUID } from "node:crypto";

export class ApprovalManager {
  constructor({ policy }) {
    this.policy = policy;
    this.pending = new Map();
    this.recent = [];
  }

  request(tool, targetPath, summary) {
    if (!this.policy.requiresApproval(tool)) {
      return Promise.resolve({ approved: true, reason: "approval_not_required" });
    }

    return new Promise((resolve) => {
      const id = randomUUID();
      const requestedAt = new Date();
      const timer = setTimeout(() => {
        this.finish(id, false, "approval_timeout");
      }, this.policy.approvalTimeoutSeconds * 1000);
      timer.unref?.();

      this.pending.set(id, {
        id,
        tool,
        path: String(targetPath).slice(0, 500),
        summary: String(summary || `${tool}: ${targetPath}`).slice(0, 1000),
        requestedAt: requestedAt.toISOString(),
        expiresAt: new Date(requestedAt.getTime() + this.policy.approvalTimeoutSeconds * 1000).toISOString(),
        timer,
        resolve
      });
    });
  }

  finish(id, approved, reason) {
    const approval = this.pending.get(id);
    if (!approval) return false;

    clearTimeout(approval.timer);
    this.pending.delete(id);
    this.recent.unshift({
      id: approval.id,
      tool: approval.tool,
      path: approval.path,
      summary: approval.summary,
      requestedAt: approval.requestedAt,
      resolvedAt: new Date().toISOString(),
      decision: approved ? "approved" : "denied",
      reason
    });
    if (this.recent.length > 50) this.recent.length = 50;
    approval.resolve({ approved, reason });
    return true;
  }

  disableAndDenyPending() {
    for (const id of [...this.pending.keys()]) {
      this.finish(id, false, "approval_mode_disabled");
    }
  }

  get(id) {
    return this.pending.get(id) || null;
  }

  list() {
    const pending = [...this.pending.values()].map(({ timer: _timer, resolve: _resolve, ...approval }) => approval);
    return { enabled: this.policy.approvalEnabled, pending, recent: this.recent };
  }

  get size() {
    return this.pending.size;
  }
}
