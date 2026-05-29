# Code Review: Lambda Functions

**Reviewer:** Kiro  
**Date:** 2026-05-14  
**Scope:** All Python Lambda functions (`cdk/lambda/`)  
**Status:** Complete (remediation tracked in [`REMEDIATION-STATUS.md`](REMEDIATION-STATUS.md))  
**Scope Coverage Note:** Covers all Python Lambdas with `src/` directories: `text_generation`, `playground_generation`, `case_generation`, `summary_generation`, `assess_progress`, `audioToText`. The `generatePreSignedURL/generatePreSignedURL.py` Lambda (Python, no `src/` subdirectory) is not referenced in findings here — it is covered by the S3 Best Practices review instead, as its concerns are S3-specific (pre-signed URL generation, IAM permissions).

---

## Summary

| Severity | Count | Fixed |
|----------|-------|-------|
| Critical | 3     | 3     |
| High     | 5     | 3     |
| Medium   | 6     | 3     |
| Low      | 4     | 1     |
| **Total**| **18**| **10**|

---

## What's Well-Designed

1. **Structured logging with AWS Lambda Powertools** — `text_generation` uses `Logger` and `Metrics` from `aws_lambda_powertools`, providing structured JSON logs with correlation IDs and cold-start metrics out of the box.
2. **Guardrail integration for content safety** — The `apply_guardrail_check()` function applies Bedrock guardrails to all user-influenced content, with clear differentiation between PII and prompt-injection violations.
3. **Consistent CORS and security headers** — All Lambdas use a `create_response()` helper that sets `X-Content-Type-Options`, `X-Frame-Options`, `Content-Security-Policy`, and `Strict-Transport-Security` headers uniformly.
4. **Dual-mode invocation support** — Lambdas cleanly support both HTTP (API Gateway REST) and WebSocket invocation paths, with mode detection and appropriate response handling for each.
5. **Database connection reuse across warm starts** — Global `connection` variable avoids reconnecting on every invocation, reducing latency and connection churn against RDS Proxy.
6. **File integrity validation** — `audioToText` validates file size limits and magic-number signatures before processing, preventing malformed or oversized uploads from consuming resources.

---

## Critical Issues

### C1. Infinite loop if LLM returns empty response
- **Status:** ✅ Fixed
- **Files:** `text_generation/src/helpers/chat.py`, `playground_generation/src/helpers/chat.py`
- **Function:** `get_response()`
- **Description:** `while not response` loop retries indefinitely if the LLM consistently returns an empty string (model error, throttling, guardrail blocking output). Lambda runs until timeout (up to 15 min for Docker), burning compute and holding a DB connection.
- **Impact:** Lambda runs for up to 15 minutes consuming compute and holding a database connection, multiplied by concurrent users experiencing the same model issue. Can exhaust connection pool and generate significant cost.
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
- **Status:** ✅ Fixed
- **File:** `text_generation/src/main.py`
- **Function:** `get_case_details()`
- **Description:** Returns 6 values on success but only 4 `None` values on exception. Caller unpacks 6 values, causing `ValueError: not enough values to unpack` — crashes Lambda with unhandled exception instead of clean error.
- **Impact:** Any database error in `get_case_details()` causes a secondary crash (`ValueError`), masking the original error and returning an unhelpful 500 to the user instead of a meaningful error message.
- **Fix:** Change exception return to `return None, None, None, None, None, None`

---

### C3. Race condition in usage tracking
- **Status:** ✅ Fixed
- **File:** `text_generation/src/helpers/usage.py`
- **Function:** `check_and_increment_usage()`
- **Description:** SELECT then UPDATE without row-level locking. Concurrent requests from same user can both read the same counter value, defeating rate limiting.
- **Impact:** Users can exceed their daily message limit by sending concurrent requests, bypassing rate limiting and generating unbounded Bedrock API costs.
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
- **Status:** ✅ Fixed
- **File:** `text_generation/src/main.py`
- **Line:** ~240
- **Description:** If usage check throws an exception, the error is logged but the request proceeds (`pass`). Database outage = unlimited messages = unlimited Bedrock API cost.
- **Impact:** A database outage or transient error in the usage-check path removes all rate limiting, allowing unbounded Bedrock API invocations and potentially thousands of dollars in unexpected costs.
- **Fix:** Fail closed with 503 response when usage check fails:
```python
# ❌ Problem: fail open on exception
try:
    current_usage = check_and_increment_usage(conn, user_id)
except Exception as e:
    logger.error(f"Usage check failed: {e}")
    pass  # Request proceeds without limit enforcement

# ✅ Fix: fail closed with 503
try:
    current_usage = check_and_increment_usage(conn, user_id)
except Exception as e:
    logger.error(f"Rate limit check failed: {e}")
    return create_response(503, {"error": "Service temporarily unavailable. Please try again later."}, event)
```

---

### H2. Database connection not returned to pool on error paths
- **Status:** ⬜ Open
- **Files:** All Python Lambdas
- **Functions:** `get_system_prompt()`, `get_audio_details()`, `get_case_details()`
- **Description:** `cur` variable referenced in `except` block may not be defined if exception occurs before `cur = connection.cursor()`. Raises `NameError`. Use context managers (`with conn.cursor() as cur:`) consistently.
- **Impact:** Unhandled `NameError` in the except block masks the original error, prevents proper rollback, and may leave the connection in an unusable state for subsequent warm-start invocations.
- **Fix:** Use context managers for automatic cursor cleanup:
```python
# ❌ Problem: cursor may not be defined in except block
def get_system_prompt(block_type):
    connection = connect_to_db()
    try:
        cur = connection.cursor()
        cur.execute("""SELECT prompt_text FROM prompt_versions ...""", (block_type,))
        result = cur.fetchone()
        cur.close()
        return result[0] if result else None
    except Exception as e:
        logger.error(f"Error fetching system prompt: {e}")
        if cur:  # NameError if exception before cursor creation
            cur.close()
        connection.rollback()
        return None

# ✅ Fix: context manager guarantees cleanup
def get_system_prompt(block_type):
    connection = connect_to_db()
    try:
        with connection.cursor() as cur:
            cur.execute("""SELECT prompt_text FROM prompt_versions ...""", (block_type,))
            result = cur.fetchone()
            return result[0] if result else None
    except Exception as e:
        logger.error(f"Error fetching system prompt: {e}")
        connection.rollback()
        return None
```

---

### H3. Stale database connection not detected
- **Status:** ✅ Fixed
- **Files:** All Python Lambdas
- **Function:** `connect_to_db()`
- **Description:** `connection.closed` only checks Python-side state, not server-side drops (RDS Proxy idle timeout, network blip). First query on stale connection will fail.
- **Impact:** First request after an idle period fails with a connection error, causing user-visible 500 errors until the Lambda instance reconnects on the next invocation.
- **Fix:** Add health check (`SELECT 1`) before reusing cached connection, with reconnection on failure:
```python
# ❌ Problem: only checks Python-side closed flag
def connect_to_db():
    global connection
    if connection is not None and not connection.closed:
        return connection  # May be stale server-side

# ✅ Fix: active health check with reconnection
def connect_to_db():
    global connection
    if connection is not None and not connection.closed:
        try:
            with connection.cursor() as cur:
                cur.execute("SELECT 1")
            return connection
        except Exception:
            logger.warning("Stale database connection detected, reconnecting...")
            try:
                connection.close()
            except Exception:
                pass
            connection = None
    # ... proceed with new connection
```

---

### H4. Guardrail bypass on initial conversation
- **Status:** ✅ Fixed
- **File:** `text_generation/src/main.py`
- **Description:** When `question` is empty (first turn), no guardrail is applied. The initial query is constructed from `case_description` (user input). If case description contains malicious content injected after creation, it bypasses guardrails.
- **Impact:** An attacker who can modify a case description post-creation can inject prompt manipulation content that reaches the LLM without guardrail filtering, potentially extracting system prompts or generating harmful output.
- **Mitigation:** Case creation applies guardrails, but any post-creation modification path is unguarded.
- **Fix:** Apply guardrail to all user-influenced content regardless of conversation turn:
```python
# ❌ Problem: guardrail only applied when question is non-empty
if question:
    guardrail_result = apply_guardrail_check(question, ...)
    if guardrail_result:
        return guardrail_result

# ✅ Fix: apply guardrail to the actual query sent to LLM (both initial and subsequent)
student_query = get_initial_student_query(...) if not question else question.strip()
guardrail_result = apply_guardrail_check(
    student_query, GUARDRAIL_ID, GUARDRAIL_VERSION,
    is_websocket, connection_id, domain_name, stage, request_id, event
)
if guardrail_result:
    return guardrail_result
```

---

### H5. `audioToText` Lambda polls synchronously with `time.sleep(5)`
- **Status:** ⏸ Deferred
- **File:** `audioToText/src/main.py`
- **Description:** Polls Transcribe job status in a `while True` loop with 5-second sleeps. Long audio files (10+ min) burn Lambda compute idly. Risk of timeout for very long files.
- **Impact:** A 30-minute audio file requires ~60 polling iterations (5 minutes of idle Lambda execution time), wasting compute budget and risking Lambda timeout (15 min max) for files longer than ~70 minutes.
- **Fix:** Replace with Step Functions or S3 event + completion handler Lambda:
```python
# ❌ Problem: synchronous polling burns compute
while True:
    resp = transcribe.get_transcription_job(TranscriptionJobName=job_name)
    status = resp["TranscriptionJob"]["TranscriptionJobStatus"]
    if status == "COMPLETED":
        transcript_uri = resp["TranscriptionJob"]["Transcript"]["RedactedTranscriptFileUri"]
        break
    if status == "FAILED":
        raise Exception("Transcription job failed")
    time.sleep(5)

# ✅ Fix: event-driven with Step Functions (pseudo-code)
# Step 1: Start transcription and return job name
# Step 2: Wait state (5 seconds)
# Step 3: Check status task
# Step 4: Choice state → COMPLETED → process, FAILED → error, else → back to Step 2
```

---

## Medium Issues

### M1. Massive code duplication across Python Lambdas
- **Status:** ⏸ Deferred
- **Files:** All 6 Python Lambdas
- **Description:** `get_cors_origin()`, `create_response()`, `get_secret()`, `get_parameter()`, `connect_to_db()`, `check_authorization()`, `send_to_websocket()` are copy-pasted with minor variations. Bug fixes require changes in 6 places.
- **Impact:** Bug fixes and security patches must be applied to 6 separate copies, increasing the risk of inconsistent behavior and missed patches.
- **Fix:** Extract shared Lambda layer or common package.

---

### M2. SSM parameters never refreshed on warm starts
- **Status:** ⬜ Open
- **Files:** All Python Lambdas
- **Function:** `initialize_constants()`
- **Description:** Parameters fetched once on cold start, cached forever. Admin changes to model ID, temperature, etc. in SSM won't take effect until Lambda instances recycle (hours).
- **Impact:** Configuration changes (model ID, temperature, rate limits) require manual Lambda redeployment or waiting for natural instance recycling, delaying operational responses.
- **Fix:** Add TTL-based refresh (e.g., re-fetch every 5 minutes).

---

### M3. `playground_generation` has no role-based authorization
- **Status:** ✅ Fixed
- **File:** `playground_generation/src/main.py`
- **Description:** No `check_authorization()` call. Relies only on WebSocket auth (validates authentication, not authorization). Any authenticated student could invoke playground if they know the action name.
- **Impact:** Students could access instructor/admin-only playground functionality, potentially generating uncontrolled AI content outside the intended pedagogical flow.
- **Fix:** Add role check (admin/instructor only) at handler entry.

---

### M4. CORS origin silently falls back to `"*"`
- **Status:** ✅ Fixed
- **Files:** All Python Lambdas
- **Description:** When `ALLOWED_ORIGIN` env var is not set, CORS is wide open. A misconfigured deployment silently degrades security.
- **Impact:** A misconfigured environment allows any origin to make authenticated requests, enabling cross-site request forgery from malicious domains.
- **Fix:** Log a warning when falling back to wildcard.

---

### M5. Inconsistent Bedrock invocation patterns
- **Status:** ⬜ Open
- **Files:** `text_generation` + `playground_generation` use LangChain; `summary_generation` + `assess_progress` use raw boto3
- **Description:** Two different invocation patterns means model compatibility changes need handling in two places. Raw invocation only supports `anthropic.*` and `meta.*` prefixes.
- **Impact:** Adding a new model requires changes in two codepaths with different APIs, increasing the risk of partial support and inconsistent error handling.
- **Fix:** Standardize on one approach across all Lambdas.

---

### M6. `__pycache__` committed to repository
- **Status:** ✅ Fixed
- **File:** `assess_progress/src/__pycache__/`
- **Description:** Compiled Python bytecode in the repo. Should be in `.gitignore`.
- **Impact:** Bloats repository size and can cause spurious merge conflicts on bytecode changes between Python versions.
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
- **Impact:** Dead code increases cognitive load for developers and may trigger false positives in security scanners.
- **Fix:** Remove unused imports and dead code.

---

### L2. Inconsistent error response formats
- **Status:** ⬜ Open
- **Files:** All Lambdas
- **Description:** Some return `{"error": "msg"}`, some return plain strings, some return `{"message": "..."}` for 404s. Frontend must handle all variations.
- **Impact:** Frontend error handling becomes fragile and must account for multiple response shapes, increasing UI bug surface area.
- **Fix:** Standardize on `{"error": string, "code"?: string}` format.

---

### L3. `get_audio_details` function never called
- **Status:** ⬜ Open
- **File:** `text_generation/src/main.py`
- **Description:** Dead code that queries `case_description` — same data already fetched by `get_case_details`.
- **Impact:** Adds unnecessary code surface area and may confuse future developers about the intended data flow.
- **Fix:** Remove the function.

---

### L4. Typo in system prompt
- **Status:** ✅ Fixed
- **File:** `text_generation/src/helpers/chat.py`, `playground_generation/src/helpers/chat.py`
- **Line:** `construct_case_context_prompt()`
- **Description:** "Additional case detials that are relevant" — should be "details".
- **Impact:** Minor professionalism issue; typo is visible in LLM context but does not affect functionality.
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

- [x] CDK Infrastructure
- [x] Lambda Functions (Python)
- [x] Lambda Functions (Node.js handlers)
- [x] Database (schema & migrations)
- [x] Frontend (React application)
- [x] Security (holistic cross-cutting)
- [ ] RDS (configuration & management) — Planned
- [ ] Bedrock (model invocation & prompt engineering) — Planned
- [ ] S3 Best Practices (bucket configurations & data protection) — Planned
- [ ] Well-Architected (AWS framework pillars) — Planned
