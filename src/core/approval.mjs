import { randomUUID } from "node:crypto";

export class ApprovalManager {
  constructor({ policy }) {
    this.policy = policy;
    this.pending = new Map();
    this.recent = [];
  }

  request(action, targetPath, summary) {
    if (!this.policy.requiresApproval(action)) {
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
        action,
        path: String(targetPath).slice(0, 500),
        summary: String(summary || `${action}: ${targetPath}`).slice(0, 1000),
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
      action: approval.action,
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

  denyPendingNoLongerRequired() {
    for (const [id, approval] of this.pending) {
      if (!this.policy.requiresApproval(approval.action)) {
        this.finish(id, false, "approval_mode_disabled");
      }
    }
  }

  get(id) {
    return this.pending.get(id) || null;
  }

  list() {
    const pending = [...this.pending.values()].map(({ timer: _timer, resolve: _resolve, ...approval }) => approval);
    return {
      enabled: this.policy.approvalEnabled,
      mandatoryActions: [...this.policy.mandatoryApprovalActions],
      pending,
      recent: this.recent
    };
  }

  get size() {
    return this.pending.size;
  }
}
