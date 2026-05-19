# Code Review: Lambda Functions

**Reviewer:** Kiro  
**Date:** 2026-05-14  
**Scope:** All Python Lambda functions (`cdk/lambda/`)  
**Status:** In Progress (Lambda review complete, remaining areas pending)

---

## Summary

| Severity | Count | Fixed |
|----------|-------|-------|
| Critical | 3     | 0     |
| High     | 5     | 0     |
| Medium   | 6     | 0     |
| Low      | 4     | 0     |
| **Total**| **18**| **0** |

---

## Critical Issues

### C1. Infinite loop if LLM returns empty response
- **Status:** ⬜ Open
- **Files:** `text_generation/src/helpers/chat.py`, `playground_generation/src/helpers/chat.py`
- **Function:** `get_response()`
- **Description:** `while not response` loop retries indefinitely if the LLM consistently returns an empty string (model error, throttling, guardrail blocking output). Lambda runs until timeout (up to 15 min for Docker), burning compute and holding a DB connection.
- **Fix:**
```python
response = ""
max_retries = 3
for attempt in range(max_retries):
    response = generate_response(conversational_chain, query, case_id)
    if response:
        break
if not response:
    raise RuntimeError("LLM returned empty response after retries")
```

---

### C2. `get_case_details` returns wrong tuple length on error
- **Status:** ⬜ Open
- **File:** `text_generation/src/main.py`
- **Function:** `get_case_details()`
- **Description:** Returns 6 values on success but only 4 `None` values on exception. Caller unpacks 6 values, causing `ValueError: not enough values to unpack` — crashes Lambda with unhandled exception instead of clean error.
- **Fix:** Change exception return to `return None, None, None, None, None, None`

---

### C3. Race condition in usage tracking
- **Status:** ⬜ Open
- **File:** `text_generation/src/helpers/usage.py`
- **Function:** `check_and_increment_usage()`
- **Description:** SELECT then UPDATE without row-level locking. Concurrent requests from same user can both read the same counter value, defeating rate limiting.
- **Fix:** Use atomic UPDATE with RETURNING:
```python
cur.execute("""
    UPDATE "users"
    SET activity_counter = CASE 
        WHEN last_activity IS NULL OR last_activity::date != CURRENT_DATE 
        THEN 1 
        ELSE activity_counter + 1 
    END,
    last_activity = NOW()
    WHERE user_id = %s
    RETURNING activity_counter
""", (user_id,))
new_count = cur.fetchone()[0]
```

---

## High Issues

### H1. Message limit "fail open" design
- **Status:** ⬜ Open
- **File:** `text_generation/src/main.py`
- **Line:** ~240
- **Description:** If usage check throws an exception, the error is logged but the request proceeds (`pass`). Database outage = unlimited messages = unlimited Bedrock API cost.
- **Fix:** Fail closed with 503 response when usage check fails.

---

### H2. Database connection not returned to pool on error paths
- **Status:** ⬜ Open
- **Files:** All Python Lambdas
- **Functions:** `get_system_prompt()`, `get_audio_details()`, `get_case_details()`
- **Description:** `cur` variable referenced in `except` block may not be defined if exception occurs before `cur = connection.cursor()`. Raises `NameError`. Use context managers (`with conn.cursor() as cur:`) consistently.

---

### H3. Stale database connection not detected
- **Status:** ⬜ Open
- **Files:** All Python Lambdas
- **Function:** `connect_to_db()`
- **Description:** `connection.closed` only checks Python-side state, not server-side drops (RDS Proxy idle timeout, network blip). First query on stale connection will fail.
- **Fix:** Add health check (`SELECT 1`) before reusing cached connection, with reconnection on failure.

---

### H4. Guardrail bypass on initial conversation
- **Status:** ⬜ Open
- **File:** `text_generation/src/main.py`
- **Description:** When `question` is empty (first turn), no guardrail is applied. The initial query is constructed from `case_description` (user input). If case description contains malicious content injected after creation, it bypasses guardrails.
- **Mitigation:** Case creation applies guardrails, but any post-creation modification path is unguarded.

---

### H5. `audioToText` Lambda polls synchronously with `time.sleep(5)`
- **Status:** ⬜ Open
- **File:** `audioToText/src/main.py`
- **Description:** Polls Transcribe job status in a `while True` loop with 5-second sleeps. Long audio files (10+ min) burn Lambda compute idly. Risk of timeout for very long files.
- **Fix:** Replace with Step Functions or S3 event + completion handler Lambda.

---

## Medium Issues

### M1. Massive code duplication across Python Lambdas
- **Status:** ⬜ Open
- **Files:** All 6 Python Lambdas
- **Description:** `get_cors_origin()`, `create_response()`, `get_secret()`, `get_parameter()`, `connect_to_db()`, `check_authorization()`, `send_to_websocket()` are copy-pasted with minor variations. Bug fixes require changes in 6 places.
- **Fix:** Extract shared Lambda layer or common package.

---

### M2. SSM parameters never refreshed on warm starts
- **Status:** ⬜ Open
- **Files:** All Python Lambdas
- **Function:** `initialize_constants()`
- **Description:** Parameters fetched once on cold start, cached forever. Admin changes to model ID, temperature, etc. in SSM won't take effect until Lambda instances recycle (hours).
- **Fix:** Add TTL-based refresh (e.g., re-fetch every 5 minutes).

---

### M3. `playground_generation` has no role-based authorization
- **Status:** ⬜ Open
- **File:** `playground_generation/src/main.py`
- **Description:** No `check_authorization()` call. Relies only on WebSocket auth (validates authentication, not authorization). Any authenticated student could invoke playground if they know the action name.
- **Fix:** Add role check (admin/instructor only) at handler entry.

---

### M4. CORS origin silently falls back to `"*"`
- **Status:** ⬜ Open
- **Files:** All Python Lambdas
- **Description:** When `ALLOWED_ORIGIN` env var is not set, CORS is wide open. A misconfigured deployment silently degrades security.
- **Fix:** Log a warning when falling back to wildcard.

---

### M5. Inconsistent Bedrock invocation patterns
- **Status:** ⬜ Open
- **Files:** `text_generation` + `playground_generation` use LangChain; `summary_generation` + `assess_progress` use raw boto3
- **Description:** Two different invocation patterns means model compatibility changes need handling in two places. Raw invocation only supports `anthropic.*` and `meta.*` prefixes.
- **Fix:** Standardize on one approach across all Lambdas.

---

### M6. `__pycache__` committed to repository
- **Status:** ⬜ Open
- **File:** `assess_progress/src/__pycache__/`
- **Description:** Compiled Python bytecode in the repo. Should be in `.gitignore`.
- **Fix:** Add `__pycache__/` to `.gitignore`, remove from repo.

---

## Low Issues

### L1. Unused imports and dead code
- **Status:** ⬜ Open
- **Files:**
  - `text_generation/main.py`: `import time`, `import uuid` unused
  - `text_generation/helpers/chat.py`: `split_into_sentences()`, `update_session_name()` unused
  - `playground_generation/helpers/chat.py`: Same dead functions duplicated
  - `case_generation/main.py`: Commented-out handler function
- **Fix:** Remove unused imports and dead code.

---

### L2. Inconsistent error response formats
- **Status:** ⬜ Open
- **Files:** All Lambdas
- **Description:** Some return `{"error": "msg"}`, some return plain strings, some return `{"message": "..."}` for 404s. Frontend must handle all variations.
- **Fix:** Standardize on `{"error": string, "code"?: string}` format.

---

### L3. `get_audio_details` function never called
- **Status:** ⬜ Open
- **File:** `text_generation/src/main.py`
- **Description:** Dead code that queries `case_description` — same data already fetched by `get_case_details`.
- **Fix:** Remove the function.

---

### L4. Typo in system prompt
- **Status:** ⬜ Open
- **File:** `text_generation/src/helpers/chat.py`, `playground_generation/src/helpers/chat.py`
- **Line:** `construct_case_context_prompt()`
- **Description:** "Additional case detials that are relevant" — should be "details".
- **Fix:** Correct the typo.

---

## Architectural Recommendations

### R1. Extract shared Python Lambda layer
- **Priority:** High
- **Description:** Create a shared package (Lambda layer or monorepo shared directory) containing: DB connection management, CORS/response helpers, secrets/parameter fetching, authorization checks, WebSocket helpers.
- **Benefit:** Eliminates duplication across 6 Lambdas, ensures consistent behavior, single place for bug fixes.

---

### R2. Replace polling in `audioToText` with event-driven pattern
- **Priority:** High
- **Description:** Replace `while True` + `time.sleep(5)` polling with Step Functions (wait state + Transcribe completion event) or EventBridge rule on Transcribe job completion.
- **Benefit:** Eliminates idle compute cost, removes timeout risk for long files, improves scalability.

---

### R3. Standardize Bedrock invocation approach
- **Priority:** Medium
- **Description:** Choose either LangChain `ChatBedrockConverse` or raw `boto3.invoke_model` and use it consistently across all Lambdas. Currently split creates maintenance burden and inconsistent model support.
- **Benefit:** Single model compatibility matrix, easier to add new models, consistent error handling.

---

### R4. Add connection pooling awareness
- **Priority:** Medium
- **Description:** Current single global `connection` pattern works for low concurrency but breaks under Lambda provisioned concurrency. Consider `psycopg_pool` or at minimum add reconnection logic with health checks.
- **Benefit:** Resilience to connection drops, better behavior under load.

---

### R5. Define structured error response schema
- **Priority:** Low
- **Description:** Define a consistent error response format (`{error: string, code: string, details?: object}`) and enforce it across all Lambdas (Python and Node.js).
- **Benefit:** Simpler frontend error handling, better debugging, consistent UX.

---

## Review Progress

- [x] Architecture & folder structure
- [x] Lambda functions (Python)
- [ ] Lambda functions (Node.js handlers — partial)
- [ ] CDK infrastructure (api-stack.ts deep dive)
- [ ] Frontend (React app, auth flow, API service layer)
- [ ] Database (migrations, schema)
- [ ] Security (auth flow, authorizers, guardrails)
