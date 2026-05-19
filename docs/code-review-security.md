# Code Review: Security (Holistic View)

**Reviewer:** Kiro  
**Date:** 2026-05-15  
**Scope:** End-to-end security posture across all layers (frontend, API, Lambda, database, infrastructure)  
**Status:** Complete

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

## Security Architecture Overview

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
- **Source:** CDK Infrastructure review (C1)
- **Vector:** Network / Man-in-the-Middle
- **Description:** `NODE_TLS_REJECT_UNAUTHORIZED: "0"` in `dbFlow-stack.ts` disables all certificate verification for the migration Lambda. This Lambda connects to RDS Proxy with admin credentials.
- **Exploitability:** Requires network-level access within the VPC (compromised Lambda in same VPC, or VPC peering misconfiguration).
- **Impact:** Admin database credentials could be intercepted.
- **Remediation:** Remove the env var. Use the RDS CA bundle for certificate validation.

---

### S-C2. Text generation Lambda has admin database credentials
- **Source:** CDK Infrastructure review (H3)
- **Vector:** Privilege Escalation
- **Description:** The text generation Lambda (student-facing, processes user input) is granted `db.secretPathAdmin` instead of `db.secretPathUser`. If this Lambda is compromised (e.g., via prompt injection leading to code execution in a dependency), the attacker gets admin-level database access.
- **Exploitability:** Requires Lambda compromise (dependency vulnerability, SSRF, etc.).
- **Impact:** Full database access including DDL operations, user credential modification, and data exfiltration.
- **Remediation:** Change to `db.secretPathUser.secretName`.

---

### S-C3. Authorizer response object accumulates across invocations
- **Source:** Node.js Handlers review (C1)
- **Vector:** Authorization Bypass (theoretical)
- **Description:** The `responseStruct` in authorizer Lambdas is a module-level mutable object. The `Statement` array grows on each warm invocation. While API Gateway likely only uses the latest response, the growing policy document could cause unexpected behavior.
- **Exploitability:** Low — requires specific API Gateway caching behavior to exploit.
- **Impact:** Potential memory exhaustion or policy document size limit errors causing auth failures.
- **Remediation:** Create fresh response objects per invocation.

---

## High Security Issues

### S-H1. Race condition in rate limiting allows bypass
- **Source:** Lambda Functions review (C3)
- **Vector:** Rate Limit Bypass
- **Description:** `check_and_increment_usage()` does SELECT then UPDATE without row locking. Concurrent requests can both read the same counter, allowing users to exceed their daily message limit.
- **Exploitability:** Easy — send multiple concurrent requests.
- **Impact:** Unlimited Bedrock API calls, cost amplification.
- **Remediation:** Use atomic UPDATE with RETURNING or SELECT FOR UPDATE.

---

### S-H2. Message limit fails open on error
- **Source:** Lambda Functions review (H1)
- **Vector:** Rate Limit Bypass
- **Description:** If the usage check throws an exception (DB connection failure), the request proceeds without rate limiting (`pass` in except block).
- **Exploitability:** Trigger a database connection error (e.g., connection pool exhaustion).
- **Impact:** Unlimited Bedrock API calls during database outages.
- **Remediation:** Fail closed — return 503 when usage check fails.

---

### S-H3. WebSocket API has no rate limiting
- **Source:** CDK Infrastructure review (M6)
- **Vector:** Cost Amplification / DoS
- **Description:** The WebSocket API has no stage-level throttling. Each message triggers an async Lambda invocation (text generation = Bedrock API call). A malicious client can flood messages.
- **Exploitability:** Easy — any authenticated user can send rapid WebSocket messages.
- **Impact:** Unbounded Lambda invocations and Bedrock API costs.
- **Remediation:** Add WebSocket stage throttling + per-connection rate limiting in `default.js`.

---

### S-H4. `dataTraceEnabled: true` logs sensitive legal content
- **Source:** CDK Infrastructure review (M2)
- **Vector:** Data Exposure
- **Description:** API Gateway logs full request/response bodies to CloudWatch, including case descriptions, legal analysis, and AI-generated content that may be subject to client-solicitor privilege.
- **Exploitability:** Anyone with CloudWatch Logs access can read privileged legal content.
- **Impact:** Potential breach of client-solicitor privilege. Compliance violation.
- **Remediation:** Set `dataTraceEnabled: false` in production.

---

### S-H5. S3 CORS includes localhost in production
- **Source:** CDK Infrastructure review (M4)
- **Vector:** Cross-Origin Attack
- **Description:** Production S3 buckets allow CORS from `http://localhost:5173`. An attacker with valid credentials running a local server can upload files to production buckets.
- **Exploitability:** Requires valid authentication credentials + local server.
- **Impact:** Unauthorized file uploads to audio storage bucket.
- **Remediation:** Remove localhost from production CORS origins.

---

### S-H6. Guardrail bypass on initial conversation turn
- **Source:** Lambda Functions review (H4)
- **Vector:** AI Safety Bypass
- **Description:** The first message in a conversation (empty `question`) constructs the initial prompt from `case_description` without applying Bedrock guardrails. If case description contains malicious content, it bypasses PII and prompt attack detection.
- **Exploitability:** Requires modifying case description after creation (admin path or direct DB access).
- **Impact:** Prompt injection or PII leakage on first conversation turn.
- **Remediation:** Apply guardrails to the constructed initial query as well.

---

### S-H7. No cascade deletion leaves orphaned sensitive data
- **Source:** Node.js Handlers review (H2) + Database review (H1)
- **Vector:** Data Retention Violation
- **Description:** Case deletion doesn't clean up DynamoDB conversation history (contains full AI chat sessions with potentially privileged legal content). The `case_reviewers` table also lacks CASCADE.
- **Exploitability:** N/A — this is a data lifecycle issue.
- **Impact:** Privileged legal content persists after case deletion. Potential GDPR/privacy compliance issue.
- **Remediation:** Add DynamoDB cleanup to case deletion flow. Add CASCADE to `case_reviewers`.

---

## Medium Security Issues

### S-M1. Playground has no role-based authorization
- **Source:** Lambda Functions review (M3)
- **Vector:** Unauthorized Access
- **Description:** The playground Lambda has no `check_authorization()` call. The WebSocket `default.js` does check `isStaff` for playground actions, but if the Lambda is invoked directly (e.g., via API Gateway if exposed), there's no protection.
- **Remediation:** Add role check in the playground Lambda handler itself (defense in depth).

---

### S-M2. User enumeration via `/student/get_name`
- **Source:** Node.js Handlers review (M2)
- **Vector:** Information Disclosure
- **Description:** Any authenticated user can look up any other user's first name by email address, confirming which emails are registered.
- **Remediation:** Restrict to users within the same instructor-student relationship.

---

### S-M3. Client-controlled `audio_file_id` for S3 key
- **Source:** Node.js Handlers review (M3)
- **Vector:** Path Traversal (theoretical)
- **Description:** The client provides `audio_file_id` which becomes part of the S3 key path. While UUID format limits exploitation, the pattern of client-controlled storage paths is risky.
- **Remediation:** Generate `audio_file_id` server-side.

---

### S-M4. CORS falls back to wildcard silently
- **Source:** Lambda Functions review (M4)
- **Vector:** Cross-Origin Attack
- **Description:** When `ALLOWED_ORIGIN` is not set, all Lambdas return `Access-Control-Allow-Origin: *`. A misconfigured deployment silently loses CORS protection.
- **Remediation:** Log a warning. Consider failing closed (return no CORS header) when not configured.

---

### S-M5. Stale database connections not detected
- **Source:** Lambda Functions review (H3) + Node.js Handlers review (H1)
- **Vector:** Availability / DoS
- **Description:** Both Python and Node.js Lambdas cache database connections but don't detect server-side drops. After RDS Proxy idle timeout, the next request fails.
- **Remediation:** Add connection health checks with automatic reconnection.

---

### S-M6. SQL injection pattern in password creation
- **Source:** Database review (C1)
- **Vector:** SQL Injection (latent)
- **Description:** Passwords interpolated into PL/pgSQL strings. Currently safe (hex-only) but dangerous pattern.
- **Remediation:** Use parameterized queries for user creation.

---

### S-M7. No DynamoDB point-in-time recovery
- **Source:** CDK Infrastructure review (M5)
- **Vector:** Data Loss
- **Description:** Conversation history (potentially privileged legal content) has no backup mechanism.
- **Remediation:** Enable PITR on critical DynamoDB tables.

---

### S-M8. Inconsistent message counter reset logic
- **Source:** Node.js Handlers review (M5)
- **Vector:** Rate Limit Inconsistency
- **Description:** Node.js uses 24-hour window, Python uses calendar day. Users can exploit the gap.
- **Remediation:** Align both to UTC calendar day.

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

### Immediate (before production)
1. Remove `NODE_TLS_REJECT_UNAUTHORIZED: "0"` from migration Lambda
2. Change text generation Lambda to use `secretPathUser` instead of `secretPathAdmin`
3. Fix authorizer `responseStruct` mutation bug
4. Set `dataTraceEnabled: false`
5. Remove localhost from production S3 CORS

### Short-term (within 2 weeks)
6. Fix rate limiting race condition (atomic UPDATE)
7. Change rate limiting to fail closed
8. Add WebSocket stage throttling
9. Apply guardrails to initial conversation turn
10. Add `ON DELETE CASCADE` to `case_reviewers`

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

## Review Progress — COMPLETE

- [x] Architecture & folder structure
- [x] Lambda functions (Python)
- [x] Lambda functions (Node.js handlers)
- [x] CDK infrastructure (all 7 stacks)
- [x] Frontend (React app, auth flow, API service layer)
- [x] Database (migrations, schema, setup)
- [x] Security (holistic view)

---

## Cross-Reference to Individual Review Documents

| Document | Location |
|----------|----------|
| Lambda Functions (Python) | `docs/code-review-lambda-functions.md` |
| Node.js Handlers | `docs/code-review-nodejs-handlers.md` |
| CDK Infrastructure | `docs/code-review-cdk-infrastructure.md` |
| Frontend (React) | `docs/code-review-frontend.md` |
| Database | `docs/code-review-database.md` |
| Security (this document) | `docs/code-review-security.md` |
