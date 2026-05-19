# Code Review: CDK Infrastructure

**Reviewer:** Kiro  
**Date:** 2026-05-15  
**Scope:** All CDK stacks (`cdk/lib/`, `cdk/bin/cdk.ts`)  
**Status:** Complete

---

## Summary

| Severity | Count | Fixed |
|----------|-------|-------|
| Critical | 1     | 0     |
| High     | 4     | 0     |
| Medium   | 6     | 0     |
| Low      | 4     | 0     |
| **Total**| **15**| **0** |

---

## What's Well-Designed

**Least-privilege IAM roles per function group.** Each Lambda function group (student handler, admin handler, authorizers, etc.) gets a dedicated IAM role with only the permissions it needs. This is significantly better than a shared "Lambda role" pattern.

**Bedrock guardrails defined in CDK.** Guardrails are infrastructure-as-code, versioned, and deployed consistently. The PII blocking and prompt attack detection are well-configured.

**WAF with per-user rate limiting.** The API Gateway WAF uses MD5-hashed Authorization headers as custom keys for per-user rate limiting — a clever approach to rate-limit authenticated users individually without parsing JWTs at the WAF layer.

**S3 buckets with enforceSSL, encryption, and BLOCK_ALL public access.** Audio storage bucket has proper security defaults.

**DynamoDB tables with TTL for automatic cleanup.** Playground sessions (24h), connections (2h), and notifications (30 days) all have appropriate TTLs.

**Stack dependency ordering is explicit.** `addDependency()` calls in `bin/cdk.ts` ensure correct deployment order.

---

## Critical Issues

### C1. `NODE_TLS_REJECT_UNAUTHORIZED: "0"` disables TLS verification
- **Status:** ⬜ Open
- **File:** `lib/dbFlow-stack.ts`
- **Description:** The database migration Lambda has `NODE_TLS_REJECT_UNAUTHORIZED: "0"` in its environment, which disables ALL TLS certificate verification for the entire Node.js process. This means the Lambda will accept any certificate, including from a MITM attacker.
- **Impact:** The migration Lambda connects to RDS Proxy with credentials. A network-level attacker could intercept the connection and steal database credentials.
- **Context:** This was likely added because RDS Proxy uses Amazon-issued certificates that Node.js doesn't trust by default. The proper fix is to bundle the RDS CA certificate.
- **Fix:**
```typescript
environment: {
  // Remove NODE_TLS_REJECT_UNAUTHORIZED: "0"
  NODE_OPTIONS: "--use-openssl-ca", // Use system CA store
  // Or bundle the RDS CA cert:
  // SSL_CERT_FILE: "/opt/rds-combined-ca-bundle.pem",
},
```
Alternatively, use the `ssl: { rejectUnauthorized: true, ca: fs.readFileSync('rds-ca.pem') }` option in the postgres connection config.

---

## High Issues

### H1. `api-stack.ts` is a 2609-line monolithic stack
- **Status:** ⬜ Open
- **File:** `lib/api-stack.ts`
- **Description:** This single file defines: Cognito (user pool, identity pool, triggers), API Gateway (REST + WebSocket), WAF, 12+ Lambda functions, 5 DynamoDB tables, 2 S3 buckets, EventBridge, SQS, Bedrock guardrails, SSM parameters, and all IAM roles. At 2609 lines, it's extremely difficult to:
  - Review changes safely
  - Deploy incrementally (any change redeploys everything)
  - Understand resource relationships
  - Stay within CloudFormation's 500-resource limit
- **Impact:** Deployment risk, slow deploy times, difficult code review, approaching CloudFormation limits.
- **Fix:** Split into sub-stacks or nested stacks:
  - `auth-stack.ts` — Cognito, identity pool, authorizer Lambdas
  - `api-stack.ts` — API Gateway, WAF, OpenAPI spec
  - `compute-stack.ts` — Lambda functions, layers, roles
  - `data-stack.ts` — DynamoDB tables, S3 buckets
  - `events-stack.ts` — EventBridge, WebSocket, notification service

---

### H2. Cognito User Pool has `removalPolicy: RETAIN` but comment says "Delete"
- **Status:** ⬜ Open
- **File:** `lib/api-stack.ts`
- **Description:**
```typescript
removalPolicy: cdk.RemovalPolicy.RETAIN, // Delete user pool when stack is destroyed
```
The comment says "Delete" but the actual policy is `RETAIN`. This is misleading — the user pool will NOT be deleted when the stack is destroyed. While RETAIN is the safer choice for production (prevents accidental user data loss), the comment is dangerously wrong and could mislead someone into thinking deletion is safe.
- **Fix:** Update the comment to match the actual behavior:
```typescript
removalPolicy: cdk.RemovalPolicy.RETAIN, // Retain user pool to prevent accidental user data loss
```

---

### H3. Text generation Lambda uses admin DB secret instead of user secret
- **Status:** ⬜ Open
- **File:** `lib/api-stack.ts`
- **Description:**
```typescript
const textGenLambdaDockerFunc = new lambda.DockerImageFunction(..., {
  environment: {
    SM_DB_CREDENTIALS: db.secretPathAdmin.secretName, // ADMIN secret!
    ...
  },
});
// ...
db.secretPathAdmin.grantRead(textGenLambdaDockerFunc);
```
The text generation Lambda (which handles student chat messages) is granted the **admin** database secret. This violates least-privilege — if this Lambda is compromised, the attacker gets admin-level database access instead of read-only application access.
- **Impact:** Privilege escalation risk. The text generation Lambda only needs to read cases and write to the activity counter — it doesn't need admin credentials.
- **Fix:** Use `db.secretPathUser.secretName` instead of `db.secretPathAdmin.secretName`.

---

### H4. Single NAT Gateway creates single point of failure
- **Status:** ⬜ Open
- **File:** `lib/vpc-stack.ts`
- **Description:**
```typescript
natGateways: 1,
maxAzs: 2,
```
With 2 AZs but only 1 NAT Gateway, if the AZ hosting the NAT Gateway fails, all private subnet Lambda functions lose internet access (needed for Bedrock API calls, Secrets Manager, etc.). VPC endpoints cover Secrets Manager and RDS, but Bedrock, Transcribe, and EventBridge still need NAT.
- **Impact:** AZ failure = complete service outage for AI features.
- **Fix for production:** Set `natGateways: 2` (one per AZ). Accept the ~$32/month additional cost for HA.

---

## Medium Issues

### M1. Hardcoded Powertools layer version ARNs
- **Status:** ⬜ Open
- **File:** `lib/api-stack.ts`
- **Description:**
```typescript
`arn:aws:lambda:${this.region}:017000801446:layer:AWSLambdaPowertoolsPythonV2:78`
`arn:aws:lambda:${this.region}:094274105915:layer:AWSLambdaPowertoolsTypeScriptV2:45`
```
These are pinned to specific versions (78, 45). When AWS releases security patches to Powertools, these won't auto-update. There's no mechanism to track when updates are available.
- **Impact:** Missing security patches, potential compatibility issues when eventually updated.
- **Fix:** Document the pinned versions and create a process to review/update quarterly. Consider using `ssm.StringParameter.valueForStringParameter` to make the version configurable.

---

### M2. `dataTraceEnabled: true` logs full request/response bodies
- **Status:** ⬜ Open
- **File:** `lib/api-stack.ts`
- **Description:**
```typescript
deployOptions: {
  dataTraceEnabled: true, // Enable request/response logging
}
```
This logs full request and response bodies to CloudWatch, including potentially sensitive data (case descriptions, legal content, user messages). For a legal AI tool handling privileged information, this is a compliance concern.
- **Impact:** Sensitive legal data in CloudWatch logs. May violate client-solicitor privilege requirements.
- **Fix:** Set `dataTraceEnabled: false` in production. Use structured application-level logging (Powertools) for debugging instead.

---

### M3. DynamoDB conversation table has no TTL — data grows indefinitely
- **Status:** ⬜ Open
- **File:** `lib/api-stack.ts`
- **Description:** The main `chatHistoryTable` (conversation history) has no `timeToLiveAttribute` configured, unlike the playground table which has TTL. Chat history grows indefinitely.
- **Impact:** Unbounded DynamoDB storage costs. For a legal tool, this may be intentional (retain conversation history), but should be an explicit decision with a data retention policy.
- **Fix:** Either add TTL with a long retention (e.g., 1 year) or document that indefinite retention is intentional and add a lifecycle policy for archival.

---

### M4. S3 CORS allows `http://localhost:5173` in production
- **Status:** ⬜ Open
- **File:** `lib/api-stack.ts`
- **Description:**
```typescript
const s3CorsAllowedOrigins = allowedOrigin
  ? [allowedOrigin, localDevOrigin]  // Always includes localhost!
  : ["*"];
```
When a domain name is configured (production), the S3 CORS still includes `http://localhost:5173`. This means anyone running a local dev server can make cross-origin requests to the production S3 buckets.
- **Impact:** Reduced CORS protection in production. An attacker running a local server could upload files to the audio bucket if they have valid credentials.
- **Fix:** Only include localhost in non-production environments:
```typescript
const s3CorsAllowedOrigins = allowedOrigin
  ? [allowedOrigin]  // Production: only the real domain
  : ["*"];           // Dev: permissive
```

---

### M5. No backup/point-in-time recovery on DynamoDB tables
- **Status:** ⬜ Open
- **File:** `lib/api-stack.ts`
- **Description:** None of the DynamoDB tables (conversation history, notifications, connections, whitelist) have point-in-time recovery (PITR) enabled. The conversation history table stores all AI chat sessions — losing this data would be significant.
- **Fix:** Enable PITR on critical tables:
```typescript
const chatHistoryTable = new dynamodb.Table(this, ..., {
  pointInTimeRecovery: true,
  ...
});
```

---

### M6. WebSocket API has no throttling configuration
- **Status:** ⬜ Open
- **File:** `lib/api-stack.ts` (WebSocket section)
- **Description:** The WebSocket API (`apigwv2.WebSocketApi`) has no route-level throttling configured. While the REST API has WAF rate limiting, the WebSocket API is unprotected. A malicious client could flood the WebSocket with messages, triggering unlimited Lambda invocations.
- **Impact:** Cost amplification attack. Each WebSocket message triggers an async Lambda invocation (text generation, summary, etc.).
- **Fix:** Add throttling to the WebSocket stage:
```typescript
const wsStage = new apigwv2.WebSocketStage(this, ..., {
  throttle: {
    rateLimit: 10,    // 10 messages per second per connection
    burstLimit: 20,
  },
});
```

---

## Low Issues

### L1. Inconsistent SSM parameter naming conventions
- **Status:** ⬜ Open
- **File:** `lib/api-stack.ts`
- **Description:** Parameter paths use inconsistent prefixes:
  - `/${id}/LAIGO/BedrockLLMId` (stack-prefixed)
  - `/${id}/LAT/FileSizeLimit` (different prefix — "LAT" vs "LAIGO")
  - `/LAIGO/AllowedEmailDomains` (no stack prefix)
  - `/LAIGO/SignupMode` (no stack prefix)
- **Impact:** Confusion when managing parameters across environments. Non-prefixed parameters can't support multiple deployments in the same account.
- **Fix:** Standardize on `/${StackPrefix}/LAIGO/<ParameterName>` for all parameters.

---

### L2. `version` context variable is declared but never used
- **Status:** ⬜ Open
- **File:** `bin/cdk.ts`
- **Description:**
```typescript
const version = app.node.tryGetContext("Version");
```
This variable is declared but never referenced anywhere in the stack definitions.
- **Fix:** Remove the unused variable or implement version tagging.

---

### L3. `cdk.out/` directory appears in the file tree
- **Status:** ⬜ Open
- **File:** `cdk/cdk.out/`
- **Description:** The CDK synthesis output directory contains CloudFormation templates and bundled Lambda assets. This is a build artifact that should not be committed to version control.
- **Fix:** Ensure `cdk.out/` is in `.gitignore` (it may already be — the CDK `.gitignore` includes it, but verify it's not force-added).

---

### L4. Database stack comment says "Delete user pool" but it's about deletion protection
- **Status:** ⬜ Open
- **File:** `lib/database-stack.ts`
- **Description:** Minor: The database has `deletionProtection: true` which is correct, but the `deleteAutomatedBackups: true` means backups are cleaned up when the instance is deleted. If someone removes deletion protection and deletes the instance, all backups are lost.
- **Impact:** Low — deletion protection prevents this scenario. But if protection is ever removed for maintenance, backups would be lost on deletion.
- **Mitigation:** This is acceptable with deletion protection enabled. Document the risk.

---

## Architectural Recommendations

### R1. Split api-stack.ts into focused sub-stacks
- **Priority:** High
- **Description:** The 2609-line monolithic stack should be decomposed into 4-5 focused stacks. This improves deploy times, reduces blast radius of changes, and makes code review tractable.
- **Approach:** Use CDK nested stacks or separate stacks with cross-stack references.

---

### R2. Add production readiness configuration
- **Priority:** High
- **Description:** Create a CDK context-driven configuration that enables production hardening:
  - `natGateways: 2` (HA)
  - `multiAz: true` (database)
  - `dataTraceEnabled: false` (no body logging)
  - Remove localhost from CORS
  - Enable DynamoDB PITR
- **Approach:** Use CDK context `Environment` to switch between dev/prod configurations.

---

### R3. Add WebSocket throttling and abuse protection
- **Priority:** Medium
- **Description:** The WebSocket API lacks rate limiting. Add stage-level throttling and consider per-connection message rate limiting in the `default.js` handler.

---

### R4. Implement infrastructure testing
- **Priority:** Medium
- **Description:** The `cdk/test/` directory exists but appears minimal. Add:
  - Snapshot tests for CloudFormation output stability
  - Fine-grained assertions for security-critical resources (IAM policies, security groups, encryption settings)
  - Integration tests for cross-stack references

---

## Review Progress

- [x] Architecture & folder structure
- [x] Lambda functions (Python)
- [x] Lambda functions (Node.js handlers)
- [x] CDK infrastructure (all 7 stacks)
- [ ] Frontend (React app, auth flow, API service layer)
- [ ] Database (migrations, schema)
- [ ] Security (holistic view)
