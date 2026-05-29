# Code Review: AWS Well-Architected Framework

**Reviewer:** Kiro  
**Date:** 2026-05-20  
**Scope:** Cross-cutting review against the six AWS Well-Architected Framework pillars (Operational Excellence, Security, Reliability, Performance Efficiency, Cost Optimization, Sustainability)  
**Status:** Complete  
**Remediation:** See [`REMEDIATION-STATUS.md`](REMEDIATION-STATUS.md)  
**Scope Coverage Note:** This review examines the entire codebase through the Well-Architected lens. `.github/workflows/codeql-analysis.yml` and `.github/dependabot.yml` are referenced in the Operational Excellence pillar (dependabot noted positively). The `cicd-stack.ts` deployment pipeline gaps are covered here (WA-M5, WA-M8) rather than in the CDK Infrastructure review.

---

## Summary

This document evaluates the LAIGO codebase against the six pillars of the AWS Well-Architected Framework. Unlike other topic reviews that focus on a specific technology layer, this review examines cross-cutting architectural concerns that span the entire system.

| Severity | Count | Fixed |
|----------|-------|-------|
| Critical | 0 | 0 |
| High | 6 | 0 |
| Medium | 8 | 0 |
| Low | 4 | 0 |
| **Total** | **18** | **0** |

---

## What's Well-Designed

### Operational Excellence

1. **Infrastructure as Code completeness**: The entire infrastructure is defined in CDK TypeScript (`cdk/lib/`). Seven stacks cover VPC, Database, DBFlow (migrations), CICD, API Gateway, Amplify, and WAF with no manual console resources detected.
2. **CI/CD pipeline for Docker Lambda functions**: `cicd-stack.ts` implements a CodePipeline with GitHub source, CodeBuild for Docker image builds, ECR vulnerability scanning (blocks on CRITICAL findings), and automated Lambda function code updates.
3. **Automated dependency updates**: Comprehensive `dependabot.yml` covers 10+ package ecosystems (npm, pip, Docker, GitHub Actions) with weekly schedules and grouped PRs.
4. **Database migrations as code**: `dbFlow-stack.ts` uses a CDK `TriggerFunction` with `node-pg-migrate` layer to run migrations automatically on deployment.
5. **Structured logging**: AWS Lambda Powertools used consistently across both Python (`Logger`, `Metrics`) and Node.js (`@aws-lambda-powertools/logger`) Lambda functions.

### Security

1. **IAM least privilege with dedicated roles**: Each Lambda function group has its own IAM role with only the permissions needed for its specific tasks.
2. **Secrets management via AWS Secrets Manager**: Database credentials and Cognito configuration stored in Secrets Manager with no hardcoded secrets in code.
3. **Network isolation**: RDS in PRIVATE_ISOLATED subnets, Lambda in PRIVATE_WITH_EGRESS subnets, database not publicly accessible.
4. **Encryption at rest and in transit**: RDS `storageEncrypted: true`, DynamoDB `TableEncryption.AWS_MANAGED`, S3 `BucketEncryption.S3_MANAGED`, RDS `rds.force_ssl = 1`, RDS Proxy `requireTLS: true`.
5. **WAF protection on both API Gateway and CloudFront**: Regional WAF on API Gateway + CloudFront-scoped WAF on Amplify with AWS Managed Rules and per-user rate limiting.
6. **Authorization at multiple layers**: JWT validation in authorizers + database role checks + per-resource ownership validation in handlers.

### Reliability

1. **RDS Proxy for connection pooling**: Eliminates connection exhaustion from Lambda cold starts and handles credential rotation transparently.
2. **Multi-AZ VPC subnets**: VPC configured with subnets across 2 AZs (new VPC) or 3 AZs (existing VPC with Control Tower).
3. **RDS backup retention and deletion protection**: 7-day automated backup retention with `deletionProtection: true`.
4. **DynamoDB on-demand capacity**: `PAY_PER_REQUEST` billing mode handles traffic spikes without capacity planning.
5. **TTL on ephemeral data**: WebSocket connections (2 hours), notifications (30 days), and playground sessions have TTL configured.
6. **Stale WebSocket connection cleanup**: Notification service detects 410 Gone errors and removes stale connections from DynamoDB.

### Performance Efficiency

1. **Graviton-based RDS instance**: `BURSTABLE4_GRAVITON` (t4g) provides better price-performance than x86 instances.
2. **Lambda memory right-sizing by function type**: Authorizers at 256 MB, handlers at 512 MB, AI functions at 1024 MB — appropriately tiered.
3. **WebSocket streaming for LLM responses**: Chunks streamed to the client in real-time rather than waiting for full response.
4. **Connection reuse in Lambda**: Both Python (`global connection`) and Node.js (`global.sqlConnection`) reuse database connections across invocations.
5. **CDN via Amplify/CloudFront**: Frontend static assets served via CloudFront edge locations.

### Cost Optimization

1. **DynamoDB on-demand billing**: `PAY_PER_REQUEST` avoids paying for unused provisioned capacity.
2. **Burstable RDS instance (t4g.medium)**: Cost-effective for workloads that don't need sustained high CPU.
3. **S3 lifecycle rules on whitelist uploads**: 1-day expiration prevents accumulation of temporary upload files.
4. **DynamoDB TTL on ephemeral data**: Automatic deletion of expired WebSocket connections and playground sessions reduces storage costs.
5. **S3 managed encryption (SSE-S3)**: Free encryption vs. KMS which charges per API call.

### Sustainability

1. **Managed services over self-managed**: Heavy use of managed services (RDS, DynamoDB, Lambda, Cognito, API Gateway, Amplify, Bedrock) minimizes operational overhead and leverages AWS's efficiency at scale.
2. **Graviton processors**: ARM-based Graviton instances are more energy-efficient than x86.
3. **Serverless compute (Lambda)**: Resources consumed only during actual request processing with no idle compute.
4. **TTL-based data lifecycle**: Automatic cleanup of ephemeral data reduces unnecessary storage.

---

## High Issues

### WA-H1. RDS is Single-AZ — single point of failure for the entire application
- **Status:** ⬜ Open
- **Pillar:** Reliability
- **File:** `cdk/lib/database-stack.ts`
- **Description:** The RDS instance is configured with `multiAz: false`. A single Availability Zone failure takes down the database, which is the backbone of the entire application. All Lambda functions depend on this database for authorization, case data, and user management.
- **Impact:** Complete application outage during an AZ failure. RDS single-AZ instances also have longer maintenance windows and no automatic failover. Combined with the single NAT Gateway (also single-AZ), an AZ failure causes total system unavailability.
- **Fix:**

❌ **Problem:**
```typescript
const rdsInstance = new rds.DatabaseInstance(this, "Database", {
  engine: rds.DatabaseInstanceEngine.postgres({ version: rds.PostgresEngineVersion.VER_15 }),
  instanceType: ec2.InstanceType.of(ec2.InstanceClass.BURSTABLE4_GRAVITON, ec2.InstanceSize.MEDIUM),
  multiAz: false, // Single point of failure
  vpc,
  vpcSubnets: { subnetType: ec2.SubnetType.PRIVATE_ISOLATED },
  // ...
});
```

✅ **Fix:**
```typescript
const rdsInstance = new rds.DatabaseInstance(this, "Database", {
  engine: rds.DatabaseInstanceEngine.postgres({ version: rds.PostgresEngineVersion.VER_15 }),
  instanceType: ec2.InstanceType.of(ec2.InstanceClass.BURSTABLE4_GRAVITON, ec2.InstanceSize.MEDIUM),
  multiAz: true, // Automatic failover to standby in another AZ
  vpc,
  vpcSubnets: { subnetType: ec2.SubnetType.PRIVATE_ISOLATED },
  // ...
});
```

---

### WA-H2. No CloudWatch Alarms defined anywhere in the infrastructure
- **Status:** ⬜ Open
- **Pillar:** Operational Excellence
- **File:** `cdk/lib/api-stack.ts`, `cdk/lib/database-stack.ts`
- **Description:** Zero CloudWatch Alarms exist in the entire CDK codebase. There is no alerting on Lambda errors, API Gateway 5xx rates, RDS CPU/connections, DynamoDB throttling, or Bedrock throttling. Issues are only discovered when users report them.
- **Impact:** Operational blindness — production incidents go undetected until user-reported. Mean time to detection (MTTD) is entirely dependent on user complaints rather than proactive monitoring.
- **Fix:**

❌ **Problem:**
```typescript
// No alarms defined anywhere in the CDK stacks
// Zero monitoring automation
```

✅ **Fix:**
```typescript
import * as cloudwatch from "aws-cdk-lib/aws-cloudwatch";
import * as actions from "aws-cdk-lib/aws-cloudwatch-actions";
import * as sns from "aws-cdk-lib/aws-sns";

// Create an SNS topic for alarm notifications
const alarmTopic = new sns.Topic(this, "AlarmTopic", {
  displayName: "LAIGO Production Alarms",
});

// Lambda error alarm
new cloudwatch.Alarm(this, "TextGenErrorAlarm", {
  metric: textGenerationFunction.metricErrors({ period: cdk.Duration.minutes(5) }),
  threshold: 5,
  evaluationPeriods: 2,
  alarmDescription: "Text generation Lambda errors exceed threshold",
  actionsEnabled: true,
}).addAlarmAction(new actions.SnsAction(alarmTopic));

// API Gateway 5xx alarm
new cloudwatch.Alarm(this, "Api5xxAlarm", {
  metric: api.metricServerError({ period: cdk.Duration.minutes(5) }),
  threshold: 10,
  evaluationPeriods: 2,
  alarmDescription: "API Gateway 5xx errors exceed threshold",
}).addAlarmAction(new actions.SnsAction(alarmTopic));

// RDS CPU alarm
new cloudwatch.Alarm(this, "RdsCpuAlarm", {
  metric: rdsInstance.metricCPUUtilization({ period: cdk.Duration.minutes(5) }),
  threshold: 80,
  evaluationPeriods: 3,
  alarmDescription: "RDS CPU utilization exceeds 80%",
}).addAlarmAction(new actions.SnsAction(alarmTopic));
```

---

### WA-H3. Single NAT Gateway creates a single point of failure
- **Status:** ⬜ Open
- **Pillar:** Reliability
- **File:** `cdk/lib/vpc-stack.ts`
- **Description:** The VPC is configured with `natGateways: 1`. If the NAT Gateway's Availability Zone fails, all Lambda functions in private subnets lose internet access. This is required for reaching Bedrock, Secrets Manager (without endpoint), and other AWS services.
- **Impact:** All private subnet Lambda functions become non-functional during an AZ failure. Combined with single-AZ RDS, this creates a complete system outage from a single AZ failure.
- **Fix:**

❌ **Problem:**
```typescript
const vpc = new ec2.Vpc(this, "VPC", {
  maxAzs: 2,
  natGateways: 1, // Single NAT Gateway — AZ failure = total outage
  subnetConfiguration: [
    { subnetType: ec2.SubnetType.PUBLIC, name: "Public" },
    { subnetType: ec2.SubnetType.PRIVATE_WITH_EGRESS, name: "Private" },
    { subnetType: ec2.SubnetType.PRIVATE_ISOLATED, name: "Isolated" },
  ],
});
```

✅ **Fix:**
```typescript
const vpc = new ec2.Vpc(this, "VPC", {
  maxAzs: 2,
  natGateways: 2, // One NAT Gateway per AZ for high availability
  subnetConfiguration: [
    { subnetType: ec2.SubnetType.PUBLIC, name: "Public" },
    { subnetType: ec2.SubnetType.PRIVATE_WITH_EGRESS, name: "Private" },
    { subnetType: ec2.SubnetType.PRIVATE_ISOLATED, name: "Isolated" },
  ],
});
```

---

### WA-H4. No Dead Letter Queues (DLQ) on any Lambda function
- **Status:** ⬜ Open
- **Pillar:** Reliability
- **File:** `cdk/lib/api-stack.ts`
- **Description:** Zero DLQ configurations exist across all Lambda functions. When asynchronous invocations fail (e.g., case_generation, notification service), the events are silently lost with no retry mechanism and no visibility into failures.
- **Impact:** Failed asynchronous operations (case generation, notifications, assessments) are permanently lost. No ability to replay failed events or diagnose intermittent failures.
- **Fix:**

❌ **Problem:**
```typescript
const caseGenerationFunction = new lambda.DockerImageFunction(this, "CaseGeneration", {
  code: lambda.DockerImageCode.fromEcr(caseGenRepo),
  timeout: cdk.Duration.seconds(120),
  memorySize: 512,
  // No DLQ configured — failed async invocations are lost
});
```

✅ **Fix:**
```typescript
import * as sqs from "aws-cdk-lib/aws-sqs";

const caseGenDlq = new sqs.Queue(this, "CaseGenDLQ", {
  retentionPeriod: cdk.Duration.days(14),
  encryption: sqs.QueueEncryption.SQS_MANAGED,
});

const caseGenerationFunction = new lambda.DockerImageFunction(this, "CaseGeneration", {
  code: lambda.DockerImageCode.fromEcr(caseGenRepo),
  timeout: cdk.Duration.seconds(120),
  memorySize: 512,
  deadLetterQueue: caseGenDlq,
  retryAttempts: 2,
});

// Alarm on DLQ messages for visibility
new cloudwatch.Alarm(this, "CaseGenDlqAlarm", {
  metric: caseGenDlq.metricApproximateNumberOfMessagesVisible(),
  threshold: 1,
  evaluationPeriods: 1,
  alarmDescription: "Case generation failures detected in DLQ",
});
```

---

### WA-H5. No secret rotation configured for database credentials
- **Status:** ⬜ Open
- **Pillar:** Security
- **File:** `cdk/lib/database-stack.ts`
- **Description:** Database secrets (`secretPathAdmin`, `secretPathUser`, `secretPathTableCreator`) have no rotation schedule configured. Long-lived credentials increase the risk window if a secret is compromised. AWS Secrets Manager supports automatic rotation for RDS credentials.
- **Impact:** If a credential is compromised, it remains valid indefinitely until manually rotated. This extends the attack window and violates the principle of credential hygiene.
- **Fix:**

❌ **Problem:**
```typescript
const dbSecret = new secretsmanager.Secret(this, "DBSecret", {
  secretName: "laigo/db/admin",
  generateSecretString: {
    secretStringTemplate: JSON.stringify({ username: "admin" }),
    generateStringKey: "password",
    excludePunctuation: true,
  },
  // No rotation configured — credentials live indefinitely
});
```

✅ **Fix:**
```typescript
const dbSecret = new secretsmanager.Secret(this, "DBSecret", {
  secretName: "laigo/db/admin",
  generateSecretString: {
    secretStringTemplate: JSON.stringify({ username: "admin" }),
    generateStringKey: "password",
    excludePunctuation: true,
  },
});

// Enable automatic rotation every 30 days
dbSecret.addRotationSchedule("RotationSchedule", {
  automaticallyAfter: cdk.Duration.days(30),
  hostedRotation: secretsmanager.HostedRotation.postgreSqlSingleUser({
    vpc,
    vpcSubnets: { subnetType: ec2.SubnetType.PRIVATE_ISOLATED },
  }),
});
```

---

### WA-H6. No Lambda Provisioned Concurrency for AI-heavy functions
- **Status:** ⬜ Open
- **Pillar:** Performance Efficiency
- **File:** `cdk/lib/api-stack.ts`
- **Description:** Docker-based Lambda functions (text_generation, playground_generation) with large images likely have significant cold start times (5-15 seconds). No provisioned concurrency is configured, meaning the first user request after an idle period experiences a very long response time.
- **Impact:** Poor user experience on first interaction. Users waiting 5-15 seconds for a cold start before the LLM even begins processing creates the perception of a broken application.
- **Fix:**

❌ **Problem:**
```typescript
const textGenerationFunction = new lambda.DockerImageFunction(this, "TextGeneration", {
  code: lambda.DockerImageCode.fromEcr(textGenRepo),
  timeout: cdk.Duration.seconds(120),
  memorySize: 1024,
  // No provisioned concurrency — cold starts of 5-15s for Docker images
});
```

✅ **Fix:**
```typescript
const textGenerationFunction = new lambda.DockerImageFunction(this, "TextGeneration", {
  code: lambda.DockerImageCode.fromEcr(textGenRepo),
  timeout: cdk.Duration.seconds(120),
  memorySize: 1024,
});

// Create an alias with provisioned concurrency
const textGenAlias = new lambda.Alias(this, "TextGenLive", {
  aliasName: "live",
  version: textGenerationFunction.currentVersion,
  provisionedConcurrentExecutions: 2, // Keep 2 instances warm
});

// Use the alias in API Gateway integration
// This ensures at least 2 instances are always warm
```

---

## Medium Issues

### WA-M1. No deployment pipeline for non-Docker Lambda functions
- **Status:** ⬜ Open
- **Pillar:** Operational Excellence
- **File:** `cdk/lib/cicd-stack.ts`
- **Description:** The CICD stack only handles Docker-based Lambda functions (text_generation, playground_generation). The 10+ other Lambda functions (student/admin/instructor handlers, authorizers, WebSocket handlers, case_generation, etc.) have no automated deployment pipeline. Changes require manual `cdk deploy`.
- **Impact:** Inconsistent deployment practices. Docker Lambdas have automated CI/CD with vulnerability scanning, while the majority of functions are deployed manually without quality gates.

---

### WA-M2. X-Ray tracing only on Python Lambdas, not Node.js
- **Status:** ⬜ Open
- **Pillar:** Operational Excellence
- **File:** `cdk/lib/api-stack.ts`
- **Description:** `tracing: lambda.Tracing.ACTIVE` is set on Python Docker functions (text_generation, playground_generation, case_generation, assess_progress, summary_generation) but NOT on Node.js handler functions (student, admin, instructor, authorizers, WebSocket). This creates blind spots in distributed tracing.
- **Impact:** Incomplete request traces. When debugging latency or errors, the Node.js handler portion of the request is invisible in X-Ray service maps, making root cause analysis difficult.

---

### WA-M3. No DynamoDB Point-in-Time Recovery (PITR)
- **Status:** ⬜ Open
- **Pillar:** Reliability
- **File:** `cdk/lib/api-stack.ts`
- **Description:** Conversation history, notifications, and connection tables have no PITR enabled. Data loss from accidental deletes or application bugs is unrecoverable. See also: [security] S-M7
- **Impact:** Permanent data loss if tables are accidentally corrupted or items deleted. No recovery path for compliance audits requiring conversation history.

---

### WA-M4. DynamoDB tables use DESTROY removal policy
- **Status:** ⬜ Open
- **Pillar:** Reliability
- **File:** `cdk/lib/api-stack.ts`
- **Description:** `chatHistoryTable`, `playgroundTable`, `notificationTable`, and `connectionTable` all use `RemovalPolicy.DESTROY`. A stack deletion (accidental or intentional) permanently destroys all conversation data.
- **Impact:** Accidental `cdk destroy` or CloudFormation rollback permanently deletes all user conversation history and notification data with no recovery path.

---

### WA-M5. No S3 Intelligent Tiering on audio bucket
- **Status:** ⬜ Open
- **Pillar:** Cost Optimization
- **File:** `cdk/lib/api-stack.ts`
- **Description:** The audio prompt bucket has no lifecycle rules. Old audio files accumulate indefinitely in STANDARD storage class with no transition to cheaper tiers (Infrequent Access, Glacier) regardless of access patterns.
- **Impact:** Unnecessary storage costs as audio files age. Files accessed once during case creation remain in expensive STANDARD storage permanently.

---

### WA-M6. No ECR image lifecycle policy
- **Status:** ⬜ Open
- **Pillar:** Cost Optimization
- **File:** `cdk/lib/cicd-stack.ts`
- **Description:** Old Docker images accumulate in ECR repositories without cleanup. Only the `latest` tag is actively used, but previous images are retained indefinitely. ECR repositories are also set to `RETAIN` removal policy.
- **Impact:** Unbounded ECR storage costs. Each Docker image for text_generation and playground_generation can be 500MB+, accumulating with every deployment.

---

### WA-M7. No cost allocation tags on CDK stacks
- **Status:** ⬜ Open
- **Pillar:** Cost Optimization
- **File:** `cdk/bin/cdk.ts`, `cdk/lib/*.ts`
- **Description:** CDK stacks don't consistently apply cost allocation tags for tracking spend by component or team. Without tags, AWS Cost Explorer cannot break down costs by service area.
- **Impact:** Inability to attribute costs to specific features or teams. Makes cost optimization decisions difficult without visibility into which components drive spend.

---

### WA-M8. No data lifecycle strategy for conversation history
- **Status:** ⬜ Open
- **Pillar:** Sustainability
- **File:** `cdk/lib/api-stack.ts`
- **Description:** The DynamoDB conversation history table has no TTL configured (unlike playground and connection tables). Chat history accumulates indefinitely with no archival or deletion strategy. This also impacts Cost Optimization.
- **Impact:** Unbounded storage growth. Old conversations that are no longer accessed consume resources indefinitely, increasing both costs and environmental footprint.

---

## Low Issues

### WA-L1. API Gateway access logs retention is only ONE_WEEK
- **Status:** ⬜ Open
- **Pillar:** Operational Excellence
- **File:** `cdk/lib/api-stack.ts`
- **Description:** `logs.RetentionDays.ONE_WEEK` for API access logs is very short for audit and debugging purposes. Investigating issues reported after a week is impossible.
- **Impact:** Limited forensic capability. Security incidents or performance issues reported after 7 days cannot be investigated through access logs.

---

### WA-L2. No health check endpoints
- **Status:** ⬜ Open
- **Pillar:** Reliability
- **File:** `cdk/lib/api-stack.ts`
- **Description:** No dedicated health check Lambda or API endpoint exists for monitoring system availability. External monitoring tools have no lightweight endpoint to probe.
- **Impact:** Cannot implement external uptime monitoring (e.g., Route 53 health checks, third-party monitors) without hitting production endpoints that perform real work.

---

### WA-L3. Lambda memory may be over-provisioned for some functions
- **Status:** ⬜ Open
- **Pillar:** Cost Optimization
- **File:** `cdk/lib/api-stack.ts`
- **Description:** Without AWS Lambda Power Tuning analysis, the 512 MB and 1024 MB memory allocations may be higher than optimal. Over-provisioned memory wastes both cost and energy.
- **Impact:** Potential 10-30% cost savings on Lambda compute if right-sized. Also impacts Sustainability pillar through unnecessary energy consumption.

---

### WA-L4. VPC endpoints incur hourly charges that may not be justified
- **Status:** ⬜ Open
- **Pillar:** Cost Optimization
- **File:** `cdk/lib/vpc-stack.ts`
- **Description:** Interface endpoints for Secrets Manager and RDS cost ~$7.20/month each per AZ. With 2 AZs and 2 endpoints, that's ~$28.80/month. For low-traffic workloads, the security benefit may not justify the cost.
- **Impact:** ~$345/year in endpoint costs. For a low-volume application, this may exceed the cost of the traffic that would otherwise traverse the NAT Gateway.

---

## Architectural Recommendations

### Operational Excellence

**1. Implement comprehensive CloudWatch monitoring**

Deploy a monitoring stack with alarms for all critical metrics: Lambda errors, API Gateway 5xx rates, RDS CPU/connections/storage, DynamoDB throttling, and Bedrock throttling. Create a CloudWatch Dashboard for at-a-glance system health. This is the single most impactful operational improvement.

**2. Extend CI/CD to all Lambda functions**

Expand the existing CodePipeline to cover non-Docker Lambda functions. Include linting, unit tests, and security scanning as quality gates. This ensures consistent deployment practices across all compute resources.

**3. Enable X-Ray tracing on all Lambda functions**

Add `tracing: lambda.Tracing.ACTIVE` to Node.js handler functions to complete the distributed tracing picture. This enables end-to-end request tracing from API Gateway through authorizers to handlers and database calls.

### Security

**4. Implement secret rotation for all database credentials**

Configure automatic rotation schedules (30-day cycle) for all Secrets Manager secrets. Use the RDS Proxy to handle credential rotation transparently without application downtime. Scope IAM policies to specific resources rather than wildcards.

**5. Reduce overly broad IAM permissions**

Scope `rds-db:connect` to specific database instance ARNs. Replace `AmazonSSMReadOnlyAccess` with a custom policy limited to required parameters. Replace `CloudWatchLogsFullAccess` with permissions scoped to specific log groups.

### Reliability

**6. Enable Multi-AZ for RDS and add a second NAT Gateway**

This is the highest-priority reliability improvement. Multi-AZ RDS provides automatic failover with <60 second recovery. A second NAT Gateway eliminates the network single point of failure. Together, these changes make the system resilient to a single AZ failure.

**7. Add Dead Letter Queues to all asynchronous Lambda functions**

Configure DLQs on case_generation, notification service, and any other async-invoked functions. Add CloudWatch Alarms on DLQ message counts for immediate visibility into failures. Implement a DLQ replay mechanism for recovery.

**8. Enable DynamoDB PITR and change removal policies to RETAIN**

Enable Point-in-Time Recovery on conversation history and notification tables. Change removal policies from DESTROY to RETAIN for tables containing user data. This protects against both accidental deletion and data corruption.

### Performance Efficiency

**9. Add Provisioned Concurrency for user-facing AI functions**

Configure provisioned concurrency (2-3 instances) on text_generation and playground_generation functions. Use Application Auto Scaling to adjust based on usage patterns. This eliminates cold start latency for the most latency-sensitive user interactions.

**10. Evaluate a caching layer for frequently accessed data**

System prompts, case metadata, and user roles are fetched from RDS on every invocation. Consider ElastiCache (Redis) or DAX for DynamoDB to reduce database load and improve response times for repeated queries.

### Cost Optimization

**11. Implement S3 lifecycle rules and ECR image cleanup**

Add Intelligent Tiering or transition rules on the audio bucket. Add ECR lifecycle policies to retain only the last 5-10 images. Add TTL to the conversation history table or implement an archival strategy.

**12. Apply cost allocation tags across all stacks**

Add consistent tags (`Project`, `Environment`, `Component`) to all CDK stacks and resources. Enable these as cost allocation tags in AWS Billing to gain visibility into per-component spend.

### Sustainability

**13. Implement comprehensive data lifecycle management**

Define retention policies for all data stores: conversation history (archive after 90 days, delete after 1 year), audio files (transition to Glacier after 30 days), ECR images (retain last 10). This reduces unnecessary storage and associated energy consumption.

**14. Run Lambda Power Tuning analysis**

Use the AWS Lambda Power Tuning tool to identify optimal memory configurations for each function. Right-sizing reduces both cost and energy consumption by avoiding over-provisioned compute resources.

---

## Pillar Assessment Summary

| Pillar | Rating | Key Gap |
|--------|--------|---------|
| Operational Excellence | ⚠️ Moderate | No alarms, incomplete CI/CD, partial tracing |
| Security | ✅ Strong | No secret rotation, some broad IAM policies |
| Reliability | ❌ Weak | Single-AZ RDS, single NAT GW, no DLQs, no PITR |
| Performance Efficiency | ⚠️ Moderate | No provisioned concurrency, no caching layer |
| Cost Optimization | ⚠️ Moderate | No lifecycle policies, no cost tags, no right-sizing |
| Sustainability | ⚠️ Moderate | No data lifecycle, no right-sizing analysis |

**Overall:** The application has a strong security posture and good use of managed services, but significant reliability gaps (single-AZ architecture) and operational blindness (no alarms) represent the most urgent areas for improvement.

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
- [x] Well-Architected (AWS Framework Pillars) — Complete

---

## Cross-References to Other Topic Reviews

This Well-Architected review is cross-cutting and identifies findings that overlap with other topic reviews:

| Finding | Related Review | Related Finding |
|---------|---------------|-----------------|
| WA-H1 (Single-AZ RDS) | RDS | RDS-H2 |
| WA-H3 (Single NAT Gateway) | CDK Infrastructure | H4 |
| WA-H4 (No DLQs) | — | — |
| WA-H5 (No secret rotation) | RDS | RDS-H1 |
| WA-M3 (No DynamoDB PITR) | Security | S-M7 |
| WA-M4 (DESTROY removal policy) | CDK Infrastructure | — |
| WA-M8 (No conversation TTL) | Security | S-H7 (related) |
