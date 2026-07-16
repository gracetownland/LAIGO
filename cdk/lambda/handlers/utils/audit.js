const { Logger } = require("@aws-lambda-powertools/logger");

const auditLogger = new Logger({ serviceName: "AuditTrail" });

/**
 * Emits a structured audit record for privileged operations.
 *
 * @param {Object} params
 * @param {string} params.actorId - The user ID of the actor performing the action
 * @param {string} [params.actorEmail] - The email of the actor
 * @param {string} params.action - The action performed (e.g., "ROLE_CHANGE", "PROMPT_CREATE")
 * @param {string} params.resourceType - The type of resource affected (e.g., "USER_ROLE", "PROMPT")
 * @param {string} [params.resourceId] - The ID of the resource affected
 * @param {string} [params.outcome] - The outcome of the action ("success" or "failure")
 * @param {*} [params.before] - The state before the action
 * @param {*} [params.after] - The state after the action
 * @param {Object} [params.metadata] - Additional metadata about the action
 */
function emitAuditRecord({
  actorId,
  actorEmail,
  action,
  resourceType,
  resourceId,
  outcome,
  before,
  after,
  metadata,
}) {
  auditLogger.info("AUDIT_EVENT", {
    audit: {
      timestamp: new Date().toISOString(),
      actor_id: actorId,
      actor_email: actorEmail || null,
      action,
      resource_type: resourceType,
      resource_id: resourceId || null,
      outcome: outcome || "success",
      before: before || null,
      after: after || null,
      metadata: metadata || null,
    },
  });
}

module.exports = { emitAuditRecord };
