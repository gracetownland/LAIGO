const { SSMClient, GetParameterCommand } = require("@aws-sdk/client-ssm");
const {
  DynamoDBClient,
  GetItemCommand,
} = require("@aws-sdk/client-dynamodb");
const { Logger } = require("@aws-lambda-powertools/logger");
const logger = new Logger({ serviceName: "PreSignup" });

const ssmClient = new SSMClient();
const dynamoClient = new DynamoDBClient();

class UserError extends Error {
  constructor(message) {
    super(message);
    this.name = "UserError";
  }
}

/**
 * Cognito Pre-Signup Lambda Trigger
 *
 * Two-stage validation:
 * 1. Email domain check (existing) — validates against allowed domains in SSM.
 * 2. Whitelist check (new) — if signup mode is 'whitelist', the exact email
 *    must exist in the DynamoDB email-whitelist table.
 */
exports.handler = async (event) => {
  const domainParamName = process.env.ALLOWED_EMAIL_DOMAINS;
  const signupModeParamName = process.env.SIGNUP_MODE_PARAM;
  const whitelistTableName = process.env.WHITELIST_TABLE_NAME;

  try {
    if (!domainParamName) {
      throw new Error("Environment variable ALLOWED_EMAIL_DOMAINS is not set");
    }

    // ── Stage 1: Domain allowlist check (unchanged) ──────────────────────────
    const domainData = await ssmClient.send(
      new GetParameterCommand({ Name: domainParamName, WithDecryption: true }),
    );

    if (!domainData?.Parameter?.Value) {
      throw new Error(
        `SSM parameter ${domainParamName} not found or has no value`,
      );
    }

    const allowedDomains = domainData.Parameter.Value.split(",")
      .map((d) => d.trim().toLowerCase())
      .filter(Boolean);

    if (allowedDomains.length === 0) {
      throw new Error(
        `SSM parameter ${domainParamName} contains no allowed domains`,
      );
    }

    const email = event?.request?.userAttributes?.email;
    if (!email) {
      throw new UserError("Email attribute is required for signup");
    }

    const parts = email.split("@");
    if (parts.length < 2) {
      throw new UserError(`Invalid email address provided: ${email}`);
    }
    const emailDomain = parts.slice(1).join("@").trim().toLowerCase();
    logger.info("Signup request", { emailDomain });

    const isDomainAllowed = allowedDomains.some((allowed) => {
      if (allowed === "*") return true;
      return allowed === emailDomain;
    });

    if (!isDomainAllowed) {
      logger.error("Domain not allowed", { emailDomain, allowedDomains });
      throw new UserError(`Signup not allowed for email domain: ${emailDomain}`);
    }

    // ── Stage 2: Whitelist check (new) ───────────────────────────────────────
    if (signupModeParamName && whitelistTableName) {
      const modeData = await ssmClient.send(
        new GetParameterCommand({ Name: signupModeParamName }),
      );
      const signupMode = modeData?.Parameter?.Value || "public";
      logger.info("Signup mode", { signupMode });

      if (signupMode === "whitelist") {
        // Verify the exact email exists in the whitelist table
        const whitelistResult = await dynamoClient.send(
          new GetItemCommand({
            TableName: whitelistTableName,
            Key: { email: { S: email.toLowerCase().trim() } },
          }),
        );

        if (!whitelistResult.Item) {
          logger.error("Email not in whitelist");
          throw new UserError(
            `Signup not allowed: your email (${email}) is not on the access list. Please contact an administrator.`,
          );
        }

        logger.info("Email found in whitelist", {
          role: whitelistResult.Item.canonical_role?.S,
        });
      }
    }

    // All checks passed — continue signup
    return event;
  } catch (error) {
    logger.error("PreSignUp error", error);
    // If it's an intentional validation error (UserError), show it to the user.
    // Otherwise, mask it as a generic internal error.
    if (error instanceof UserError) {
      throw error;
    }
    throw new Error(
      "An error occurred during signup. Please try again later or contact an administrator.",
    );
  }
};
