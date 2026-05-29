# Code Review: Amazon Bedrock Usage

**Reviewer:** Kiro  
**Date:** 2025-01-20  
**Scope:** Model invocation patterns, prompt engineering, token management, error handling, cost optimization (`cdk/lambda/text_generation/`, `cdk/lambda/playground_generation/`, `cdk/lambda/case_generation/`, `cdk/lambda/summary_generation/`, `cdk/lambda/assess_progress/`)  
**Status:** Complete (remediation tracked in [`REMEDIATION-STATUS.md`](REMEDIATION-STATUS.md))

---

## Summary

| Severity | Count | Fixed |
|----------|-------|-------|
| Critical | 0     | 0     |
| High     | 4     | 0     |
| Medium   | 6     | 0     |
| Low      | 4     | 0     |
| **Total**| **14**| **0** |

---

## What's Well-Designed

1. **Configurable model selection via SSM Parameter Store** — Model ID, temperature, top_p, and max_tokens are all externalized to SSM parameters, allowing runtime model switching without redeployment. Admin UI provides validated controls for these settings.
2. **Pre-invocation guardrail pattern** — Guardrails are applied BEFORE model invocation via `apply_guardrail_check()`, preventing harmful content from ever reaching the model and avoiding unnecessary API costs on blocked requests.
3. **Robust JSON parsing in assess_progress** — The `_try_parse_assessment_json()` function implements 4 fallback strategies (direct parse, strip markdown fences, extract JSON span, regex extraction), gracefully handling LLM output format variability.
4. **Appropriate token limits per use case** — Token budgets are tuned to task complexity: 150 for title generation, 512 for structured assessment JSON, 2048 for conversational responses. This demonstrates cost-aware design.
5. **Streaming architecture for real-time responses** — WebSocket-based streaming via LangChain `.stream()` and boto3 `invoke_model_with_response_stream()` provides responsive UX without waiting for full generation.
6. **Versioned prompt management in database** — System prompts stored in `prompt_versions` table with `is_active` flag and `version_number` enable prompt iteration without code changes and provide audit trail.
7. **Graceful degradation in case_generation** — Case creation succeeds even if AI title generation fails, with a warning returned to the user rather than a hard failure.
8. **Human effort cap in assess_progress** — `_apply_human_effort_cap()` prevents inflated progress scores when no meaningful human effort is detected, adding a business-logic safety net on top of LLM output.

---

## High Issues

### BDK-H1. No context window management for conversation history
- **Status:** ⬜ Open
- **Files:** `cdk/lambda/text_generation/src/helpers/chat.py`, `cdk/lambda/playground_generation/src/helpers/chat.py`
- **Description:** Chat history is loaded in full from DynamoDB via `DynamoDBChatMessageHistory` without any truncation, token counting, or sliding window strategy. Long conversations will eventually exceed model context limits (Llama 3 70b: 8K tokens, Claude Sonnet: 200K tokens).
- **Impact:** When conversation history exceeds the model's context window, the API call fails with a validation error. Users in long-running sessions experience sudden, unexplained failures with no graceful degradation path. The Llama 3 model's 8K context window makes this particularly likely for active cases.
- **Fix:**
```python
# ❌ Problem: full history loaded without bounds
from langchain_community.chat_message_histories import DynamoDBChatMessageHistory
history = DynamoDBChatMessageHistory(table_name=TABLE_NAME, session_id=session_id)
# All messages sent to model regardless of total token count

# ✅ Fix: implement token-aware sliding window
from langchain_community.chat_message_histories import DynamoDBChatMessageHistory
from langchain.memory import ConversationTokenBufferMemory

history = DynamoDBChatMessageHistory(table_name=TABLE_NAME, session_id=session_id)
memory = ConversationTokenBufferMemory(
    chat_memory=history,
    max_token_limit=6000,  # Leave headroom for system prompt + response
    return_messages=True,
    llm=llm  # Used for token counting
)
```

---

### BDK-H2. No throttling or retry handling for Bedrock API calls
- **Status:** ⬜ Open
- **Files:** `cdk/lambda/case_generation/src/helpers/chat.py`, `cdk/lambda/summary_generation/src/helpers/chat.py`
- **Description:** Raw boto3 `invoke_model()` calls have no retry logic, no exponential backoff, and no specific handling for `ThrottlingException`, `ModelTimeoutException`, `ModelNotReadyException`, or `ServiceUnavailableException`. A single transient failure causes immediate user-facing errors.
- **Impact:** During traffic spikes or Bedrock service degradation, every affected request fails immediately rather than retrying. This creates cascading user-visible errors and potential data inconsistency (e.g., summary_generation marks a job as failed when a retry would have succeeded).
- **Fix:**
```python
# ❌ Problem: no retry or throttle handling
bedrock_runtime = boto3.client("bedrock-runtime")
response = bedrock_runtime.invoke_model(
    modelId=model_id,
    body=json.dumps(payload)
)

# ✅ Fix: configure retry with exponential backoff
from botocore.config import Config

bedrock_config = Config(
    retries={
        "max_attempts": 3,
        "mode": "adaptive"  # Handles throttling with exponential backoff
    },
    read_timeout=60,
    connect_timeout=10
)
bedrock_runtime = boto3.client("bedrock-runtime", config=bedrock_config)

try:
    response = bedrock_runtime.invoke_model(
        modelId=model_id,
        body=json.dumps(payload)
    )
except bedrock_runtime.exceptions.ThrottlingException as e:
    logger.warning(f"Bedrock throttled after retries: {e}")
    raise  # Let caller handle with appropriate user message
except bedrock_runtime.exceptions.ModelTimeoutException as e:
    logger.error(f"Bedrock model timeout: {e}")
    raise
```

---

### BDK-H3. Prompt injection via unsanitized case context in system prompts
- **Status:** ⬜ Open
- **Files:** `cdk/lambda/text_generation/src/helpers/chat.py`, `cdk/lambda/playground_generation/src/helpers/chat.py`
- **Function:** `construct_case_context_prompt()`
- **Description:** User-provided case data (case_type, jurisdiction, case_description, province, statute) is directly interpolated into the system prompt via f-strings without sanitization. The guardrail check runs on the user's chat message but NOT on the case context data injected into the system prompt.
- **Impact:** An attacker can craft case metadata containing prompt injection payloads (e.g., "Ignore all previous instructions...") that bypass guardrail filtering and manipulate the LLM's behavior. This could extract system prompts, override safety instructions, or generate harmful content.
- **Fix:**
```python
# ❌ Problem: direct interpolation of user data into system prompt
def construct_case_context_prompt(system_prompt, case_type, jurisdiction, 
                                   case_description, province, statute):
    return f"""{system_prompt}

Case Context:
- Type: {case_type}
- Jurisdiction: {jurisdiction}
- Description: {case_description}
- Province: {province}
- Statute: {statute}

Pay close attention to the latest system prompt..."""

# ✅ Fix: sanitize inputs and apply guardrail to case context
def sanitize_case_field(value: str, field_name: str, max_length: int = 500) -> str:
    """Sanitize user-provided case fields before prompt injection."""
    if not value:
        return ""
    # Truncate to prevent context stuffing
    value = value[:max_length]
    # Remove common injection patterns
    injection_markers = ["ignore previous", "ignore all", "system prompt", 
                        "you are now", "new instructions"]
    value_lower = value.lower()
    for marker in injection_markers:
        if marker in value_lower:
            logger.warning(f"Potential injection detected in {field_name}")
            value = "[Content filtered for safety]"
            break
    return value

def construct_case_context_prompt(system_prompt, case_type, jurisdiction,
                                   case_description, province, statute):
    # Sanitize all user-provided fields
    case_type = sanitize_case_field(case_type, "case_type", 100)
    jurisdiction = sanitize_case_field(jurisdiction, "jurisdiction", 100)
    case_description = sanitize_case_field(case_description, "case_description", 2000)
    province = sanitize_case_field(province, "province", 100)
    statute = sanitize_case_field(statute, "statute", 200)
    
    # Also apply guardrail check to the combined context
    combined_context = f"{case_type} {jurisdiction} {case_description} {province} {statute}"
    # Run apply_guardrail_check on combined_context before building prompt
    
    return f"""{system_prompt}

Case Context:
- Type: {case_type}
- Jurisdiction: {jurisdiction}
- Description: {case_description}
- Province: {province}
- Statute: {statute}"""
```

---

### BDK-H4. Overly broad IAM permissions for Bedrock model access
- **Status:** ⬜ Open
- **File:** `cdk/lib/laigo-stack.ts` (CDK stack definition)
- **Description:** The shared Bedrock policy grants `bedrock:InvokeModel` and `bedrock:InvokeModelWithResponseStream` on `foundation-model/*` (all models in all regions) and `inference-profile/*` with wildcard region. This violates least-privilege principle.
- **Impact:** If a Lambda is compromised, the attacker can invoke any Bedrock model (including expensive ones like Claude Opus) across any region, generating significant unauthorized costs. The wildcard also grants access to models that may not have appropriate content filtering.
- **Fix:**
```typescript
// ❌ Problem: wildcard access to all models and inference profiles
const bedrockPolicyStatement = new iam.PolicyStatement({
  effect: iam.Effect.ALLOW,
  actions: ["bedrock:InvokeModel", "bedrock:InvokeModelWithResponseStream"],
  resources: [
    `arn:aws:bedrock:${this.region}::foundation-model/*`,
    "arn:aws:bedrock:*::inference-profile/*",
  ],
});

// ✅ Fix: scope to specific models actually used
const bedrockPolicyStatement = new iam.PolicyStatement({
  effect: iam.Effect.ALLOW,
  actions: ["bedrock:InvokeModel", "bedrock:InvokeModelWithResponseStream"],
  resources: [
    `arn:aws:bedrock:${this.region}::foundation-model/meta.llama3-70b-instruct-v1:0`,
    `arn:aws:bedrock:${this.region}:${this.account}:inference-profile/us.anthropic.claude-sonnet-4-6-20250514-v1:0`,
  ],
});
```

---

## Medium Issues

### BDK-M1. No output guardrails applied to model responses
- **Status:** ⬜ Open
- **Files:** All Bedrock Lambda functions
- **Description:** Guardrails are applied only to input (user messages). Model responses are sent directly to users without output filtering. The CDK guardrail configuration sets output strength to `NONE`. Model hallucinations, harmful content, or PII leakage in responses go unfiltered.
- **Impact:** If the model generates inappropriate content, PII from training data, or harmful advice despite input filtering, it reaches the user unfiltered. This is particularly concerning for a legal education platform where incorrect legal advice could have real consequences.
- **Fix:** Enable output filtering in the guardrail configuration and apply `ApplyGuardrail` on model responses before sending to users.

---

### BDK-M2. Significant code duplication in model invocation logic
- **Status:** ⬜ Open
- **Files:** `cdk/lambda/case_generation/src/helpers/chat.py`, `cdk/lambda/summary_generation/src/helpers/chat.py`, `cdk/lambda/assess_progress/src/main.py`
- **Description:** Three Lambda functions independently implement `_build_request_payload()` / `_build_invoke_body()` and `_extract_response_text()` / `_extract_text_from_invoke_response()` with model-family dispatch logic (Anthropic vs Meta). Bug fixes or new model support requires changes in 3 places.
- **Impact:** Adding a new model family (e.g., Amazon Titan, Cohere) requires implementing support in 3 separate files. A bug fix in payload construction for one function may not be applied to others, creating inconsistent behavior.
- **Fix:** Extract a shared `bedrock_client` module with unified `build_payload(model_id, messages, params)` and `extract_response(model_id, response)` functions, deployed as a Lambda layer.

---

### BDK-M3. Missing guardrail permissions for summary_generation and assess_progress
- **Status:** ⬜ Open
- **Files:** `cdk/lib/laigo-stack.ts`, `cdk/lambda/summary_generation/`, `cdk/lambda/assess_progress/`
- **Description:** `summary_generation` and `assess_progress` Lambdas lack `bedrock:ApplyGuardrail` IAM permissions and do not invoke guardrail checks. While these functions process conversation history rather than direct user input, the conversation content originates from users and could contain harmful content that gets summarized or assessed without filtering.
- **Impact:** Harmful content that was injected into conversation history (e.g., via a guardrail bypass) propagates through summaries and assessments without any safety filtering, potentially surfacing in instructor-facing reports.
- **Fix:** Add guardrail permissions and apply content filtering to conversation history before processing.

---

### BDK-M4. Playground guardrail has fail-open behavior
- **Status:** ⬜ Open
- **File:** `cdk/lambda/playground_generation/src/main.py`
- **Description:** When the guardrail check throws an exception (service error, timeout), `playground_generation` continues processing the request rather than failing safely. This means a guardrail service outage silently disables all content filtering for playground sessions.
- **Impact:** During Bedrock guardrail service degradation, all playground requests proceed without content filtering. Staff users could inadvertently generate harmful content, and if playground access control is bypassed (see M3 in Lambda review), students could exploit this window.
- **Fix:** Fail closed when guardrail check errors, returning a service unavailable response.

---

### BDK-M5. Unused caseGenGuardrail resource defined in CDK
- **Status:** ⬜ Open
- **File:** `cdk/lib/laigo-stack.ts`
- **Description:** A `comprehensive-guardrails` guardrail is defined in CDK with a FinancialAdvice topic policy, but no Lambda references its ID via environment variable. The `case_generation` Lambda uses the `textGenGuardrail` ID instead. This is dead infrastructure that incurs no cost but creates confusion.
- **Impact:** Developers may assume financial advice filtering is active when it is not. The guardrail resource creates maintenance overhead and confusion about the intended security posture.
- **Fix:** Either remove the unused guardrail or wire it to the appropriate Lambda function.

---

### BDK-M6. No cost tracking or usage attribution per user/case
- **Status:** ⬜ Open
- **Files:** All Bedrock Lambda functions
- **Description:** No mechanism exists to track Bedrock API costs per user, case, or session. The daily message limit (`MESSAGE_LIMIT_PARAM`) defaults to "Infinity", providing no effective cost control. Token usage is not logged or attributed.
- **Impact:** Cannot identify cost anomalies, abusive users, or optimize spending per feature. A single user with a long conversation can generate disproportionate costs without visibility. Budget alerts only work at the AWS account level, not per-tenant.
- **Fix:** Log token usage (input + output) per invocation with user/case metadata. Set a finite default message limit. Consider Bedrock model invocation logging for cost attribution.

---

## Low Issues

### BDK-L1. Inconsistent invocation patterns across Lambda functions
- **Status:** ⬜ Open
- **Files:** `text_generation/`, `playground_generation/` (LangChain) vs `case_generation/`, `summary_generation/`, `assess_progress/` (raw boto3)
- **Description:** Two fundamentally different approaches to Bedrock invocation coexist without clear rationale for the split. LangChain provides conversation management and streaming abstractions; raw boto3 provides direct control. The inconsistency increases onboarding complexity and maintenance burden.
- **Impact:** New developers must understand two different invocation patterns. Model compatibility changes require updates in two codepaths with different APIs and error handling semantics.
- **Fix:** Standardize on one approach. LangChain is recommended for functions needing conversation history; raw boto3 (with a shared wrapper) for single-shot invocations.

---

### BDK-L2. Hardcoded prompts in case_generation and session naming
- **Status:** ⬜ Open
- **Files:** `cdk/lambda/case_generation/src/helpers/chat.py`, `cdk/lambda/text_generation/src/helpers/chat.py`
- **Description:** While most prompts are stored in the database with versioning, the case title generation prompt and session naming prompt are hardcoded in source code. Changes require code deployment rather than database update.
- **Impact:** Prompt iteration for title/session naming requires a full deployment cycle rather than a database update, slowing experimentation and creating inconsistency with the versioned prompt management pattern used elsewhere.
- **Fix:** Move these prompts to the `prompt_versions` table with appropriate `block_type` and `category` values.

---

### BDK-L3. No prompt caching optimization
- **Status:** ⬜ Open
- **Files:** All Bedrock Lambda functions
- **Description:** Bedrock supports prompt caching for repeated system prompts, which can reduce latency and cost for identical prefix content. This feature is not utilized despite system prompts being largely static within a session.
- **Impact:** Each invocation pays full input token cost for the system prompt, even when the same prompt was used moments ago in the same session. For high-volume usage, this represents avoidable cost.
- **Fix:** Evaluate Bedrock prompt caching for system prompts that remain constant across turns within a session.

---

### BDK-L4. Default message limit set to "Infinity"
- **Status:** ⬜ Open
- **File:** `cdk/lambda/text_generation/src/main.py`
- **Description:** The `MESSAGE_LIMIT_PARAM` SSM parameter defaults to "Infinity" when not explicitly configured. While the rate limiting infrastructure exists, the default configuration provides no cost protection.
- **Impact:** A newly deployed environment has no effective per-user rate limiting until an administrator explicitly sets a finite limit, creating a window of unbounded cost exposure.
- **Fix:** Set a sensible default (e.g., 50 messages/day) and require explicit opt-in to remove limits.

---

## Architectural Recommendations

### R1. Implement token-aware conversation management
- **Priority:** High
- **Description:** Add a token counting and truncation layer between DynamoDB history retrieval and model invocation. Options include LangChain's `ConversationTokenBufferMemory`, a custom sliding window, or conversation summarization for older messages.
- **Benefit:** Prevents context window overflow failures, enables predictable cost per conversation turn, and improves response quality by keeping context focused on recent exchanges.

### R2. Create a shared Bedrock invocation layer
- **Priority:** High
- **Description:** Extract common Bedrock invocation logic (payload construction, response parsing, model-family dispatch, retry configuration) into a shared Lambda layer. This consolidates the 3 separate raw boto3 implementations and provides a single place to add new model support.
- **Benefit:** Single point of maintenance for model compatibility, consistent error handling and retry behavior, easier to add new models or switch providers.

### R3. Implement defense-in-depth for prompt injection
- **Priority:** High
- **Description:** Layer multiple defenses: (1) sanitize user-provided data before system prompt injection, (2) apply guardrails to the complete prompt including case context, (3) enable output guardrails to catch successful injections, (4) use structured prompt formats that separate instructions from data.
- **Benefit:** Reduces prompt injection attack surface from multiple angles rather than relying solely on input guardrails that don't cover system prompt content.

### R4. Add Bedrock usage observability
- **Priority:** Medium
- **Description:** Log token usage (input/output) per invocation with structured metadata (user_id, case_id, model_id, function_name). Enable Bedrock model invocation logging. Create CloudWatch dashboards for cost attribution and anomaly detection.
- **Benefit:** Enables per-user cost attribution, anomaly detection, model performance comparison, and data-driven decisions about model selection and token limits.

### R5. Scope IAM permissions to specific models
- **Priority:** Medium
- **Description:** Replace `foundation-model/*` wildcard with explicit ARNs for the models actually in use. Update permissions when model configuration changes via a CDK parameter or lookup.
- **Benefit:** Limits blast radius of a compromised Lambda, prevents unauthorized use of expensive models, and aligns with AWS least-privilege best practices.

### R6. Establish prompt testing and validation pipeline
- **Priority:** Low
- **Description:** Since prompts are stored in the database and versioned, add a validation step before activating new prompt versions: test against known inputs, verify output format compliance (especially for assess_progress JSON), and check for regression in quality metrics.
- **Benefit:** Prevents prompt regressions from reaching production, enables confident prompt iteration, and catches format-breaking changes before they affect users.

---

## Review Progress

- [x] CDK Infrastructure
- [x] Lambda Functions (Python)
- [x] Lambda Functions (Node.js handlers)
- [x] Database (schema & migrations)
- [x] Frontend (React application)
- [x] Security (holistic cross-cutting)
- [ ] RDS (configuration & management) — In Progress
- [x] Bedrock (model invocation & prompt engineering)
- [ ] S3 Best Practices (bucket configurations & data protection) — In Progress
- [ ] Well-Architected (AWS framework pillars) — In Progress
