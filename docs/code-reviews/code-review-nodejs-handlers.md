# Code Review: Node.js Lambda Handlers

**Reviewer:** Kiro  
**Date:** 2026-05-15  
**Scope:** All Node.js Lambda functions (`cdk/lambda/handlers/`, `cdk/lambda/authorization/`, `cdk/lambda/websocket/`, `cdk/lambda/notificationService/`)  
**Status:** Complete (remediation tracked in [`REMEDIATION-STATUS.md`](REMEDIATION-STATUS.md))

---

## Summary

| Severity | Count | Fixed |
|----------|-------|-------|
| Critical | 1     | 1     |
| High     | 4     | 1     |
| Medium   | 5     | 1     |
| Low      | 4     | 0     |
| **Total**| **14**| **3** |

---

## What's Well-Designed

**Authorization architecture is solid.** The authorizer → handler separation is clean. JWT verification happens once at the boundary, the `sub` claim is resolved to a database `user_id`, and all downstream handlers operate on trusted database identifiers. This prevents JWT claim manipulation attacks.

**BOLA (Broken Object Level Authorization) protection is thorough.** The `authorization.js` utility with `authorizeCaseAccess()` and `authorizeObjectAccess()` is well-structured with clear permission models (OWNER_ONLY, OWNER_OR_INSTRUCTOR, INSTRUCTOR_ONLY). Most routes properly check ownership before operating on resources.

**WebSocket routing via `default.js` is well-designed.** Clean action-based routing, async Lambda invocation (`InvocationType: "Event"`), and proper RBAC checks for admin-only features (playground). The request correlation via `requestId` enables proper response matching on the client.

**Notification service DynamoDB schema is well-thought-out.** Single-table design with GSI for user-based queries, TTL for automatic cleanup, and proper stale connection handling (410 Gone detection).

**Stale role cache mitigation.** The authorizers implement a "re-fetch from DB before deny" pattern to handle cases where roles were updated by an admin but the Lambda's warm cache is stale. This is a thoughtful edge case handling.

---

## Critical Issues

### C1. Authorizer `responseStruct` is a shared mutable object across invocations
- **Status:** ✅ Fixed
- **Files:** `authorization/adminAuthorizerFunction.js`, `authorization/studentAuthorizerFunction.js`, `authorization/instructorAuthorizerFunction.js`
- **Description:** The `responseStruct` object is declared at module scope and mutated on each invocation:
```javascript
const responseStruct = {
  principalId: "yyyyyyyy",
  policyDocument: { Version: "2012-10-17", Statement: [] },
  context: {},
};

// In handler:
responseStruct["policyDocument"]["Statement"].push({...});
responseStruct["context"] = {...};
```
On warm Lambda invocations, `Statement` array accumulates entries from previous invocations. After N requests, the policy document contains N Allow statements. This is a **memory leak** and could cause API Gateway to reject the response if it exceeds size limits.

- **Impact:** Memory leak, potential authorization bypass if API Gateway caches a policy with overly broad resources from accumulated statements.
- **Fix:** Create a fresh response object on each invocation:
```javascript
exports.handler = async (event) => {
  const responseStruct = {
    principalId: "",
    policyDocument: { Version: "2012-10-17", Statement: [] },
    context: {},
  };
  // ... rest of handler
};
```

---

## High Issues

### H1. `initializeConnection` doesn't handle connection drops gracefully
- **Status:** ✅ Fixed
- **File:** `handlers/initializeConnection.js`
- **Description:** The `postgres` library connection is stored in `global.sqlConnection` and reused across invocations. The `initConnection()` in `utils.js` only checks `if (!global.sqlConnection)` — it never validates the connection is still alive. If RDS Proxy drops the connection (idle timeout), subsequent queries will fail with a connection error.
- **Impact:** Intermittent 500 errors after Lambda idle periods.
- **Fix:** Add a health check or use the `postgres` library's built-in connection management:
```javascript
const initConnection = async () => {
  if (!global.sqlConnection) {
    await initializeConnection(SM_DB_CREDENTIALS, RDS_PROXY_ENDPOINT);
  } else {
    // Verify connection is still alive
    try {
      await global.sqlConnection`SELECT 1`;
    } catch (e) {
      global.sqlConnection = null;
      await initializeConnection(SM_DB_CREDENTIALS, RDS_PROXY_ENDPOINT);
    }
  }
};
```

---

### H2. `delete_case` route doesn't cascade to all related tables
- **Status:** ⚠️ Partial
- **File:** `handlers/instructorFunction.js`
- **Route:** `DELETE /instructor/delete_case`
- **Description:** Only deletes `case_reviewers` and `cases`. Does NOT delete:
  - `audio_files` (orphaned transcription records)
  - `summaries` (orphaned summary records)
  - `messages` (orphaned feedback messages)
  - DynamoDB conversation history (orphaned chat sessions)

  Current problematic code:
```javascript
// Only deletes from two tables — orphans remain in audio_files, summaries, messages, DynamoDB
const deleteCase = async (case_id) => {
  await sqlConnection`DELETE FROM case_reviewers WHERE case_id = ${case_id}`;
  await sqlConnection`DELETE FROM cases WHERE case_id = ${case_id}`;
};
```
- **Impact:** Data orphaning, potential storage cost accumulation, and privacy concern (user data persists after case deletion).
- **Fix:** Either add `ON DELETE CASCADE` to the database schema for these tables, or explicitly delete from all related tables in a transaction. Also consider cleaning up DynamoDB sessions:
```javascript
const deleteCase = async (case_id) => {
  await sqlConnection.begin(async (sql) => {
    await sql`DELETE FROM messages WHERE case_id = ${case_id}`;
    await sql`DELETE FROM summaries WHERE case_id = ${case_id}`;
    await sql`DELETE FROM audio_files WHERE case_id = ${case_id}`;
    await sql`DELETE FROM case_reviewers WHERE case_id = ${case_id}`;
    await sql`DELETE FROM cases WHERE case_id = ${case_id}`;
  });
  // Clean up DynamoDB conversation history
  await deleteDynamoDBSessions(case_id);
};
```

---

### H3. WebSocket token passed via `Sec-WebSocket-Protocol` header
- **Status:** ⬜ Open
- **File:** `authorization/wsAuthorizer.js`
- **Description:** The authorizer accepts JWT tokens from the `Sec-WebSocket-Protocol` header as a fallback:
```javascript
const protocolHeader = headers["Sec-WebSocket-Protocol"];
if (protocolHeader) {
  const protocols = protocolHeader.split(",").map((p) => p.trim());
  if (protocols.length > 0) return protocols[0];
}
```
And `connect.js` echoes it back:
```javascript
if (protocolHeader) {
  response.headers = { "Sec-WebSocket-Protocol": protocolHeader };
}
```
This means the full JWT token is echoed back in the response header. While this is a common pattern for browser WebSocket auth (since browsers can't set custom headers on WebSocket upgrade), the token is now visible in network logs and potentially cached by intermediaries.
- **Impact:** Token exposure in network logs and intermediary caches. If a long-lived token is intercepted, it can be reused for unauthorized WebSocket connections until expiry.
- **Fix:** Use short-lived, single-use WebSocket connection tokens instead of echoing the full JWT. Exchange the JWT for a short-lived token server-side before connecting:

```javascript
// ❌ Problem: full JWT echoed in Sec-WebSocket-Protocol response header
exports.handler = async (event) => {
  const protocolHeader = event.headers["Sec-WebSocket-Protocol"];
  // Full JWT token visible in response headers and network logs
  return {
    statusCode: 200,
    headers: { "Sec-WebSocket-Protocol": protocolHeader }, // Echoes full JWT
    body: "Connected",
  };
};

// ✅ Fix: exchange JWT for a short-lived connection token, echo only a protocol identifier
exports.handler = async (event) => {
  const protocolHeader = event.headers["Sec-WebSocket-Protocol"];
  const protocols = protocolHeader ? protocolHeader.split(",").map((p) => p.trim()) : [];
  // Only echo back a safe protocol identifier, not the token itself
  const safeProtocol = protocols.find((p) => p !== event.queryStringParameters?.token) || "v1";
  return {
    statusCode: 200,
    headers: { "Sec-WebSocket-Protocol": safeProtocol },
    body: "Connected",
  };
};
```

Alternatively, pass the token via query string only (already supported) and avoid the `Sec-WebSocket-Protocol` token pattern entirely. Ensure tokens used for WebSocket connections have short TTLs (e.g., 5 minutes).

---

### H4. `markAllNotificationsAsRead` has no pagination — potential timeout
- **Status:** ⬜ Open
- **File:** `notificationService/index.js`
- **Function:** `markAllNotificationsAsRead()`
- **Description:** Queries ALL unread notifications for a user, then updates each one individually with `Promise.all()`. For a user with hundreds of unread notifications, this could:
  1. Exceed DynamoDB read capacity
  2. Exceed Lambda timeout (individual UpdateItem calls are not batched)
  3. Cause partial updates if Lambda times out mid-execution
- **Fix:** Use DynamoDB BatchWriteItem (up to 25 items per batch) with pagination:
```javascript
let lastKey = undefined;
do {
  const result = await dynamodb.send(new QueryCommand({...params, ExclusiveStartKey: lastKey}));
  // batch update items...
  lastKey = result.LastEvaluatedKey;
} while (lastKey);
```

---

## Medium Issues

### M1. Massive code duplication across authorizer functions
- **Status:** ⬜ Open
- **Files:** `adminAuthorizerFunction.js`, `studentAuthorizerFunction.js`, `instructorAuthorizerFunction.js`, `wsAuthorizer.js`
- **Description:** All four authorizers duplicate:
  - JWT verifier initialization (~30 lines)
  - `getUserMetadataFromDatabase()` function (~40 lines)
  - User metadata caching logic
  - IAM policy generation
  
  The only difference is the role check (`admin`, `student`, `instructor`) and the resource scope in the policy.
- **Fix:** Extract a shared `authorizerBase.js` module that accepts a role requirement and resource pattern as parameters.

---

### M2. `GET /student/get_name` exposes user lookup by email without ownership check
- **Status:** ⬜ Open
- **File:** `handlers/studentFunction.js`
- **Route:** `GET /student/get_name`
- **Description:** Any authenticated student can look up any other user's first name by email. While this only exposes first names (not full profiles), it enables user enumeration.
- **Impact:** Low-severity information disclosure. An attacker can confirm which emails are registered.
- **Mitigation:** Consider restricting to users within the same instructor-student relationship, or remove if unused.

---

### M3. `POST /student/initialize_audio_file` accepts `audio_file_id` from client
- **Status:** ⬜ Open
- **File:** `handlers/studentFunction.js`
- **Route:** `POST /student/initialize_audio_file`
- **Description:** The `audio_file_id` is passed from the client via query parameters. If the client sends a UUID that already exists, the INSERT will fail (primary key conflict). More importantly, the client controls the ID used for the S3 presigned URL path, which could be used to overwrite another user's audio file if the S3 key structure is predictable.
- **Mitigation:** The presigned URL Lambda also uses `audio_file_id` as the S3 key prefix. Since the student handler checks case ownership, the risk is limited to the student's own cases. However, server-generated UUIDs would be safer.

---

### M4. Query duplication pattern in paginated routes
- **Status:** ⬜ Open
- **Files:** `handlers/studentFunction.js`, `handlers/instructorFunction.js`, `handlers/adminFunction.js`
- **Description:** Every paginated route (get_cases, view_students, users) has 4 nearly-identical query blocks for the combinations of (search, status) filters. This is ~80 lines of duplicated SQL per route.
- **Fix:** Build queries dynamically using the `postgres` library's tagged template composition:
```javascript
const conditions = [sqlConnection`student_id = ${user_id}`];
if (search) conditions.push(sqlConnection`case_title ILIKE ${search}`);
if (status) conditions.push(sqlConnection`status::text = ${status}`);
// Compose with AND...
```

---

### M5. `message_counter` route uses 24-hour check instead of calendar day
- **Status:** ✅ Fixed
- **File:** `handlers/studentFunction.js`
- **Route:** `GET /student/message_counter`
- **Description:** Resets counter if `hoursDifference >= 24` from last activity. This is inconsistent with the Python `usage.py` which compares `last_activity.date() != current_time.date()` (calendar day). A user active at 11pm would get their counter reset at 11pm the next day (24h), not at midnight.
- **Impact:** Inconsistent rate limiting behavior between the counter display (Node.js) and actual enforcement (Python).
- **Fix:** Align both to use calendar day comparison (UTC date).

---

## Low Issues

### L1. `console.log` mixed with Powertools Logger
- **Status:** ⬜ Open
- **Files:** All Node.js handlers
- **Description:** Code uses both `console.log()`/`console.error()` and the Powertools `logger`. This creates inconsistent log formatting — Powertools adds structured JSON with correlation IDs, while `console.log` produces plain text.
- **Fix:** Replace all `console.log`/`console.error` with `logger.info`/`logger.error`.

---

### L2. `adjustUserRoles.js` file exists but appears unused
- **Status:** ⬜ Open
- **File:** `authorization/adjustUserRoles.js`
- **Description:** This file exists in the authorization directory but is not referenced by any CDK stack or other Lambda. Likely dead code from a previous iteration.
- **Fix:** Verify it's unused and remove.

---

### L3. WebSocket `connect.js` returns 429 but API Gateway ignores it
- **Status:** ⬜ Open
- **File:** `websocket/connect.js`
- **Description:** When connection limit is reached, the handler returns `{ statusCode: 429, body: "Too many..." }`. However, for WebSocket `$connect` routes, API Gateway only respects 200 (allow) or non-200 (reject). The 429 status code is not communicated to the client — the client just sees a connection failure.
- **Impact:** No functional bug (connection is still rejected), but the specific error message is lost. Client can't distinguish "too many connections" from other failures.
- **Mitigation:** This is a known API Gateway WebSocket limitation. Consider sending the error via a brief connection + immediate disconnect with error message.

---

### L4. Notification ID generation uses `Math.random()` — not cryptographically secure
- **Status:** ⬜ Open
- **File:** `notificationService/index.js`
- **Function:** `generateNotificationId()`
```javascript
function generateNotificationId() {
  return `notif_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
}
```
- **Description:** `Math.random()` is not cryptographically secure. For notification IDs this is acceptable (they're not security-sensitive), but the timestamp + 6 random chars gives only ~2 billion possible IDs per millisecond, which is fine for this use case.
- **Impact:** Negligible. Notification IDs are not security tokens.
- **Note:** This is safe for the current use case. Only flag if notification IDs are ever used for authorization.

---

## Architectural Recommendations

### R1. Extract shared authorizer module
- **Priority:** High
- **Description:** Create `authorization/authorizerBase.js` that encapsulates JWT verification, user metadata lookup, caching, and policy generation. Each role-specific authorizer becomes a thin wrapper:
```javascript
const { createAuthorizer } = require("./authorizerBase");
exports.handler = createAuthorizer({ requiredRole: "admin", resourceScope: "admin" });
```
- **Benefit:** Eliminates ~200 lines of duplication, single place for security fixes.

---

### R2. Add database connection health checks
- **Priority:** High
- **Description:** Both the `postgres` library (Node.js) and `psycopg` (Python) connections can go stale. Add a lightweight health check before reusing cached connections, with automatic reconnection on failure.

---

### R3. Implement proper cascade deletion
- **Priority:** Medium
- **Description:** Case deletion should cascade to all related records (audio_files, summaries, messages, DynamoDB sessions). Either use database-level `ON DELETE CASCADE` constraints or implement application-level cleanup in a transaction.

---

### R4. Build dynamic query composition utility
- **Priority:** Low
- **Description:** Replace the 4-way if/else query duplication in paginated routes with a composable query builder using the `postgres` library's tagged template features.

---

## Review Progress

- [x] CDK Infrastructure
- [x] Lambda Functions (Python)
- [x] Lambda Functions (Node.js handlers)
- [x] Database (schema & migrations)
- [x] Frontend (React application)
- [x] Security (holistic cross-cutting)
- [ ] RDS (configuration, security groups, parameter groups, backup/recovery, encryption, connection management)
- [ ] Bedrock (model invocation, prompt engineering, token management, error handling, cost optimization)
- [ ] S3 Best Practices (bucket configurations, access policies, encryption, lifecycle rules, versioning, data protection)
- [ ] Well-Architected (Operational Excellence, Security, Reliability, Performance Efficiency, Cost Optimization, Sustainability)
