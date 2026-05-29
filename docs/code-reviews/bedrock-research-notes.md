# Bedrock Deep-Dive Research Notes

> **Purpose:** Internal research notes for task 4.1. These findings will be used as input for task 4.2 to produce the formal `code-review-bedrock.md` document.
> **Date:** 2025-01-20
> **Scope:** All Bedrock/AI-related code across the LAIGO codebase

---

## 1. Model Invocation Patterns

### Lambda Functions Using Bedrock

| Lambda | Invocation Method | Framework | File(s) |
|--------|-------------------|-----------|---------|
| `text_generation` | LangChain `ChatBedrockConverse` | langchain-aws | `cdk/lambda/text_generation/src/helpers/chat.py` |
| `playground_generation` | LangChain `ChatBedrockConverse` | langchain-aws | `cdk/lambda/playground_generation/src/helpers/chat.py` |
| `case_generation` | Raw boto3 `invoke_model` | boto3 bedrock-runtime | `cdk/lambda/case_generation/src/helpers/chat.py` |
| `summary_generation` | Raw boto3 `invoke_model` + `invoke_model_with_response_stream` | boto3 bedrock-runtime | `cdk/lambda/summary_generation/src/helpers/chat.py` |
| `assess_progress` | Raw boto3 `invoke_model` | boto3 bedrock-runtime | `cdk/lambda/assess_progress/src/main.py` |

### Two Distinct Invocation Approaches

1. **LangChain-based (text_generation, playground_generation):**
   - Uses `ChatBedrockConverse` from `langchain_aws`
   - Leverages LangChain's `ChatPromptTemplate`, `MessagesPlaceholder`, `RunnableWithMessageHistory`
   - Conversation history managed via `DynamoDBChatMessageHistory` from `langchain_community`
   - Supports both synchronous `.invoke()` and streaming `.stream()` modes
   - Guardrail integration via `guardrail_config` parameter on `ChatBedrockConverse`

2. **Raw boto3 (case_generation, summary_generation, assess_progress):**
   - Direct `bedrock_runtime.invoke_model()` and `invoke_model_with_response_stream()` calls
   - Manual request payload construction per model family (Anthropic, Meta)
   - Manual response parsing per model family
   - No LangChain abstraction layer

### Code Duplication Observations

- `text_generation` and `playground_generation` share nearly identical `chat.py` helper files (copy-paste with minor differences)
- `case_generation` and `summary_generation` both implement their own `_build_request_payload()` and `_extract_response_text()` functions with similar logic
- `assess_progress` has its own `_build_invoke_body()` and `_extract_text_from_invoke_response()` functions
- The model-family dispatch logic (Anthropic vs Meta) is duplicated across 3 separate files

### Models Supported

- **Anthropic Claude** (model IDs starting with `anthropic.`): Messages API format
- **Meta Llama** (model IDs starting with `meta.`): Prompt-based format
- **Cross-region inference profiles**: `arn:aws:bedrock:${region}:${account}:inference-profile/us.anthropic.claude-sonnet-4-6-20250514-v1:0`
- Default model in SSM: `meta.llama3-70b-instruct-v1:0`
- Available options include Claude Sonnet 4.6 via cross-region inference profile

---

## 2. Prompt Engineering Approaches

### System Prompt Storage

System prompts are stored in the **PostgreSQL database** in a `prompt_versions` table:
- Schema: `prompt_text`, `block_type`, `category`, `is_active`, `version_number`
- Categories: `reasoning`, `summary`, `assessment`
- Block types: `intake`, `legal_analysis`, `contrarian`, `policy`
- Versioned with `is_active` flag for active prompt selection
- Fetched at runtime via SQL query: `WHERE block_type = ? AND is_active = true AND category = ? ORDER BY version_number DESC LIMIT 1`

### Prompt Construction Patterns

1. **text_generation / playground_generation:**
   - System prompt fetched from DB (`get_system_prompt(block_type)`)
   - Wrapped with case context via `construct_case_context_prompt()`:
     - Injects case_type, jurisdiction, case_description, province, statute
     - Adds meta-instruction: "Pay close attention to the latest system prompt..."
   - Uses LangChain `ChatPromptTemplate` with `MessagesPlaceholder` for chat history

2. **summary_generation:**
   - Separate prompts for block summaries vs full-case synthesis
   - Prompt fetched via `get_summary_prompt_template(prompt_scope, block_type)`
   - Adds case metadata section and strict output instructions (no preamble/outro)
   - Appends a legal disclaimer to all summary outputs

3. **assess_progress:**
   - Assessment prompt fetched from DB (`get_assessment_prompt_template(block_type)`)
   - Complex system instructions built in `_build_assessment_system_instructions()`:
     - Includes scoring rules (0-5 scale)
     - Requires JSON output format: `{"progress": int, "reasoning": string}`
   - Human context includes formatted conversation timeline with creditable/non-creditable turn separation

4. **case_generation:**
   - Hardcoded prompt in code (not from DB)
   - Simple title generation prompt with guidelines
   - No system prompt separation (uses single user message for Anthropic)

5. **Session naming (text_generation, playground_generation):**
   - `update_session_name()` uses a hardcoded title generation prompt
   - Invokes LLM to generate a <30 character conversation name

### Prompt Injection Concerns

- `construct_case_context_prompt()` directly interpolates user-provided case data (case_type, jurisdiction, case_description, province, statute) into the system prompt using f-strings
- No sanitization or escaping of user input before injection into prompts
- The guardrail check happens on the user's message but NOT on the case context data that's injected into the system prompt

---

## 3. Token Management and Context Window Handling

### Token Configuration

| Parameter | Default Value | Source | Scope |
|-----------|--------------|--------|-------|
| `BEDROCK_MAX_TOKENS` | 2048 | SSM Parameter Store | text_gen, playground, summary_gen |
| `BEDROCK_MAX_TOKENS` | 512 | Hardcoded default | assess_progress |
| `BEDROCK_MAX_TOKENS` | 150 | Hardcoded default | case_generation |
| Max output tokens (Claude Sonnet 4.6) | 8192 | Model constraints in SSM | Admin UI constraint |
| Max output tokens (Llama 3 70b) | 8192 | Model constraints in SSM | Admin UI constraint |

### Context Window Management

- **No explicit context window management or truncation strategy exists**
- Chat history is loaded in full from DynamoDB without any truncation
- `DynamoDBChatMessageHistory` loads all messages for a session
- No token counting before sending to the model
- No sliding window or summarization of old messages
- For `assess_progress`, entire conversation history is formatted and sent as a single prompt
- For `summary_generation`, entire conversation history is retrieved and sent for summarization

### Potential Issues

- Long conversations could exceed model context windows (Llama 3 70b: 8K context, Claude Sonnet: 200K context)
- No graceful degradation when context limit is approached
- No token usage tracking or reporting (beyond what AWS provides in billing)

---

## 4. Error Handling for Bedrock API Calls

### text_generation (LangChain-based)

- **Retry logic:** `get_response()` has a `max_retries = 3` loop that retries if response is empty
- **Empty response handling:** Raises `RuntimeError("LLM returned empty response after retries")`
- **Streaming errors:** Caught in `get_streaming_response()`, sends WebSocket error message, then re-raises
- **LLM initialization errors:** Caught in handler, returns 500 with generic error message
- **No specific handling for:** Throttling (429), timeouts, model capacity errors, validation errors

### case_generation (boto3-based)

- **No retry logic** for the `invoke_model` call
- **No specific error handling** around the Bedrock invocation itself
- Title generation failure is caught at the handler level and returns a warning with the case still created
- **Graceful degradation:** Case is created even if title generation fails

### summary_generation (boto3-based)

- **No retry logic** for `invoke_model` or `invoke_model_with_response_stream`
- Generic `except Exception` catches all errors
- Publishes failure notification via EventBridge on error
- Returns generic error message to user

### assess_progress (boto3-based)

- **Retry logic:** `_invoke_assessment_with_retry()` with `max_attempts=2`
- Retries with stricter prompt suffix if JSON parsing fails
- **Robust JSON parsing:** `_try_parse_assessment_json()` with 4 fallback strategies:
  1. Direct JSON parse
  2. Strip markdown code fences
  3. Extract first JSON object span
  4. Regex extraction for near-JSON outputs
- **Human effort cap:** `_apply_human_effort_cap()` caps score when no meaningful human effort detected

### Missing Error Handling Patterns

- No exponential backoff for throttling (ThrottlingException)
- No circuit breaker pattern
- No specific handling for `ModelTimeoutException`, `ModelNotReadyException`, `ServiceUnavailableException`
- No request timeout configuration on boto3 clients (uses default)
- LangChain-based functions rely on LangChain's internal retry behavior (if any)

---

## 5. Guardrail Integration

### Guardrail Configuration (CDK)

Two guardrails are defined:

1. **Text Generation Guardrail** (`text-generation-guardrails`):
   - **Content Policy:** PROMPT_ATTACK filter (MEDIUM input strength, NONE output)
   - **Topic Policy:**
     - PromptAttacks (DENY)
     - RoleManipulation (DENY)
     - SystemPromptLeakage (DENY)
   - **Sensitive Information Policy (PII):**
     - EMAIL: BLOCK
     - PHONE: BLOCK
     - NAME: BLOCK
     - CA_SOCIAL_INSURANCE_NUMBER: BLOCK
     - CA_HEALTH_NUMBER: BLOCK
   - Used by: text_generation, playground_generation, case_generation

2. **Case Generation Guardrail** (`comprehensive-guardrails`):
   - **Topic Policy:** FinancialAdvice (DENY)
   - No PII or content policy
   - Defined but **not referenced** by any Lambda environment variable (case_generation uses textGenGuardrail instead)

### Guardrail Application Patterns

- **text_generation:** Uses `bedrock_runtime.apply_guardrail()` API directly on user input BEFORE model invocation
- **playground_generation:** Same pattern, but with fail-open behavior for staff (continues if guardrail check errors)
- **case_generation:** Uses `apply_guardrail()` on combined case fields before model invocation
- **summary_generation:** No guardrail applied (processes conversation history, not direct user input)
- **assess_progress:** No guardrail applied

### Guardrail Observations

- Guardrails are applied as a pre-invocation check, NOT integrated into the model invocation itself
- `text_generation` also passes guardrail config to `ChatBedrockConverse` constructor but the `apply_guardrail_check()` function runs separately
- The `get_bedrock_llm()` in text_generation accepts `guardrail_id` and `guardrail_version` params but the handler doesn't pass them when creating the LLM instance (only passes them to `apply_guardrail_check`)
- Output guardrails are not applied (output strength is NONE)
- The caseGenGuardrail is defined in CDK but appears unused (case_generation Lambda uses textGenGuardrail's ID)

---

## 6. IAM Permissions for Bedrock Access

### Shared Bedrock Policy Statement

```typescript
const bedrockPolicyStatement = new iam.PolicyStatement({
  effect: iam.Effect.ALLOW,
  actions: ["bedrock:InvokeModel", "bedrock:InvokeModelWithResponseStream"],
  resources: [
    // Scoped to Anthropic and Meta foundation models only
    `arn:aws:bedrock:${this.region}::foundation-model/anthropic.*`,
    `arn:aws:bedrock:${this.region}::foundation-model/meta.*`,
    // Cross-region inference profiles scoped to account
    `arn:aws:bedrock:${this.region}:${this.account}:inference-profile/us.anthropic.*`,
    `arn:aws:bedrock:${this.region}:${this.account}:inference-profile/us.meta.*`,
  ],
});
```

### Per-Lambda Permissions

| Lambda | Bedrock Invoke | Guardrail | SSM Params | Notes |
|--------|---------------|-----------|------------|-------|
| text_generation | ✅ All models + inference profiles | ✅ InvokeGuardrail, ApplyGuardrail | ✅ LLM, Temp, TopP, MaxTokens, MessageLimit | Full access |
| playground_generation | ✅ All models + inference profiles | ✅ InvokeGuardrail, ApplyGuardrail | ✅ LLM, Temp, TopP, MaxTokens | Full access |
| case_generation | ✅ All models + inference profiles | ✅ InvokeGuardrail, ApplyGuardrail | ✅ LLM, Temp, TopP, MaxTokens, CaseTypes | Full access |
| summary_generation | ✅ All models + inference profiles | ❌ No guardrail permission | ✅ LLM, Temp, TopP, MaxTokens | Missing guardrail |
| assess_progress | ✅ All models + inference profiles | ❌ No guardrail permission | ✅ LLM, Temp, TopP, MaxTokens | Missing guardrail |

### IAM Observations

- ~~**Overly broad model access:**~~ ✅ Fixed — scoped to `anthropic.*` and `meta.*` foundation models only
- ~~**Wildcard region for inference profiles:**~~ ✅ Fixed — scoped to account-specific `us.anthropic.*` and `us.meta.*` inference profiles in the deployment region
- **Admin function** has read/write access to all Bedrock SSM parameters (temperature, top_p, max_tokens, LLM ID, model options)

---

## 7. Cost Optimization Patterns

### Model Selection

- Default model: `meta.llama3-70b-instruct-v1:0` (lower cost than Claude)
- Claude Sonnet 4.6 available as an option (higher cost, higher capability)
- Model selection is configurable via SSM Parameter Store (admin can switch at runtime)
- `case_generation` uses low max_tokens (150) for title generation — appropriate cost optimization
- `assess_progress` uses low max_tokens (512) for structured JSON output — appropriate

### Caching

- **No response caching** implemented at any level
- **No prompt caching** (Bedrock prompt caching feature not used)
- SSM parameters are cached in Lambda global scope (cold start optimization)
- Database connections are cached across invocations (connection reuse)
- DynamoDB chat history is fetched fresh on every invocation (no caching)

### Token Limits

- Configurable via SSM Parameter Store (admin-adjustable)
- Default max_tokens: 2048 for most functions
- Per-model constraints defined in `defaultBedrockModelOptions` for admin UI validation
- **No input token budgeting** — no mechanism to limit input size before sending to model

### Cost Concerns

- No usage tracking or cost attribution per user/case
- No model-specific cost awareness in code (same max_tokens regardless of model cost)
- Streaming responses may incur higher costs due to per-token billing
- Full conversation history sent on every request (no summarization to reduce tokens)
- `update_session_name()` makes an additional LLM call just for naming — could be deferred or cached
- Daily message limit (`MESSAGE_LIMIT_PARAM`) provides some cost control but defaults to "Infinity"

---

## 8. Additional Observations

### Streaming Architecture

- WebSocket-based streaming for real-time responses
- `text_generation` and `playground_generation` use LangChain's `.stream()` method
- `summary_generation` uses boto3's `invoke_model_with_response_stream()`
- Chunks sent via API Gateway Management API (`post_to_connection`)
- Request correlation via `requestId` field in WebSocket messages

### Conversation History Management

- DynamoDB tables: `${id}-Conversation-Table` (main), `${id}-Playground-Table` (playground)
- Playground sessions have 24-hour TTL (auto-cleanup)
- Main conversation table has no TTL (conversations persist indefinitely)
- Session IDs constructed as `{case_id}-{block_type}` for main, `playground-{session_id}-{block_type}` for playground

### Security Observations

- Guardrail checks happen BEFORE model invocation (good pattern)
- playground_generation has fail-open guardrail behavior (continues if guardrail errors)
- No output validation/filtering on model responses
- System prompts stored in DB are not validated for injection attacks
- Case context data injected into system prompts without sanitization

### Dependency Versions (text_generation/playground_generation)

- `langchain==1.2.10`
- `langchain-aws==1.3.0`
- `langchain-community==0.4.1`
- `langchain-core==1.3.0`
- `boto3==1.42.56/1.42.57`
- `aws-lambda-powertools==3.25.0`

### Testing

- `text_generation` has a `tests/` directory (not examined in detail for this task)
- No visible tests for other Bedrock Lambda functions

---

## Summary of Key Findings for Review Document

### Likely Critical Issues
- None identified (no active security vulnerabilities or data loss risks from Bedrock usage alone)

### Likely High Issues
- No context window management (could cause model failures on long conversations)
- No throttling/retry handling for Bedrock API calls (could cause cascading failures)
- Prompt injection risk via unsanitized case context data in system prompts
- Overly broad IAM permissions (`foundation-model/*`)

### Likely Medium Issues
- Significant code duplication across Lambda functions (model dispatch logic, chat helpers)
- No output guardrails (only input filtering)
- Missing guardrail permissions for summary_generation and assess_progress
- No cost tracking or usage attribution
- Unused caseGenGuardrail resource in CDK
- playground_generation fail-open guardrail behavior

### Likely Low Issues
- Inconsistent invocation patterns (LangChain vs raw boto3)
- Hardcoded prompts in case_generation and session naming
- No prompt caching optimization
- Default message limit set to "Infinity"
