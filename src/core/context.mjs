function cleanIdentityValue(value) {
  return typeof value === "string" ? value.slice(0, 200) : null;
}

export function createCallerContext(input = {}) {
  return Object.freeze({
    clientId: cleanIdentityValue(input.clientId),
    clientName: cleanIdentityValue(input.clientName),
    sessionId: cleanIdentityValue(input.sessionId),
    protocol: cleanIdentityValue(input.protocol) || "unknown"
  });
}

export function createWorkSessionContext(input = {}) {
  return Object.freeze({
    caller: createCallerContext(input.caller),
    workSessionId: cleanIdentityValue(input.workSessionId),
    approvalContext: input.approvalContext && typeof input.approvalContext === "object"
      ? Object.freeze({ ...input.approvalContext })
      : Object.freeze({})
  });
}

export function auditContext(context) {
  const caller = context?.caller || {};
  return {
    protocol: caller.protocol || "unknown",
    clientId: caller.clientId || null,
    clientName: caller.clientName || null,
    sessionId: caller.sessionId || null,
    workSessionId: context?.workSessionId || null
  };
}
