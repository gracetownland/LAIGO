# Well-Architected Research Notes

> **Purpose:** Internal research notes for task 6.1. These findings will be used as input for task 6.2 to produce the formal `code-review-well-architected.md` document.
> **Date:** 2025-01-XX
> **Scope:** Entire LAIGO codebase examined through the AWS Well-Architected Framework six pillars

---

## Pillar 1: Operational Excellence

### What's Working Well

1. **Infrastructure as Code (IaC) completeness**: The entire infrastructure is defined in CDK TypeScript (`cdk/lib/`). Seven stacks cover VPC, Database, DBFlow (migrations), CICD, API Gateway, Amplify, and WAF. No manual console resources detected.

2. **CI/CD pipeline for Docker Lambda functions**: `cicd-stack.ts` implements a CodePipeline with GitHub source, CodeBuild for Docker image builds, ECR vulnerability scanning (blocks on CRITICAL findings), and automated Lambda function code updates.

3. **Automated dependency updates**: Comprehensive `dependabot.yml` covers 10+ package ecosystems (npm, pip, Docker, GitHub Actions) with weekly schedules and grouped PRs.

4. **CodeQL security scanning**: Weekly scheduled + PR-triggered CodeQL analysis for both JavaScript/TypeScript and Python with `security-extended` queries.

5. **Database migrations as code**: `dbFlow-stack.ts` uses a CDK `TriggerFunction` with `node-pg-migrate` layer to run migrations automatically on deployment.

6. **Structured logging**: AWS Lambda Powertools used consistently across both Python (`Logger`, `Metrics`) and Node.js (`@aws-lambda-powertools/logger`) Lambda functions.

7. **Bedrock model invocation logging**: Custom resource enables CloudWatch logging for all Bedrock model invocations (text data delivery enabled).

### Findings / Gaps

1. **No CloudWatch Alarms defined**: Zero alarms in the entire CDK codebase. No alerting on Lambda errors, API Gateway 5xx rates, RDS CPU/connections, DynamoDB throttling, or Bedrock throttling.

2. **No CloudWatch Dashboards**: No operational dashboards defined in CDK for at-a-glance system health visibility.

3. **No deployment pipeline for non-Docker Lambdas**: The CICD stack only handles Docker-based Lambda functions (text_generation, playground_generation). The 10+ other Lambda functions (handlers, authorization, websocket, case_generation, etc.) have no automated deployment pipeline.

4. **No runbooks or operational documentation**: No runbook files found for incident response, rollback procedures, or operational playbooks.

5. **API Gateway access logs retention is only ONE_WEEK**: `logs.RetentionDays.ONE_WEEK` for API access logs is very short for audit/debugging purposes.

6. **No canary deployments or traffic shifting**: Lambda functions deploy with immediate full traffic cutover. No aliases, weighted routing, or CodeDeploy integration for gradual rollouts.

7. **Missing CI/CD for frontend**: Amplify handles frontend builds via GitHub integration, but there's no explicit test stage, lint check, or quality gate in the build pipeline.

8. **X-Ray tracing only on Python Lambdas**: `tracing: lambda.Tracing.ACTIVE` is set on Python Docker functions (text_generation, playground_generation, case_generation, assess_progress, summary_generation) but NOT on Node.js handler functions (student, admin, instructor, authorizers, websocket).

---

## Pillar 2: Security

### What's Working Well

1. **IAM least privilege with dedicated roles**: Each Lambda function group has its own IAM role (adminAuthorizerRole, studentFunctionRole, instructorFunctionRole, etc.) with only the permissions needed for its specific tasks.

2. **Secrets management via AWS Secrets Manager**: Database credentials stored in Secrets Manager. Cognito configuration stored in Secrets Manager. No hardcoded secrets in code.

3. **Network isolation**: RDS deployed in PRIVATE_ISOLATED subnets. Lambda functions in PRIVATE_WITH_EGRESS subnets. Database not publicly accessible.

4. **VPC Flow Logs enabled**: Both VPC configurations (existing and new) enable flow logs for network traffic monitoring.

5. **VPC Endpoints**: Interface endpoints for Secrets Manager and RDS reduce traffic exposure to the public internet.

6. **Encryption at rest**: RDS `storageEncrypted: true`, DynamoDB `TableEncryption.AWS_MANAGED`, S3 `BucketEncryption.S3_MANAGED`.

7. **Encryption in transit**: RDS parameter group enforces `rds.force_ssl = 1`. RDS Proxy `requireTLS: true`. Lambda connections use `sslmode: "require"`.

8. **WAF protection on both API Gateway and CloudFront**: Regional WAF on API Gateway + CloudFront-scoped WAF on Amplify. Both include AWS Managed Rules (Common Rule Set) and rate limiting.

9. **Per-user rate limiting**: WAF rule uses Authorization header hash for per-user rate limiting (200 requests/5 min).

10. **Bedrock Guardrails**: PII blocking (email, phone, name, SIN, health number), prompt attack detection, role manipulation prevention, system prompt leakage prevention.

11. **Cognito strong password policy**: 12-character minimum with lowercase, uppercase, digits, and symbols required.

12. **Security headers on all responses**: X-Content-Type-Options, X-Frame-Options, Content-Security-Policy, Strict-Transport-Security consistently applied across Lambda responses and Amplify custom headers.

13. **S3 Block Public Access**: All S3 buckets use `BlockPublicAccess.BLOCK_ALL`.

14. **CORS origin lockdown**: When `domainName` is configured, CORS is locked to the specific domain rather than wildcard.

15. **ECR image scanning on push**: `imageScanOnPush: true` with CRITICAL vulnerability blocking in the build pipeline.

16. **Authorization at multiple layers**: JWT validation in authorizers + database role checks + per-resource ownership validation in handlers.

### Findings / Gaps

1. **No secret rotation configured**: Database secrets (`secretPathAdmin`, `secretPathUser`, `secretPathTableCreator`) have no rotation schedule. Long-lived credentials increase risk.

2. **RDS Proxy role has wildcard resource**: `rdsProxyRole` grants `rds-db:connect` on `resources: ["*"]` instead of scoping to the specific database instance ARN.

3. **Cognito Lambda role has broad EC2 permissions**: `cognitoRole` grants `ec2:*NetworkInterface*` on `resources: ["*"]`. While standard for VPC Lambda, could be scoped to specific VPC/subnet.

4. **dbFlow Lambda role has `AmazonSSMReadOnlyAccess` managed policy**: This grants read access to ALL SSM parameters in the account, not just the ones needed.

5. **Cognito Lambda role has broad logs permissions**: `logs:*` on `arn:aws:logs:*:*:*` instead of scoped to specific log groups.

6. **GitHub token stored in Secrets Manager without rotation**: `github-personal-access-token` is a long-lived PAT with no rotation mechanism.

7. **`CloudWatchLogsFullAccess` managed policy on Bedrock logging role**: Overly broad; should be scoped to the specific log group.

8. **DynamoDB tables use AWS_MANAGED encryption**: While encrypted, using customer-managed KMS keys (CMK) would provide more control over key rotation and access policies.

9. **No WAF logging enabled**: WAF Web ACLs have metrics but no logging to S3/CloudWatch for detailed request inspection.

10. **Cognito User Pool allows self-signup**: `selfSignUpEnabled: true` means anyone can register. While there's a pre-signup Lambda for domain validation, the default `SignupMode` is "public".

---

## Pillar 3: Reliability

### What's Working Well

1. **RDS Proxy for connection pooling**: Eliminates connection exhaustion from Lambda cold starts. Handles credential rotation transparently.

2. **Multi-AZ VPC subnets**: VPC configured with subnets across 2 AZs (new VPC) or 3 AZs (existing VPC with Control Tower).

3. **RDS backup retention**: 7-day automated backup retention configured.

4. **Deletion protection on RDS**: `deletionProtection: true` prevents accidental database deletion.

5. **Cognito User Pool RETAIN policy**: `removalPolicy: cdk.RemovalPolicy.RETAIN` prevents accidental user data loss.

6. **DynamoDB on-demand capacity**: `PAY_PER_REQUEST` billing mode handles traffic spikes without capacity planning.

7. **TTL on ephemeral data**: WebSocket connections (2 hours), notifications (30 days), playground sessions have TTL configured.

8. **Database connection health checks**: Python Lambda (`text_generation`) validates connection with `SELECT 1` before reuse and reconnects on stale connections.

9. **Retry logic in LLM calls**: `get_response()` has `max_retries = 3` for empty LLM responses.

10. **Stale WebSocket connection cleanup**: Notification service detects 410 Gone errors and removes stale connections from DynamoDB.

11. **Email whitelist table uses RETAIN**: `removalPolicy: cdk.RemovalPolicy.RETAIN` prevents accidental data loss.

### Findings / Gaps

1. **RDS is Single-AZ**: `multiAz: false` — a single AZ failure takes down the database. This is the most significant reliability gap.

2. **Single NAT Gateway**: `natGateways: 1` — if the NAT Gateway's AZ fails, all private subnet Lambda functions lose internet access (needed for Bedrock, Secrets Manager, etc.).

3. **No Dead Letter Queues (DLQ)**: Zero DLQ configurations across all Lambda functions. Failed invocations are silently lost.

4. **No DynamoDB Point-in-Time Recovery (PITR)**: Conversation history, notifications, and connection tables have no PITR enabled. Data loss from accidental deletes is unrecoverable.

5. **DynamoDB tables use DESTROY removal policy**: `chatHistoryTable`, `playgroundTable`, `notificationTable`, `connectionTable` all use `RemovalPolicy.DESTROY`. Stack deletion destroys all data.

6. **No health check endpoints**: No dedicated health check Lambda or API endpoint for monitoring system availability.

7. **No circuit breaker pattern**: Lambda functions calling Bedrock have no circuit breaker to prevent cascading failures during Bedrock outages.

8. **No Lambda reserved concurrency**: All functions share the account's Lambda concurrency pool. A traffic spike on one function could starve others.

9. **No RDS read replica**: All read and write traffic goes to a single database instance. No read scaling capability.

10. **WebSocket API has no throttling configuration**: Unlike the REST API (100 req/s, 200 burst), the WebSocket API has no explicit throttling.

11. **No cross-region disaster recovery**: All resources in a single region. No cross-region replication for RDS, DynamoDB, or S3.

---

## Pillar 4: Performance Efficiency

### What's Working Well

1. **Graviton-based RDS instance**: `BURSTABLE4_GRAVITON` (t4g) provides better price-performance than x86 instances.

2. **RDS Proxy eliminates cold start connection overhead**: Lambda functions connect to the proxy instead of establishing new database connections on each invocation.

3. **Lambda memory right-sizing by function type**:
   - Authorizers: 256 MB (lightweight JWT validation + DB lookup)
   - Pre-signup: 128 MB (simple validation)
   - Handlers (student/admin/instructor): 512 MB (moderate DB operations)
   - AI functions (text_gen, playground, assess_progress, summary): 1024 MB (Bedrock + DB)
   - Case generation: 512 MB (lighter Bedrock usage)
   - Pre-signed URL: 128 MB (simple S3 operation)

4. **Docker images for heavy Python Lambdas**: text_generation and playground_generation use Docker images (ECR) allowing larger deployment packages with all dependencies.

5. **WebSocket streaming for LLM responses**: Instead of waiting for full response, chunks are streamed to the client in real-time via WebSocket.

6. **DynamoDB GSIs for efficient queries**: Notification and connection tables have GSIs for user-based lookups and read status filtering.

7. **CDN via Amplify/CloudFront**: Frontend static assets served via CloudFront edge locations.

8. **Lambda Powertools layers shared across functions**: Avoids duplicating observability code in each deployment package.

9. **Connection reuse in Lambda**: Both Python (`global connection`) and Node.js (`global.sqlConnection`) reuse database connections across invocations.

10. **SSM Parameter caching**: Parameters cached in Lambda execution context globals to avoid repeated API calls.

### Findings / Gaps

1. **No Lambda Provisioned Concurrency**: AI-heavy functions (text_generation, playground_generation) with Docker images likely have significant cold start times (5-15s). No provisioned concurrency configured.

2. **Text generation Lambda timeout is 120s**: While appropriate for LLM calls, there's no intermediate timeout for the Bedrock API call itself. A hung Bedrock connection could consume the full 120s.

3. **No caching layer (ElastiCache/DAX)**: Frequently accessed data (system prompts, case details, user metadata) is fetched from RDS on every invocation. No Redis/Memcached caching.

4. **Authorizer caching not explicitly configured**: API Gateway authorizer caching TTL not set in CDK (defaults may apply from OpenAPI spec).

5. **DynamoDB conversation table has no GSI**: `chatHistoryTable` only has a partition key (`SessionId`). Querying by user or time range requires full table scans.

6. **No connection pooling for Node.js handlers**: While `initializeConnection.js` reuses connections via `global.sqlConnection`, the `postgres` library doesn't provide connection pooling like RDS Proxy does at the infrastructure level.

7. **RDS storage auto-scaling limited**: `maxAllocatedStorage: 150` with `allocatedStorage: 100` only allows 50% growth before manual intervention.

8. **Single RDS instance size (db.t4g.medium)**: No read replicas for read-heavy workloads. All queries hit the same instance.

---

## Pillar 5: Cost Optimization

### What's Working Well

1. **DynamoDB on-demand billing**: `PAY_PER_REQUEST` avoids paying for unused provisioned capacity. Appropriate for variable/unpredictable workloads.

2. **Burstable RDS instance (t4g.medium)**: Cost-effective for workloads that don't need sustained high CPU.

3. **Single NAT Gateway**: Reduces NAT Gateway costs (though at the expense of reliability).

4. **S3 lifecycle rules on whitelist uploads**: 1-day expiration prevents accumulation of temporary upload files.

5. **DynamoDB TTL on ephemeral data**: Automatic deletion of expired WebSocket connections and playground sessions reduces storage costs.

6. **Lambda on-demand pricing**: No provisioned concurrency means paying only for actual invocations.

7. **Shared Lambda layers**: Reduces deployment package sizes and avoids duplicating dependencies.

8. **S3 managed encryption (SSE-S3)**: Free encryption vs. KMS which charges per API call.

9. **Single-AZ RDS**: While a reliability concern, it halves the RDS cost compared to Multi-AZ.

### Findings / Gaps

1. **No S3 Intelligent Tiering on audio bucket**: Audio prompt bucket has no lifecycle rules. Old audio files accumulate indefinitely with no transition to cheaper storage classes.

2. **No RDS Reserved Instance consideration**: If the workload is stable, a 1-year reserved instance could save 30-40% on RDS costs.

3. **ECR repositories set to RETAIN**: `removalPolicy: cdk.RemovalPolicy.RETAIN` means old ECR repositories accumulate even after stack deletion. No lifecycle policy for old images.

4. **No ECR image lifecycle policy**: Old Docker images accumulate in ECR repositories without cleanup. Only `latest` tag is actively used.

5. **DynamoDB conversation table has no TTL**: Chat history accumulates indefinitely. Old conversations are never cleaned up.

6. **Lambda memory may be over-provisioned for some functions**: Without AWS Lambda Power Tuning analysis, the 512 MB and 1024 MB allocations may be higher than optimal.

7. **VPC endpoints incur hourly charges**: Interface endpoints for Secrets Manager and RDS cost ~$7.20/month each per AZ. With 2 AZs and 2 endpoints, that's ~$28.80/month. Evaluate if the security benefit justifies the cost for the workload volume.

8. **No cost allocation tags**: CDK stacks don't consistently apply cost allocation tags for tracking spend by component/team.

9. **Playground table has TTL but conversation table does not**: Inconsistent data lifecycle management.

---

## Pillar 6: Sustainability

### What's Working Well

1. **Managed services over self-managed**: Heavy use of managed services (RDS, DynamoDB, Lambda, Cognito, API Gateway, Amplify, Bedrock, EventBridge, SQS) minimizes operational overhead and leverages AWS's efficiency at scale.

2. **Graviton processors**: RDS uses ARM-based Graviton instances which are more energy-efficient than x86.

3. **Serverless compute (Lambda)**: Resources consumed only during actual request processing. No idle compute.

4. **On-demand DynamoDB**: No over-provisioned capacity sitting idle.

5. **TTL-based data lifecycle**: Automatic cleanup of ephemeral data (connections, playground sessions, notifications) reduces unnecessary storage.

6. **S3 lifecycle rules for temporary data**: Whitelist uploads expire after 1 day.

7. **Docker multi-stage builds** (implied by Dockerfile usage): Reduces final image size and deployment footprint.

### Findings / Gaps

1. **No data lifecycle for long-term storage**: Conversation history and audio files grow indefinitely. No archival or deletion strategy.

2. **No S3 storage class transitions**: Audio files and other S3 objects remain in STANDARD class regardless of access patterns.

3. **Single region deployment**: While not directly a sustainability issue, multi-region would allow serving users from closer edge locations, reducing network hops.

4. **No Lambda right-sizing analysis**: Without Power Tuning, functions may use more memory (and thus more CPU) than needed, wasting energy.

5. **VPC NAT Gateway always running**: Even during zero-traffic periods, the NAT Gateway consumes resources. Consider VPC endpoints for more services to reduce NAT Gateway traffic.

---

## Cross-Cutting Observations

### Patterns Across Pillars

1. **Single-AZ RDS is the biggest cross-pillar concern**: Impacts Reliability (SPOF), Performance (no read replicas), and Operational Excellence (no failover automation).

2. **Missing alarms/monitoring is the biggest operational gap**: Without alarms, issues are only discovered when users report them. This impacts all pillars.

3. **Secret rotation absence**: Impacts both Security (credential compromise risk) and Operational Excellence (manual rotation burden).

4. **No DLQ pattern**: Impacts Reliability (lost events) and Operational Excellence (no visibility into failures).

5. **Inconsistent data lifecycle**: Some tables have TTL, others don't. Some buckets have lifecycle rules, others don't. This impacts Cost Optimization and Sustainability.

### Architecture Strengths

- Well-structured CDK with clear stack separation and dependency management
- Consistent use of Lambda Powertools for observability
- Strong security posture with defense-in-depth (WAF + Cognito + Lambda authorizers + DB-level authorization)
- Good use of managed services reducing operational burden
- RDS Proxy for connection management is a best practice
- Bedrock Guardrails for AI safety

### Key Files Examined

| Area | Files |
|------|-------|
| CDK Entry | `cdk/bin/cdk.ts` |
| VPC | `cdk/lib/vpc-stack.ts` |
| Database | `cdk/lib/database-stack.ts` |
| API/Lambda | `cdk/lib/api-stack.ts` (2600+ lines) |
| CICD | `cdk/lib/cicd-stack.ts` |
| Amplify | `cdk/lib/amplify-stack.ts` |
| WAF | `cdk/lib/waf-stack.ts` |
| DB Migrations | `cdk/lib/dbFlow-stack.ts` |
| Text Generation | `cdk/lambda/text_generation/src/main.py`, `helpers/chat.py` |
| Handlers | `cdk/lambda/handlers/initializeConnection.js` |
| Authorization | `cdk/lambda/authorization/adminAuthorizerFunction.js` |
| WebSocket | `cdk/lambda/websocket/connect.js` |
| Notifications | `cdk/lambda/notificationService/index.js` |
| GitHub Workflows | `.github/workflows/codeql-analysis.yml` |
| Dependabot | `.github/dependabot.yml` |
| CDK Config | `cdk/cdk.json` |
