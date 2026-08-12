import { ACTION_DEFINITIONS } from "./actions.mjs";

export const PROTECTED_ACTIONS = Object.freeze(
  ACTION_DEFINITIONS.filter((definition) => definition.protected).map((definition) => definition.id)
);

export class PolicyService {
  constructor({ approvalTimeoutSeconds = 120 } = {}) {
    this.actionPermissions = Object.fromEntries(ACTION_DEFINITIONS.map(({ id }) => [id, true]));
    this.approvalEnabled = false;
    this.approvalTimeoutSeconds = approvalTimeoutSeconds;
    this.protectedActions = new Set(PROTECTED_ACTIONS);
    this.version = 1;
    this.revision = 0;
  }

  hasAction(action) {
    return Object.hasOwn(this.actionPermissions, action);
  }

  isActionEnabled(action) {
    return this.actionPermissions[action] === true;
  }

  setActionEnabled(action, enabled) {
    if (!this.hasAction(action)) return false;
    this.actionPermissions[action] = enabled;
    this.revision += 1;
    return true;
  }

  setApprovalEnabled(enabled) {
    this.approvalEnabled = enabled;
    this.revision += 1;
  }

  requiresApproval(action) {
    return this.approvalEnabled && this.protectedActions.has(action);
  }

  actionRows() {
    return ACTION_DEFINITIONS.map((definition) => ({
      ...definition,
      enabled: this.isActionEnabled(definition.id)
    }));
  }

  snapshot() {
    return {
      version: this.version,
      revision: this.revision,
      approvalEnabled: this.approvalEnabled,
      approvalTimeoutSeconds: this.approvalTimeoutSeconds,
      protectedActions: [...this.protectedActions],
      actions: { ...this.actionPermissions }
    };
  }
}
