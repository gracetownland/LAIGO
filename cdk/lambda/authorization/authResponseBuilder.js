/**
 * Builds a fresh IAM policy response for API Gateway Lambda authorizers.
 * Kept dependency-free so unit/property tests can import without AWS SDK mocks.
 *
 * @param {string} principalId - Database user identifier
 * @param {string} effect - IAM effect ("Allow" or "Deny")
 * @param {string} resource - API Gateway method ARN pattern
 * @param {object} [context] - Additional context passed to backend Lambdas
 * @returns {object} Fresh IAM policy response object
 */
function buildAuthResponse(principalId, effect, resource, context) {
  return {
    principalId,
    policyDocument: {
      Version: "2012-10-17",
      Statement: [{
        Action: "execute-api:Invoke",
        Effect: effect,
        Resource: resource,
      }],
    },
    context: context ? { ...context } : {},
  };
}

module.exports = { buildAuthResponse };
