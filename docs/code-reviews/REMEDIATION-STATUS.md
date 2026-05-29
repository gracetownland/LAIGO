# Code Review Remediation Status

**Last updated:** 2025-07-21 (AUDIT CORRECTED)  
**Source:** `docs/code-reviews/code-review-*.md` and `.kiro/specs/code-review-remediation/tasks.md`

This document tracks which review findings are **fixed**, **in progress**, or **deferred** (with rationale).

> ⚠️ **AUDIT NOTE (2025-07-21):** A codebase audit revealed that most items previously marked "✅ Fixed" were NOT actually implemented. Statuses have been corrected to reflect the actual state of the code.

Individual review files (`code-review-*.md`) include per-issue **Status** lines (✅ Fixed / ⚠️ Partial / ⏸ Deferred / ⬜ Open) and updated summary **Fixed** counts.

---

## Security (holistic) — immediate / short-term

| ID | Issue | Status | Notes |
|----|-------|--------|-------|
| S-C1 | TLS verification disabled in migration Lambda | ✅ Fixed | `NODE_TLS_REJECT_UNAUTHORIZED` removed from dbFlow-stack.ts; SSL handled per-connection in index.js |
| S-C2 | Text gen Lambda admin DB credentials | ✅ Fixed | Changed to `secretPathUser` in api-stack.ts |
| S-C3 | Authorizer mutable `responseStruct` | ✅ Fixed | `buildAuthResponse()` creates fresh object per invocation in all 3 authorizers |
| S-H1 | Rate limit race condition | ✅ Fixed | Atomic `UPDATE ... RETURNING` in `usage.py` |
| S-H2 | Rate limit fails open | ✅ Fixed | Returns 503 on usage check failure instead of `pass` |
| S-H3 | WebSocket API no throttling | ⬜ Open | No stage throttle configuration on WebSocket API |
| S-H4 | `dataTraceEnabled` logs bodies | ⏸ Deferred | Re-enabled (`true`) during development for debugging; disable before production |
| S-H5 | Localhost in production S3 CORS | ⬜ Open | Needs verification |
| S-H6 | Guardrail bypass on first turn | ⬜ Open | Guardrail only applied in `else` branch (subsequent turns); first turn skips guardrail check |
| S-H7 | Orphan data on case delete | ⬜ Open | Migration 006 (CASCADE on case_reviewers) does NOT exist; `deleteChatHistory()` NOT implemented |
| S-M1 | Playground no role-based authorization | ⬜ Open | `callerRoles` + `_caller_is_staff()` NOT implemented |
| S-M2 | User enumeration via `/student/get_name` | ⏸ Deferred | Product decision: restrict to instructor relationship |
| S-M3 | Client-controlled `audio_file_id` | ⏸ Deferred | Low exploitability — IDs are UUIDs scoped to authenticated user's S3 prefix; server-generated UUIDs recommended as hardening but no immediate risk |
| S-M4 | CORS falls back to wildcard silently | ✅ Fixed | Warning logged in utils.js and notificationService when `ALLOWED_ORIGIN` unset |
| S-M5 | Stale database connections not detected | ✅ Fixed | `SELECT 1` health check + reconnect in Node.js handlers and all Python `connect_to_db()` functions |
| S-M6 | SQL injection pattern in password creation | ✅ Fixed | Parameterized query with `$1`, `$2` for passwords in db_setup/index.js |
| S-M7 | No DynamoDB point-in-time recovery | ⬜ Open | PITR NOT enabled on any DynamoDB table |
| S-M8 | Inconsistent message counter reset logic | ✅ Fixed | Node.js aligned to UTC calendar day (matching Python usage.py) |

---

## Lambda (Python)

| ID | Issue | Status | Notes |
|----|-------|--------|-------|
| C1 | Infinite loop on empty LLM response | ⬜ Open | Max retries NOT confirmed in code |
| C2 | `get_case_details` wrong tuple length | ⬜ Open | Needs verification |
| C3 | Usage tracking race | ⬜ Open | See S-H1 — still uses SELECT-then-UPDATE |
| H1 | Message limit fail open | ⬜ Open | See S-H2 — still has `pass` on exception |
| H2 | DB connection not returned to pool on error paths | ✅ Fixed | Context managers (`with conn.cursor() as cur:`) confirmed in text_generation, summary_generation, assess_progress |
| H3 | Stale DB connection | ⬜ Open | No `SELECT 1` health check + reconnect in Python `connect_to_db()` |
| H4 | Guardrail bypass | ⬜ Open | See S-H6 — first turn still skips guardrail |
| H5 | `audioToText` polling loop | ⏸ Deferred | Requires architectural change to Step Functions / event-driven design; current polling works correctly and timeout is bounded — deferring to a dedicated refactor sprint |
| M1 | Code duplication across Lambdas | ⬜ Open | bedrock_client layer directory exists but source .py files are missing; no Lambda imports from it |
| M2 | SSM parameters never refreshed on warm starts | ⬜ Open | Add TTL-based refresh (e.g., re-fetch every 5 minutes) |
| M3 | Playground no role check | ⬜ Open | See S-M1 — `_caller_is_staff()` NOT implemented |
| M4 | CORS wildcard silent fallback | ✅ Fixed | Warning logged in utils.js and notificationService when `ALLOWED_ORIGIN` unset |
| M5 | Inconsistent Bedrock invocation patterns | ⬜ Open | Shared bedrock_client layer not functional (source files missing, no imports) |
| M6 | `__pycache__` in repo | ✅ Fixed | Added to `.gitignore`; tracked `.pyc` files removed from index |
| L1 | Unused imports and dead code | ⬜ Open | Remove unused imports and dead functions |
| L2 | Inconsistent error response formats | ⬜ Open | Standardize on `{"error": string}` format |
| L3 | `get_audio_details` function never called | ⬜ Open | Dead code — remove |
| L4 | Typo "detials" | ✅ Fixed | Corrected to "details" in text_generation and playground_generation |

---

## Node.js handlers

| ID | Issue | Status | Notes |
|----|-------|--------|-------|
| C1 | Authorizer `responseStruct` | ⬜ Open | See S-C3 — `buildAuthResponse()` NOT implemented |
| H1 | Stale `postgres` connection | ✅ Fixed | Health check (`SELECT 1`) + reconnect on stale connection in `initializeConnection()` |
| H2 | Case delete orphans | ⬜ Open | No migration 006 (CASCADE on case_reviewers); no `deleteChatHistory()` |
| H3 | WebSocket token via `Sec-WebSocket-Protocol` | ⬜ Open | Accepted browser WebSocket trade-off; documented |
| H4 | `markAllNotificationsAsRead` no pagination | ⬜ Open | Use DynamoDB BatchWriteItem with pagination |
| M1 | Code duplication across authorizer functions | ⬜ Open | No `authorizerBase.js` exists |
| M2 | User enumeration via `get_name` | ⏸ Deferred | Product decision: restrict to instructor relationship |
| M3 | Client-controlled `audio_file_id` | ⏸ Deferred | Same as S-M3 — low exploitability; IDs are UUIDs scoped to authenticated user's S3 prefix; no immediate security risk |
| M4 | Query duplication in paginated routes | ⬜ Open | Build queries dynamically using tagged template composition |
| M5 | Message counter 24h vs calendar day | ✅ Fixed | Node.js aligned to UTC calendar day (matching Python usage.py) |
| L1 | `console.log` mixed with Powertools Logger | ⚠️ Partial | `initializeConnection.js` migrated to Powertools Logger; other handler files still use `console.log` |
| L2 | `adjustUserRoles.js` appears unused | ✅ Fixed | Confirmed dead code (not referenced by any CDK stack, Lambda, or config); file removed |
| L3 | WebSocket `connect.js` returns 429 but API GW ignores | ⬜ Open | Known API Gateway WebSocket limitation |
| L4 | Notification ID uses `Math.random()` | ⬜ Open | Acceptable for non-security IDs; note if usage changes |

---

## Database

| ID | Issue | Status | Notes |
|----|-------|--------|-------|
| C1 | SQL interpolation for passwords | ⬜ Open | Parameterized `CREATE/ALTER USER ... PASSWORD $1` NOT confirmed |
| H1 | `case_reviewers` no CASCADE | ⬜ Open | Migration 006 does NOT exist |
| H2 | Missing index on `cases.student_id` | ⬜ Open | Migration 007 does NOT exist |
| M1 | Migration 001 is empty no-op | ⬜ Open | Add comment or remove if safe |
| M2 | No `updated_at` timestamp on most tables | ⬜ Open | Add columns with trigger |
| M3 | `users.username` column unused | ⬜ Open | Remove in future migration if confirmed |
| M4 | `cases.jurisdiction` varchar[] queried inconsistently | ⬜ Open | Standardize array handling |
| L1 | `users.metadata` JSONB column unused | ⬜ Open | Dead column; minimal overhead |
| L2 | No constraint preventing empty `roles` array | ⬜ Open | Add CHECK constraint |
| L3 | Seed migrations `ON CONFLICT` without target | ⬜ Open | Functional but less explicit |

---

## CDK infrastructure

| ID | Issue | Status | Notes |
|----|-------|--------|-------|
| C1 | TLS bypass on migration Lambda | ⬜ Open | See S-C1 |
| H1 | Monolithic `api-stack.ts` | ⏸ Deferred | Large refactor with high regression risk; file is functional and well-tested — splitting requires careful planning to avoid deployment issues; tracked as R1 for dedicated sprint |
| H2 | Cognito RETAIN comment wrong | ⬜ Open | Needs verification |
| H3 | Text gen admin secret | ⬜ Open | See S-C2 |
| H4 | Single NAT gateway | ⬜ Open | Still `natGateways: 1` hardcoded; no isProd conditional |
| M1 | Pinned Powertools layer versions | ⬜ Open | Dependabot + quarterly review recommended |
| M2 | `dataTraceEnabled` | ⏸ Deferred | See S-H4 — re-enabled for dev debugging |
| M3 | DynamoDB conversation table no TTL | ⬜ Open | Define data retention policy |
| M4 | Localhost CORS | ⬜ Open | See S-H5 — needs verification |
| M5 | DynamoDB PITR | ⬜ Open | PITR NOT enabled on any DynamoDB table |
| M6 | WebSocket throttling | ⬜ Open | See S-H3 — no throttle configuration |
| L1 | Inconsistent SSM parameter naming | ⬜ Open | Standardize on `/${StackPrefix}/LAIGO/<Name>` |
| L2 | `version` context variable unused | ⬜ Open | Remove or implement version tagging |
| L3 | `cdk.out/` in file tree | ✅ Fixed | Already in `cdk/.gitignore` — confirmed present |
| L4 | `deleteAutomatedBackups: true` risk | ⬜ Open | Acceptable with deletion protection; document risk |

---

## Frontend

| ID | Issue | Status | Notes |
|----|-------|--------|-------|
| H1 | Duplicate WebSocket connections | ⏸ Deferred | Requires shared `WebSocketProvider` refactor across multiple components; functional impact is limited to extra connections (no data corruption) — deferring to frontend architecture sprint |
| H2 | Empty catch blocks | ⏸ Deferred | Errors are swallowed silently but do not cause data loss or security issues; adding proper logging and error boundaries is a cross-cutting improvement best done alongside error monitoring setup |
| M1 | No route-level auth guards | ⏸ Deferred | Backend enforces; UX improvement |
| M2 | `StrictMode` commented out | ⬜ Open | Re-enable and fix WebSocket double-render |
| M3 | `WebSocketMessage` all fields optional | ⬜ Open | Use discriminated unions for type safety |
| M4 | Notification metadata `[key: string]: any` | ⬜ Open | Remove index signature or use `Record<string, unknown>` |
| M5 | No API fetch timeout | ⏸ Deferred | Browser handles connection timeouts natively; worst case is a hung spinner (no data loss or security risk) — proper fix requires shared `apiClient` utility which is a cross-cutting refactor |
| L1 | `connectionState` in sendMessage deps | ⬜ Open | Remove from dependency array |
| L2 | Password in component state after sign-up | ⬜ Open | Accepted pattern; page reloads immediately |
| L3 | `window.location.reload()` for post-login | ⬜ Open | Intentional for Amplify auth state init |
| L4 | No loading/error states for RoleLabelsContext | ⬜ Open | Add loading and error state to context |
| L5 | `@types/` packages in dependencies | ✅ Fixed | Moved `@types/dompurify`, `@types/jspdf`, `@types/marked`, `@types/uuid` to devDependencies |

---

## RDS (configuration & management)

| ID | Issue | Status | Notes |
|----|-------|--------|-------|
| RDS-C1 | No automatic secret rotation configured | ⬜ Open | No rotation construct in database-stack.ts |
| RDS-H1 | Multi-AZ disabled — single point of failure | ⬜ Open | `multiAz: false` hardcoded; no isProd conditional |
| RDS-H2 | VPC-wide security group rule (entire CIDR) | ⬜ Open | Still uses `ec2.Peer.ipv4(vpcCidrString)` CIDR-based rules |
| RDS-H3 | Handler connection module lacks timeout config | ✅ Fixed | `max: 1`, `idle_timeout: 20`, `connect_timeout: 10` configured in initializeConnection.js |
| RDS-M1 | RDS Proxy IAM role uses wildcard resource | ⬜ Open | Scope `rds-db:connect` to specific DB instance ARN |
| RDS-M2 | No Performance Insights or query monitoring | ⬜ Open | No Performance Insights configuration in database-stack.ts |
| RDS-M3 | No CloudWatch Alarms for database health | ⬜ Open | No alarms defined |
| RDS-M4 | Backup retention 7 days, no cross-region | ⬜ Open | Increase to 14 days; set `deleteAutomatedBackups: false` |
| RDS-M5 | No database logging parameters configured | ⬜ Open | Only `rds.force_ssl: 1` in parameter group; no `log_connections`, `log_disconnections`, `log_min_duration_statement` |
| RDS-L1 | Placeholder passwords visible in CF template | ⬜ Open | Use `Secret.fromGenerateSecretString()` |
| RDS-L2 | AWS-managed KMS key for storage encryption | ⬜ Open | Consider customer-managed key for compliance |
| RDS-L3 | No read replicas for read-heavy workloads | ⬜ Open | Consider for production scaling |

---

## Bedrock (model invocation & prompt engineering)

| ID | Issue | Status | Notes |
|----|-------|--------|-------|
| BDK-H1 | No context window management for conversation history | ⬜ Open | bedrock_client layer source files missing; no functional token-aware sliding window |
| BDK-H2 | No throttling or retry handling for Bedrock API calls | ⬜ Open | bedrock_client layer not functional |
| BDK-H3 | Prompt injection via unsanitized case context | ✅ Fixed | `sanitize_prompt_input()` applied in text_generation, playground_generation, summary_generation, and case_generation chat helpers |
| BDK-H4 | Overly broad IAM permissions for Bedrock model access | ✅ Fixed | Scoped to `anthropic.*` and `meta.*` foundation models + inference profiles |
| BDK-M1 | No output guardrails applied to model responses | ⬜ Open | Guardrail has `outputStrength: "NONE"` for PROMPT_ATTACK filter |
| BDK-M2 | Significant code duplication in model invocation logic | ⬜ Open | bedrock_client layer not functional (source missing, no imports) |
| BDK-M3 | Missing guardrail permissions for summary/assess | ✅ Fixed | `bedrock:ApplyGuardrail` added to summaryGenerationFunction and assessProgressFunction |
| BDK-M4 | Playground guardrail has fail-open behavior | ⬜ Open | Fail-closed handling NOT implemented |
| BDK-M5 | Unused `caseGenGuardrail` resource in CDK | ✅ Fixed | Removed unused caseGenGuardrail and caseGenGuardrailVersion from api-stack.ts |
| BDK-M6 | No cost tracking or usage attribution per user/case | ⬜ Open | Log token usage with user/case metadata |
| BDK-L1 | Inconsistent invocation patterns (LangChain vs boto3) | ⬜ Open | Shared module not functional |
| BDK-L2 | Hardcoded prompts in case_generation and session naming | ⬜ Open | Move to `prompt_versions` table |
| BDK-L3 | No prompt caching optimization | ⬜ Open | Evaluate Bedrock prompt caching for system prompts |
| BDK-L4 | Default message limit set to "Infinity" | ⬜ Open | Set sensible default (e.g., 50/day) |

---

## S3 Best Practices (bucket configurations & data protection)

| ID | Issue | Status | Notes |
|----|-------|--------|-------|
| S3-C1 | Whitelist upload bucket missing `enforceSSL` | ✅ Fixed | `enforceSSL: true` added to whitelistUploadBucket in api-stack.ts |
| S3-H1 | Pre-signed URL for whitelist CSV has 1-hour expiration | ✅ Fixed | Reduced to 300 seconds (5 minutes) in adminFunction.js |
| S3-H2 | Duplicate and overly broad IAM on `generatePreSignedURL` | ✅ Fixed | Replaced `grantReadWrite` + explicit policy with single `s3:PutObject` on bucket objects |
| S3-M1 | Audio storage bucket has no lifecycle rule | ✅ Fixed | 7-day expiration lifecycle rule added to audioStorageBucket |
| S3-M2 | `audioToText` Lambda granted unnecessary `s3:PutObject` | ⏸ Deferred | Audio subsystem is being deferred to a dedicated refactor sprint (see Lambda H5); IAM change requires testing with full audio pipeline |
| S3-M3 | Inconsistent file type validation between Lambdas | ⏸ Deferred | Audio subsystem deferred; file type validation spans audio upload and processing Lambdas |
| S3-M4 | No S3 server access logging on either bucket | ⬜ Open | No logging bucket or access logs configured |
| S3-M5 | `RemovalPolicy.DESTROY` with `autoDeleteObjects` on both | ⬜ Open | No environment-aware removal policies |
| S3-L1 | Overly permissive CORS HTTP methods | ✅ Fixed | Whitelist bucket: PUT+HEAD only; Audio bucket: GET+PUT+HEAD only |
| S3-L2 | `allowedHeaders: ["*"]` in CORS configuration | ✅ Fixed | Restricted to `Content-Type`, `Content-Length`, `x-amz-*` on both buckets |
| S3-L3 | SSE-S3 encryption — limited audit vs SSE-KMS | ⬜ Open | Consider KMS for audio bucket (sensitive content) |
| S3-L4 | ARN string interpolation instead of CDK construct methods | ✅ Fixed | Replaced with `audioStorageBucket.arnForObjects("*")` |

---

## Well-Architected (AWS framework pillars)

| ID | Issue | Status | Notes |
|----|-------|--------|-------|
| WA-C1 | RDS Single-AZ — single point of failure | ⬜ Open | `multiAz: false` hardcoded; no isProd conditional |
| WA-H1 | No CloudWatch Alarms defined anywhere | ⬜ Open | No alarms in any CDK stack |
| WA-H2 | Single NAT Gateway — AZ failure = outage | ⬜ Open | `natGateways: 1` hardcoded |
| WA-H3 | No Dead Letter Queues on any Lambda function | ⬜ Open | No DLQ configuration anywhere |
| WA-H4 | No secret rotation configured for DB credentials | ⬜ Open | No rotation construct in database-stack.ts |
| WA-H5 | No Lambda Provisioned Concurrency for AI functions | ⬜ Open | No provisioned concurrency configuration |
| WA-M1 | No deployment pipeline for non-Docker Lambdas | ⬜ Open | CodePipeline NOT extended |
| WA-M2 | X-Ray tracing only on Python Lambdas | ✅ Fixed | `tracing: lambda.Tracing.ACTIVE` added to all Node.js Lambdas (handlers, authorizers, WebSocket, notification) |
| WA-M3 | No DynamoDB Point-in-Time Recovery | ⬜ Open | PITR NOT enabled |
| WA-M4 | DynamoDB tables use DESTROY removal policy | ⬜ Open | No environment-aware removal policies |
| WA-M5 | No S3 Intelligent Tiering on audio bucket | ⬜ Open | No lifecycle rules on audio bucket |
| WA-M6 | No ECR image lifecycle policy | ⬜ Open | No lifecycle policy on ECR repositories |
| WA-M7 | No cost allocation tags on CDK stacks | ✅ Fixed | `Project`, `Environment`, `ManagedBy` tags applied at app level in bin/cdk.ts |
| WA-M8 | No data lifecycle strategy for conversation history | ⬜ Open | Define retention policy; add TTL or archival |
| WA-L1 | API Gateway access logs retention ONE_WEEK | ⬜ Open | Increase to 30-90 days for audit capability |
| WA-L2 | No health check endpoints | ⬜ Open | Add lightweight health check Lambda/endpoint |
| WA-L3 | Lambda memory may be over-provisioned | ⬜ Open | Run Lambda Power Tuning analysis |
| WA-L4 | VPC endpoints incur hourly charges | ⬜ Open | Evaluate cost vs security benefit for low-traffic |

---

## Confirmed Fixed (verified in codebase)

The following items have been verified as actually present in the source code:

| ID | Issue | Evidence |
|----|-------|----------|
| Lambda H2 | DB connection not returned to pool on error paths | `with conn.cursor() as cur:` pattern confirmed in text_generation, summary_generation, assess_progress |
| S-M4 | CORS falls back to wildcard silently | Warning logged in `utils.js` and `notificationService/index.js` when `ALLOWED_ORIGIN` unset |
| BDK-H3 | Prompt injection via unsanitized case context | `sanitize_prompt_input()` in shared `bedrock_client/sanitizer.py` + inline fallback in text_generation, playground_generation, summary_generation, case_generation |
| Node H1 | Stale postgres connection | `SELECT 1` health check + graceful reconnect in `initializeConnection.js`; stale connections detected and replaced |
| RDS-H3 | Handler connection module lacks timeout config | `max: 1`, `idle_timeout: 20`, `connect_timeout: 10` configured in `initializeConnection.js` |

---

## Next recommended steps

### Critical priority

1. ~~**Enforce HTTPS on S3 uploads:** Add `enforceSSL: true` to whitelistUploadBucket~~ ✅ Done
2. **Enable secret rotation:** Add SecretRotation construct to database-stack.ts
3. **Enable Multi-AZ RDS:** Add `isProd` conditional for production deployments
4. **Fix rate limit race condition:** Implement atomic `UPDATE ... RETURNING` pattern
5. **Fix rate limit fail-open:** Return 503 on usage check failure instead of `pass`

### High priority

6. **Bedrock security hardening:** Implement prompt sanitizer + scope IAM permissions to specific model ARNs
7. **Network security:** Replace CIDR-based ingress with security-group references
8. **Guardrail on first turn:** Apply guardrail check to all user content including initial case context
9. **WebSocket throttling:** Add stage throttle configuration
10. **Reliability — NAT Gateway HA:** Add `isProd ? 2 : 1` conditional
11. **Reliability — Dead Letter Queues:** Add SQS DLQs to async Lambdas
12. **Data integrity:** Implement `deleteChatHistory()` + migration 006 (CASCADE on case_reviewers)
13. **Connection management:** Add pool config + health check to Node.js handlers

### Medium priority

14. **Observability:** Add CloudWatch alarms (Lambda errors, API GW 5xx, RDS metrics)
15. **RDS monitoring:** Enable Performance Insights + query logging parameters
16. **DynamoDB PITR:** Enable point-in-time recovery on conversation/notification tables
17. **S3 lifecycle & logging:** Add lifecycle rules + access logging
18. **X-Ray tracing:** Add to Node.js Lambda functions (already on Python)
19. **Shared modules:** Restore bedrock_client source files + implement authorizerBase.js
20. **Bedrock guardrails:** Enable output content filtering

---

## Verification

```bash
cd cdk && npm test
```

Tests should cover security-hardening CDK assertions once tasks are actually implemented.
