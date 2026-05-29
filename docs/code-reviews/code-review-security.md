# Code Review: Security (Holistic View)

**Reviewer:** Kiro  
**Date:** 2026-05-15  
**Scope:** End-to-end security posture across all layers (frontend, API, Lambda, database, infrastructure)  
**Status:** Complete  
**Remediation:** See [`REMEDIATION-STATUS.md`](REMEDIATION-STATUS.md) (updated 2026-05-19)

---

## Summary

This document consolidates security findings from all previous review areas into a holistic security assessment. Issues are categorized by attack vector rather than by code location.

| Category | Critical | High | Medium | Low |
|----------|----------|------|--------|-----|
| Authentication & Authorization | 0 | 1 | 2 | 0 |
| Data Protection | 1 | 2 | 2 | 0 |
| Input Validation & Injection | 1 | 1 | 1 | 0 |
| Network & Transport Security | 1 | 1 | 0 | 0 |
| AI/LLM Security | 0 | 1 | 1 | 0 |
| Rate Limiting & Abuse | 0 | 1 | 2 | 0 |
| **Total** | **3** | **7** | **8** | **0** |

---

## What's Well-Designed

The application implements a defense-in-depth approach:

```
Client → CloudFront WAF → API Gateway WAF → Lambda Authorizer → Handler (BOLA check) → RDS Proxy → PostgreSQL
         (rate limit)     (rate limit)       (JWT + DB role)     (ownership query)      (TLS)       (SSL enforced)
```

**Strengths of the security architecture:**
1. JWT validation at boundary with database-backed role resolution (not JWT claims)
2. Per-function IAM roles with least-privilege grants
3. Object-level authorization (BOLA protection) in every handler
4. WAF with both IP-based and per-user rate limiting
5. Database in private isolated subnets with no public access
6. RDS Proxy with TLS enforcement
7. Bedrock guardrails for PII and prompt injection protection
8. S3 buckets with enforceSSL, encryption, and BLOCK_ALL public access
9. VPC endpoints for private service access (Secrets Manager, RDS)
10. Security headers on all responses (CSP, HSTS, X-Frame-Options, X-Content-Type-Options)

---

## Critical Security Issues

### S-C1. TLS verification disabled in migration Lambda
- **Status:** ✅ Fixed
- **File:** `cdk/lib/dbFlow-stack.ts`
- **Source:** CDK Infrastructure review (C1). See also: [cdk-infrastructure] C1
- **Vector:** Network / Man-in-the-Middle
- **Description:** `NODE_TLS_REJECT_UNAUTHORIZED: "0"` in `dbFlow-stack.ts` disables all certificate verification for the migration Lambda. This Lambda connects to RDS Proxy with admin credentials.
- **Exploitability:** Requires network-level access within the VPC (compromised Lambda in same VPC, or VPC peering misconfiguration).
- **Impact:** Admin database credentials could be intercepted.
- **Fix:**

**Problem:**
```typescript
environment: {
  DB_SECRET_NAME: db.secretPathAdmin.secretName,
  NODE_TLS_REJECT_UNAUTHORIZED: "0", // Disables ALL TLS verification
},
```

**Fixed:**
```typescript
environment: {
  DB_SECRET_NAME: db.secretPathAdmin.secretName,
  NODE_EXTRA_CA_CERTS: "/opt/rds-ca/global-bundle.pem", // Use RDS CA bundle
},
```

---

### S-C2. Text generation Lambda has admin database credentials
- **Status:** ✅ Fixed
- **File:** `cdk/lib/dbFlow-stack.ts`
- **Source:** CDK Infrastructure review (H3). See also: [cdk-infrastructure] H3
- **Vector:** Privilege Escalation
- **Description:** The text generation Lambda (student-facing, processes user input) is granted `db.secretPathAdmin` instead of `db.secretPathUser`. If this Lambda is compromised (e.g., via prompt injection leading to code execution in a dependency), the attacker gets admin-level database access.
- **Exploitability:** Requires Lambda compromise (dependency vulnerability, SSRF, etc.).
- **Impact:** Full database access including DDL operations, user credential modification, and data exfiltration.
- **Fix:**

**Problem:**
```typescript
environment: {
  DB_SECRET_NAME: db.secretPathAdmin.secretName, // Admin credentials on student-facing Lambda
},
```

**Fixed:**
```typescript
environment: {
  DB_SECRET_NAME: db.secretPathUser.secretName, // Least-privilege: app user only
},
```

---

### S-C3. Authorizer response object accumulates across invocations
- **Status:** ✅ Fixed
- **File:** `cdk/lambda/authorization/adminAuthorizerFunction.js` (and student/instructor equivalents)
- **Source:** Node.js Handlers review (C1). See also: [nodejs-handlers] C1
- **Vector:** Authorization Bypass (theoretical)
- **Description:** The `responseStruct` in authorizer Lambdas is a module-level mutable object. The `Statement` array grows on each warm invocation. While API Gateway likely only uses the latest response, the growing policy document could cause unexpected behavior.
- **Exploitability:** Low — requires specific API Gateway caching behavior to exploit.
- **Impact:** Potential memory exhaustion or policy document size limit errors causing auth failures.
- **Fix:**

**Problem:**
```javascript
// Module-level mutable object — shared across warm invocations
const responseStruct = {
  principalId: "",
  policyDocument: {
    Version: "2012-10-17",
    Statement: [] // This array GROWS on each invocation!
  },
  context: {}
};

exports.handler = async (event) => {
  // ...
  responseStruct.policyDocument.Statement.push({ Effect: "Allow", Resource: resource });
  return responseStruct;
};
```

**Fixed:**
```javascript
const { buildAuthResponse } = require("./authResponseBuilder");

exports.handler = async (event) => {
  // ...
  // Fresh object per invocation — no shared state
  return buildAuthResponse(user.user_id, "Allow", resource, {
    userId: user.user_id,
    email: user.email,
    firstName: user.first_name,
    lastName: user.last_name,
    roles: JSON.stringify(user.roles),
  });
};
```

---

## High Security Issues

### S-H1. Race condition in rate limiting allows bypass
- **Status:** ✅ Fixed
- **File:** `cdk/lambda/text_generation/src/main.py`
- **Source:** Lambda Functions review (C3). See also: [lambda-functions] C3
- **Vector:** Rate Limit Bypass
- **Description:** `check_and_increment_usage()` does SELECT then UPDATE without row locking. Concurrent requests can both read the same counter, allowing users to exceed their daily message limit.
- **Exploitability:** Easy — send multiple concurrent requests.
- **Impact:** Unlimited Bedrock API calls, cost amplification.
- **Fix:**

**Problem:**
```python
def check_and_increment_usage(user_id, daily_limit):
    count = db.execute("SELECT message_count FROM usage WHERE user_id = %s AND date = CURRENT_DATE", (user_id,))
    if count >= daily_limit:
        raise LimitExceeded()
    db.execute("UPDATE usage SET message_count = message_count + 1 WHERE user_id = %s AND date = CURRENT_DATE", (user_id,))
```

**Fixed:**
```python
def check_and_increment_usage(user_id, daily_limit):
    result = db.execute("""
        UPDATE usage SET message_count = message_count + 1
        WHERE user_id = %s AND date = CURRENT_DATE AND message_count < %s
        RETURNING message_count
    """, (user_id, daily_limit))
    if not result:
        raise LimitExceeded()
```

---

### S-H2. Message limit fails open on error
- **Status:** ✅ Fixed
- **File:** `cdk/lambda/text_generation/src/main.py`
- **Source:** Lambda Functions review (H1). See also: [lambda-functions] H1
- **Vector:** Rate Limit Bypass
- **Description:** If the usage check throws an exception (DB connection failure), the request proceeds without rate limiting (`pass` in except block).
- **Exploitability:** Trigger a database connection error (e.g., connection pool exhaustion).
- **Impact:** Unlimited Bedrock API calls during database outages.
- **Fix:**

**Problem:**
```python
try:
    check_and_increment_usage(user_id, daily_limit)
except Exception:
    pass  # Fails open — request proceeds without rate limiting
```

**Fixed:**
```python
try:
    check_and_increment_usage(user_id, daily_limit)
except Exception as e:
    logger.error(f"Usage check failed: {e}")
    return {"statusCode": 503, "body": json.dumps({"error": "Service temporarily unavailable"})}
```

---

### S-H3. WebSocket API has no rate limiting
- **Status:** ⬜ Open
- **File:** `cdk/lib/api-stack.ts`
- **Source:** CDK Infrastructure review (M6). See also: [cdk-infrastructure] M6
- **Vector:** Cost Amplification / DoS
- **Description:** The WebSocket API has no stage-level throttling. Each message triggers an async Lambda invocation (text generation = Bedrock API call). A malicious client can flood messages.
- **Exploitability:** Easy — any authenticated user can send rapid WebSocket messages.
- **Impact:** Unbounded Lambda invocations and Bedrock API costs.
- **Fix:**

**Problem:**
```typescript
const webSocketStage = new apigwv2.WebSocketStage(this, "WebSocketStage", {
  webSocketApi,
  stageName: "prod",
  autoDeploy: true,
  // No throttling configured
});
```

**Fixed:**
```typescript
const webSocketStage = new apigwv2.WebSocketStage(this, "WebSocketStage", {
  webSocketApi,
  stageName: "prod",
  autoDeploy: true,
  throttle: {
    rateLimit: 10,   // 10 messages per second
    burstLimit: 20,  // Allow short bursts
  },
});
```

---

### S-H4. `dataTraceEnabled: true` logs sensitive legal content
- **Status:** ⏸ Deferred (re-enabled for development debugging; disable before production)
- **File:** `cdk/lib/api-stack.ts`
- **Source:** CDK Infrastructure review (M2). See also: [cdk-infrastructure] M2
- **Vector:** Data Exposure
- **Description:** API Gateway logs full request/response bodies to CloudWatch, including case descriptions, legal analysis, and AI-generated content that may be subject to client-solicitor privilege.
- **Exploitability:** Anyone with CloudWatch Logs access can read privileged legal content.
- **Impact:** Potential breach of client-solicitor privilege. Compliance violation.
- **Fix:**

**Problem:**
```typescript
const logGroup = new logs.LogGroup(this, "ApiAccessLogs");
const stage = api.deploymentStage;
stage.node.addDependency(logGroup);
// dataTraceEnabled: true — logs full request/response bodies
```

**Fixed:**
```typescript
const stage = api.deploymentStage;
// Disable full data tracing in production to protect privileged content
// dataTraceEnabled: false (default) — only logs metadata, not bodies
```

---

### S-H5. S3 CORS includes localhost in production
- **Status:** ⬜ Open
- **File:** `cdk/lib/storage-stack.ts`
- **Source:** CDK Infrastructure review (M4). See also: [cdk-infrastructure] M4
- **Vector:** Cross-Origin Attack
- **Description:** Production S3 buckets allow CORS from `http://localhost:5173`. An attacker with valid credentials running a local server can upload files to production buckets.
- **Exploitability:** Requires valid authentication credentials + local server.
- **Impact:** Unauthorized file uploads to audio storage bucket.
- **Fix:**

**Problem:**
```typescript
cors: [{
  allowedOrigins: [
    "https://app.example.com",
    "http://localhost:5173", // Dev origin in production!
  ],
  allowedMethods: [s3.HttpMethods.PUT, s3.HttpMethods.GET],
}],
```

**Fixed:**
```typescript
cors: [{
  allowedOrigins: [
    "https://app.example.com",
    // localhost removed — use separate dev bucket or env-based config
  ],
  allowedMethods: [s3.HttpMethods.PUT, s3.HttpMethods.GET],
}],
```

---

### S-H6. Guardrail bypass on initial conversation turn
- **Status:** ⬜ Open
- **File:** `cdk/lambda/text_generation/src/main.py`
- **Source:** Lambda Functions review (H4). See also: [lambda-functions] H4
- **Vector:** AI Safety Bypass
- **Description:** The first message in a conversation (empty `question`) constructs the initial prompt from `case_description` without applying Bedrock guardrails. If case description contains malicious content, it bypasses PII and prompt attack detection.
- **Exploitability:** Requires modifying case description after creation (admin path or direct DB access).
- **Impact:** Prompt injection or PII leakage on first conversation turn.
- **Fix:**

**Problem:**
```python
if not question:
    # Initial turn — constructs prompt from case_description directly
    prompt = build_initial_prompt(case_description, system_prompt)
    response = bedrock.invoke_model(prompt)  # No guardrail applied
```

**Fixed:**
```python
if not question:
    prompt = build_initial_prompt(case_description, system_prompt)
    response = bedrock.invoke_model(
        prompt,
        guardrailIdentifier=guardrail_id,
        guardrailVersion=guardrail_version,
    )
```

---

### S-H7. No cascade deletion leaves orphaned sensitive data
- **Status:** ⬜ Open
- **File:** `cdk/lambda/db_setup/migrations/`, `cdk/lambda/nodejs_handlers/src/`
- **Source:** Node.js Handlers review (H2) + Database review (H1). See also: [nodejs-handlers] H2, [database] H1
- **Vector:** Data Retention Violation
- **Description:** Case deletion doesn't clean up DynamoDB conversation history (contains full AI chat sessions with potentially privileged legal content). The `case_reviewers` table also lacks CASCADE.
- **Exploitability:** N/A — this is a data lifecycle issue.
- **Impact:** Privileged legal content persists after case deletion. Potential GDPR/privacy compliance issue.
- **Fix:**

**Problem:**
```javascript
// Case deletion handler — only deletes from PostgreSQL
async function deleteCase(caseId) {
  await db.query("DELETE FROM cases WHERE id = $1", [caseId]);
  // DynamoDB conversation history is NOT cleaned up
}
```

**Fixed:**
```javascript
async function deleteCase(caseId) {
  // Delete from PostgreSQL (case_reviewers cascades automatically via migration 006)
  await db.query("DELETE FROM cases WHERE id = $1", [caseId]);
  // Clean up DynamoDB conversation history
  const conversations = await dynamodb.query({
    TableName: CONVERSATIONS_TABLE,
    KeyConditionExpression: "caseId = :caseId",
    ExpressionAttributeValues: { ":caseId": caseId },
  }).promise();
  for (const item of conversations.Items) {
    await dynamodb.delete({ TableName: CONVERSATIONS_TABLE, Key: { caseId, sortKey: item.sortKey } }).promise();
  }
}
```

---

## Medium Security Issues

### S-M1. Playground has no role-based authorization
- **Status:** ⬜ Open
- **File:** `cdk/lambda/text_generation/src/main.py`
- **Source:** Lambda Functions review (M3). See also: [lambda-functions] M3
- **Vector:** Unauthorized Access
- **Description:** The playground Lambda has no `check_authorization()` call. The WebSocket `default.js` does check `isStaff` for playground actions, but if the Lambda is invoked directly (e.g., via API Gateway if exposed), there's no protection.
- **Impact:** Unauthorized users could access playground functionality if Lambda is exposed outside WebSocket router.
- **Fix:** Add role check in the playground Lambda handler itself (defense in depth).

---

### S-M2. User enumeration via `/student/get_name`
- **Status:** ⏸ Deferred
- **File:** `cdk/lambda/nodejs_handlers/src/studentFunction.js`
- **Source:** Node.js Handlers review (M2). See also: [nodejs-handlers] M2
- **Vector:** Information Disclosure
- **Description:** Any authenticated user can look up any other user's first name by email address, confirming which emails are registered.
- **Impact:** Enables user enumeration attacks; attacker can confirm registered email addresses.
- **Fix:** Restrict to users within the same instructor-student relationship.

---

### S-M3. Client-controlled `audio_file_id` for S3 key
- **Status:** ⏸ Deferred
- **File:** `cdk/lambda/nodejs_handlers/src/studentFunction.js`
- **Source:** Node.js Handlers review (M3). See also: [nodejs-handlers] M3
- **Vector:** Path Traversal (theoretical)
- **Description:** The client provides `audio_file_id` which becomes part of the S3 key path. While UUID format limits exploitation, the pattern of client-controlled storage paths is risky.
- **Impact:** Potential path traversal or overwrite of other users' files if UUID validation is bypassed.
- **Fix:** Generate `audio_file_id` server-side.

---

### S-M4. CORS falls back to wildcard silently
- **Status:** ✅ Fixed
- **File:** `cdk/lambda/text_generation/src/main.py`, `cdk/lambda/nodejs_handlers/src/`
- **Source:** Lambda Functions review (M4). See also: [lambda-functions] M4
- **Vector:** Cross-Origin Attack
- **Description:** When `ALLOWED_ORIGIN` is not set, all Lambdas return `Access-Control-Allow-Origin: *`. A misconfigured deployment silently loses CORS protection.
- **Impact:** Cross-origin requests from any domain would be accepted, enabling CSRF-like attacks.
- **Fix:** Log a warning. Consider failing closed (return no CORS header) when not configured.

---

### S-M5. Stale database connections not detected
- **Status:** ✅ Fixed
- **File:** `cdk/lambda/text_generation/src/main.py`, `cdk/lambda/nodejs_handlers/src/initializeConnection.js`
- **Source:** Lambda Functions review (H3) + Node.js Handlers review (H1). See also: [lambda-functions] H3, [nodejs-handlers] H1
- **Vector:** Availability / DoS
- **Description:** Both Python and Node.js Lambdas cache database connections but don't detect server-side drops. After RDS Proxy idle timeout, the next request fails.
- **Impact:** Intermittent 500 errors after idle periods; cascading failures during connection pool exhaustion.
- **Fix:** Add connection health checks with automatic reconnection.

---

### S-M6. SQL injection pattern in password creation
- **Status:** ✅ Fixed
- **File:** `cdk/lambda/db_setup/migrations/000_initial_schema.js`
- **Source:** Database review (H1). See also: [database] H1
- **Vector:** SQL Injection (latent)
- **Description:** Passwords interpolated into PL/pgSQL strings. Currently safe (hex-only) but dangerous pattern.
- **Impact:** If password generation logic changes to include special characters, SQL injection becomes exploitable.
- **Fix:** Use parameterized queries for user creation.

---

### S-M7. No DynamoDB point-in-time recovery
- **Status:** ⬜ Open
- **File:** `cdk/lib/api-stack.ts`
- **Source:** CDK Infrastructure review (M5). See also: [cdk-infrastructure] M5
- **Vector:** Data Loss
- **Description:** Conversation history (potentially privileged legal content) has no backup mechanism.
- **Impact:** Permanent data loss if table is accidentally deleted or corrupted; no recovery path for compliance audits.
- **Fix:** Enable PITR on critical DynamoDB tables.

---

### S-M8. Inconsistent message counter reset logic
- **Status:** ✅ Fixed
- **File:** `cdk/lambda/nodejs_handlers/src/default.js`, `cdk/lambda/text_generation/src/main.py`
- **Source:** Node.js Handlers review (M5). See also: [nodejs-handlers] M5
- **Vector:** Rate Limit Inconsistency
- **Description:** Node.js uses 24-hour window, Python uses calendar day. Users can exploit the gap.
- **Impact:** Users can exceed intended daily limits by timing requests around the reset boundary mismatch.
- **Fix:** Align both to UTC calendar day.

---

## Architectural Recommendations

### 1. Adopt Fail-Closed Pattern Universally
All security controls (rate limiting, authorization, input validation) should fail closed. When a security check cannot be performed (e.g., database unavailable), deny the request rather than allowing it through. This prevents attackers from exploiting outage conditions to bypass protections.

### 2. Implement Defense-in-Depth for AI Safety
Apply Bedrock guardrails to both input and output. Currently only input is checked, meaning a compromised model or prompt injection that bypasses input filtering could produce harmful output. Add output guardrails as a second layer of protection.

### 3. Unify Rate Limiting Logic
Consolidate rate limiting into a shared module used by both Python and Node.js handlers. This eliminates inconsistencies (calendar day vs. 24-hour window) and ensures atomic operations are used consistently. Consider a dedicated rate limiting service or Redis-based counter for cross-Lambda consistency.

### 4. Implement Data Lifecycle Management
Create a comprehensive data deletion flow that cascades across all storage systems (PostgreSQL, DynamoDB, S3). This is critical for GDPR compliance and client-solicitor privilege protection. Consider implementing a "soft delete" pattern with scheduled hard deletion to allow recovery from accidental deletions.

### 5. Split Monolithic API Stack
The current single `api-stack.ts` creates a large blast radius — a misconfiguration affects all endpoints. Split into domain-specific stacks (auth, student, instructor, admin) with separate IAM roles and security boundaries. This limits the impact of any single compromise.

### 6. Add Security Testing to CI/CD
Implement CDK assertion tests that validate security invariants (no public access, encryption enabled, TLS enforced) as part of the deployment pipeline. This prevents security regressions from being deployed. See also: [cdk-infrastructure] Architectural Recommendations.

---

## Security Posture Assessment

### Authentication: Strong ✅
- Cognito with email verification
- 12-character password policy with complexity requirements
- JWT verification at API boundary
- Database-backed role resolution (not JWT claims — prevents token manipulation)
- Session storage (not localStorage) for tokens
- Token rotation before expiry on WebSocket connections

### Authorization: Strong ✅ (with minor gaps)
- Per-role Lambda authorizers with database role verification
- Object-level authorization (BOLA) on every handler route
- Permission models (OWNER_ONLY, OWNER_OR_INSTRUCTOR, INSTRUCTOR_ONLY)
- Stale cache mitigation (re-fetch before deny)
- **Gap:** Playground Lambda lacks internal role check (relies on WebSocket router)

### Network Security: Strong ✅ (with one critical exception)
- VPC with private isolated subnets for database
- RDS Proxy with TLS enforcement
- VPC endpoints for Secrets Manager and RDS
- S3 enforceSSL
- **Exception:** Migration Lambda disables TLS verification

### Data Protection: Good ⚠️ (with compliance concerns)
- Storage encryption (RDS, S3, DynamoDB)
- Secrets Manager for credentials with rotation
- Security headers on all responses
- **Concern:** `dataTraceEnabled` logs privileged content
- **Concern:** No DynamoDB backup for conversation history
- **Concern:** Orphaned data after case deletion

### Input Validation: Good ⚠️
- Bedrock guardrails for PII and prompt injection
- `rehype-sanitize` for XSS protection on AI output
- Parameterized SQL queries throughout (except migration Lambda)
- WebSocket message validation pipeline
- **Gap:** Initial conversation turn bypasses guardrails
- **Gap:** Latent SQL injection pattern in migration Lambda

### Rate Limiting: Moderate ⚠️
- WAF IP-based rate limiting (2000/5min)
- WAF per-user rate limiting (200/5min via MD5 Authorization header)
- API Gateway throttling (100 req/s, 200 burst)
- Client-side WebSocket rate limiting (10 msg/s)
- **Gap:** WebSocket API has no server-side throttling
- **Gap:** Application-level rate limiting has race condition and fails open

### AI Safety: Good ⚠️
- Bedrock guardrails block PII (NAME, EMAIL, PHONE, SSN, etc.)
- Topic-based blocking (prompt attacks, role manipulation, system prompt leakage)
- Guardrails applied to user input before LLM processing
- **Gap:** Initial conversation turn unguarded
- **Gap:** No output guardrails (only input is checked)

---

## Priority Remediation Roadmap

### Immediate (before production) — ⬜ Open
1. Remove `NODE_TLS_REJECT_UNAUTHORIZED: "0"` from migration Lambda
2. Change text generation Lambda to use `secretPathUser` instead of `secretPathAdmin`
3. Fix authorizer `responseStruct` mutation bug
4. Set `dataTraceEnabled: false` (currently deferred for dev debugging)
5. Remove localhost from production S3 CORS (or make environment-aware)

### Short-term (within 2 weeks) — ⬜ Open
6. Fix rate limiting race condition (atomic UPDATE)
7. Change rate limiting to fail closed
8. Add WebSocket stage throttling
9. Apply guardrails to initial conversation turn
10. Add `ON DELETE CASCADE` to `case_reviewers` (migration 006)

### Medium-term (within 1 month)
11. Add database connection health checks
12. Enable DynamoDB PITR
13. Add DynamoDB cleanup to case deletion
14. Unify WebSocket connections (reduce attack surface)
15. Add role check to playground Lambda

### Long-term (ongoing)
16. Split monolithic api-stack for reduced blast radius
17. Add database audit logging
18. Implement structured error reporting
19. Add infrastructure security testing (CDK assertions)
20. Consider Row-Level Security (RLS) as defense-in-depth

---

## Review Progress

- [x] CDK Infrastructure — Complete
- [x] Lambda Functions (Python) — Complete
- [x] Lambda Functions (Node.js Handlers) — Complete
- [x] Database (Schema & Migrations) — Complete
- [x] Frontend (React Application) — Complete
- [x] Security (Holistic View) — Complete
- [ ] RDS (Configuration & Management) — Planned
- [ ] Bedrock (Model Invocation & AI Safety) — Planned
- [ ] S3 Best Practices (Bucket Configuration & Data Protection) — Planned
- [ ] Well-Architected (AWS Framework Pillars) — Planned

---

## Cross-References to Other Topic Reviews

This security review is cross-cutting and consolidates findings from all other topic reviews. The following table maps each source reference to its original document:

| Document | Location | Referenced Findings |
|----------|----------|---------------------|
| CDK Infrastructure | [`code-review-cdk-infrastructure.md`](code-review-cdk-infrastructure.md) | C1, H3, M2, M4, M5, M6 |
| Lambda Functions (Python) | [`code-review-lambda-functions.md`](code-review-lambda-functions.md) | C3, H1, H3, H4, M3, M4 |
| Node.js Handlers | [`code-review-nodejs-handlers.md`](code-review-nodejs-handlers.md) | C1, H1, H2, M2, M3, M5 |
| Frontend (React) | [`code-review-frontend.md`](code-review-frontend.md) | — |
| Database | [`code-review-database.md`](code-review-database.md) | H1, H2 |
| Remediation Tracker | [`REMEDIATION-STATUS.md`](REMEDIATION-STATUS.md) | All findings tracked |
