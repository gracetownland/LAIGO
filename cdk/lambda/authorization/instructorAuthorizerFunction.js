/**
 * Instructor Authorizer Lambda Function
 *
 * This Lambda authorizer validates JWT tokens from an IDP (Identity Provider)
 * and resolves the user identifier to database userId for downstream handlers.
 *
 * Flow:
 * 1. API Gateway receives request with Authorization header
 * 2. Invokes this Lambda with the token
 * 3. Lambda verifies token signature and expiration
 * 4. Extracts "sub" claim as idpId
 * 5. Queries database to resolve idpId to userId
 * 6. Returns IAM policy with userId and user metadata in context
 *
 * Note: Authorization checks (role validation) are performed by API handlers
 * using the userId from context, not by this authorizer.
 */

const {
  SecretsManagerClient,
  GetSecretValueCommand,
} = require("@aws-sdk/client-secrets-manager");
const { CognitoJwtVerifier } = require("aws-jwt-verify");
const { initializeConnection } = require("./initializeConnection");
const { Logger } = require("@aws-lambda-powertools/logger");
const logger = new Logger({ serviceName: "InstructorAuthorizer" });

// Create a Secrets Manager client
const secretsManager = new SecretsManagerClient();

// Environment variables for IDP configuration
let { SM_IDP_CREDENTIALS } = process.env;

// IAM policy response structure — built fresh per invocation to avoid
// Statement array accumulation across warm Lambda invocations.
function buildAuthResponse(principalId, effect, resource, context) {
  return {
    principalId,
    policyDocument: {
      Version: "2012-10-17",
      Statement: [
        {
          Action: "execute-api:Invoke",
          Effect: effect,
          Resource: resource,
        },
      ],
    },
    context: context || {},
  };
}

// JWT verifier instance (initialized once during cold start for performance)
// Caches JWKS (JSON Web Key Set) to avoid fetching on every invocation
let jwtVerifier;

// User metadata cache for Lambda execution context
// Avoids repeated database queries within the same invocation
let userMetadataCache = {};

/**
 * Query database to resolve idpId to userId and retrieve user metadata
 * Implements execution context caching to avoid repeated queries
 */
async function getUserMetadataFromDatabase(idpId, forceRefresh = false) {
  // Check cache first
  if (!forceRefresh && userMetadataCache[idpId]) {
    logger.info("Using cached user metadata");
    return userMetadataCache[idpId];
  }

  // Ensure database connection is initialized
  if (!global.sqlConnection) {
    await initializeConnection();
  }

  const sqlConnection = global.sqlConnection;

  try {
    // Query database by idp_id
    const result = await sqlConnection`
      SELECT user_id, user_email, first_name, last_name, roles
      FROM users
      WHERE idp_id = ${idpId};
    `;

    if (result.length === 0) {
      throw new Error("User not found");
    }

    const user = {
      user_id: result[0].user_id,
      email: result[0].user_email,
      first_name: result[0].first_name,
      last_name: result[0].last_name,
      roles: result[0].roles,
    };

    // Cache for this execution context
    userMetadataCache[idpId] = user;

    return user;
  } catch (error) {
    logger.error("Database query failed", {
      errorType: error.name,
      errorMessage: error.message,
    });
    throw error;
  }
}

/**
 * Initialize JWT verifier with IDP configuration from Secrets Manager
 * Called once during Lambda cold start to set up the verifier
 */
async function initializeJwtVerifier() {
  try {
    // Retrieve IDP configuration from Secrets Manager
    const getSecretValueCommand = new GetSecretValueCommand({
      SecretId: SM_IDP_CREDENTIALS,
    });
    const secretResponse = await secretsManager.send(getSecretValueCommand);

    const credentials = JSON.parse(secretResponse.SecretString);

    // Create JWT verifier configured to validate tokens from the IDP
    // Note: NO group validation - authorization is handled by API handlers
    jwtVerifier = CognitoJwtVerifier.create({
      userPoolId: credentials.JWT_ISSUER_ID,
      tokenUse: "id", // Validate ID tokens (not access tokens)
      clientId: credentials.JWT_CLIENT_ID,
      // NO groups parameter - we don't validate groups in JWT
    });

    // Log verifier initialization (no secrets)
    logger.info("Instructor JWT verifier initialized", {
      issuerId: credentials.JWT_ISSUER_ID,
    });
  } catch (error) {
    logger.error("Error initializing JWT verifier", error);
    throw new Error("Failed to initialize JWT verifier");
  }
}

/**
 * Lambda handler function invoked by API Gateway for authorization
 */
exports.handler = async (event) => {
  // Initialize verifier on first invocation (cold start)
  if (!jwtVerifier) {
    await initializeJwtVerifier();
  }

  // Extract JWT token from Authorization header
  const accessToken = event.authorizationToken.toString();
  logger.info("Instructor authorizer invoked", { methodArn: event.methodArn });
  let payload;

  try {
    // Verify token signature and expiration (NO group validation)
    payload = await jwtVerifier.verify(accessToken);

    // Extract idpId from "sub" claim
    const idpId = payload.sub;

    // Query database to resolve idpId to userId
    let user;
    try {
      user = await getUserMetadataFromDatabase(idpId);
    } catch (error) {
      logger.error("User lookup failed", {
        errorType: error.name,
        errorMessage: error.message,
      });
      throw new Error("Unauthorized");
    }

    // Enforce role membership — user must hold the instructor role in the database.
    // Re-fetch once from DB before deny to avoid stale warm-cache role misses.
    if (!user.roles || !user.roles.includes("instructor")) {
      user = await getUserMetadataFromDatabase(idpId, true);

      if (!user.roles || !user.roles.includes("instructor")) {
        logger.warn("Access denied: user does not have instructor role", {
          userId: user.user_id,
        });
        throw new Error("Unauthorized");
      }
    }

    // Use a scoped wildcard to allow caching across all endpoints within this role's scope
    // This allows the authorizer to be cached while ensuring the policy doesn't leak access to other roles.
    const parts = event.methodArn.split("/");
    const resource = parts.slice(0, 2).join("/") + "/*/instructor/*";

    // Build fresh IAM policy per invocation (no shared mutable state)
    return buildAuthResponse(user.user_id, "Allow", resource, {
      userId: user.user_id,
      email: user.email,
      firstName: user.first_name || "",
      lastName: user.last_name || "",
      roles: JSON.stringify(user.roles), // API Gateway requires string values
    });
  } catch (error) {
    logger.error("Authorization error", error);
    // API Gateway requires exact "Unauthorized" message for 401 response
    throw new Error("Unauthorized");
  }
};
