# Code Review: RDS Configuration & Management

**Reviewer:** Kiro  
**Date:** 2025-07-14  
**Scope:** RDS instance configuration, security groups, parameter groups, backup/recovery, encryption (at-rest and in-transit), connection management patterns across all Lambda functions  
**Status:** Complete (remediation tracked in [`REMEDIATION-STATUS.md`](REMEDIATION-STATUS.md))

---

## Summary

| Severity | Count | Fixed |
|----------|-------|-------|
| Critical | 0     | 0     |
| High     | 4     | 0     |
| Medium   | 5     | 0     |
| Low      | 3     | 0     |
| **Total**| **12**| **0** |

---

## What's Well-Designed

**RDS Proxy for Lambda connection pooling.** Using RDS Proxy eliminates the cold-start connection storm problem inherent to Lambda-to-RDS architectures. The proxy handles connection multiplexing, credential rotation, and TLS termination — exactly the right pattern for serverless workloads.

**SSL/TLS enforced at multiple layers.** The defense-in-depth approach is excellent: `rds.force_ssl: "1"` at the parameter group level, `requireTLS: true` on the RDS Proxy, and `ssl: "require"` in every application connection string. Even if one layer is misconfigured, the others prevent unencrypted connections.

**Database deployed in PRIVATE_ISOLATED subnets.** The RDS instance has no internet access and is not publicly accessible. Combined with VPC endpoints for Secrets Manager, credential retrieval never traverses the public internet.

**Deletion protection enabled.** `deletionProtection: true` prevents accidental database deletion via CloudFormation or console actions.

**Storage encryption at rest enabled.** `storageEncrypted: true` ensures all data, backups, and snapshots are encrypted.

**Separate database users with role-based access.** Three distinct credential sets (admin, application user, table creator) enforce least-privilege at the database layer. Application code uses the minimum privilege level required.

**db_setup Lambda uses `verify-full` SSL mode.** The migration Lambda validates the full certificate chain with an explicit CA bundle — the strongest possible TLS verification for direct RDS connections.

**VPC endpoints for Secrets Manager.** Lambda functions retrieve database credentials without internet access, reducing the attack surface for credential interception.

**Enhanced Monitoring enabled.** 60-second granularity OS-level metrics provide visibility into CPU, memory, I/O, and network at the instance level.

---

## High Issues

### RDS-H1. No automatic secret rotation configured
- **Status:** ⬜ Open
- **File:** `cdk/lib/database-stack.ts`
- **Description:** Database credentials are created with placeholder values and only rotated when the `db_setup` Lambda runs during deployment. There is no AWS Secrets Manager rotation schedule configured. If credentials are compromised, they remain valid indefinitely until the next deployment.
- **Impact:** Compromised credentials provide persistent database access with no automatic expiry. This violates AWS security best practices and most compliance frameworks (SOC 2, ISO 27001) that require periodic credential rotation.
- **Fix:**

❌ Current — no rotation configured:
```typescript
this.secretPathUser = new secretsmanager.Secret(this, secretPathUserName, {
  secretName: secretPathUserName,
  description: "Secrets for clients to connect to RDS",
  removalPolicy: RemovalPolicy.DESTROY,
  secretObjectValue: {
    username: SecretValue.unsafePlainText("applicationUsername"),
    password: SecretValue.unsafePlainText("applicationPassword"),
  },
});
```

✅ Recommended — add rotation schedule with a rotation Lambda:
```typescript
this.secretPathUser = new secretsmanager.Secret(this, secretPathUserName, {
  secretName: secretPathUserName,
  description: "Secrets for clients to connect to RDS",
  removalPolicy: RemovalPolicy.DESTROY,
  secretObjectValue: {
    username: SecretValue.unsafePlainText("applicationUsername"),
    password: SecretValue.unsafePlainText("applicationPassword"),
  },
});

// Add automatic rotation every 30 days
this.secretPathUser.addRotationSchedule("UserSecretRotation", {
  automaticallyAfter: Duration.days(30),
  hostedRotation: secretsmanager.HostedRotation.postgreSqlSingleUser({
    vpc: vpcStack.vpc,
    vpcSubnets: { subnetType: ec2.SubnetType.PRIVATE_ISOLATED },
  }),
});
```

---

### RDS-H2. Multi-AZ disabled — single point of failure for database
- **Status:** ⬜ Open
- **File:** `cdk/lib/database-stack.ts`
- **Description:** The RDS instance is deployed with `multiAz: false`. If the single Availability Zone experiences an outage, the database becomes unavailable with no automatic failover. For a production application handling legal case data, this creates unacceptable downtime risk.
- **Impact:** AZ failure results in complete application outage. RTO depends on manual intervention to restore from backup (potentially hours). Legal professionals lose access to active cases during the outage.
- **Fix:**

❌ Current:
```typescript
this.dbInstance = new rds.DatabaseInstance(this, `${id}-database`, {
  // ...
  multiAz: false, // Single AZ deployment for cost savings
  // ...
});
```

✅ Recommended — enable Multi-AZ for production:
```typescript
const isProduction = this.node.tryGetContext("environment") === "production";

this.dbInstance = new rds.DatabaseInstance(this, `${id}-database`, {
  // ...
  multiAz: isProduction, // Multi-AZ for production, single-AZ for dev
  // ...
});
```

---

### RDS-H3. VPC-wide security group rule allows any resource in VPC to connect
- **Status:** ⬜ Open
- **File:** `cdk/lib/database-stack.ts`
- **Description:** The security group unconditionally adds an ingress rule for the entire VPC CIDR range on port 5432. This means any EC2 instance, Lambda function, or other compute resource in the VPC can connect to the database — not just the authorized Lambda functions. When private subnet CIDRs are also provided (existing VPC path), the VPC-wide rule makes the subnet-specific rules redundant.
- **Impact:** Overly permissive network access. If any resource in the VPC is compromised, it can attempt database connections. This violates the principle of least privilege at the network layer.
- **Fix:**

❌ Current — VPC-wide rule added unconditionally:
```typescript
// Allow database access from anywhere within the VPC
this.dbInstance.connections.securityGroups.forEach(
  function (securityGroup) {
    securityGroup.addIngressRule(
      ec2.Peer.ipv4(vpcStack.vpcCidrString),
      ec2.Port.tcp(5432),
      "Allow PostgreSQL traffic from VPC",
    );
  },
);
```

✅ Recommended — use security group references instead of CIDR:
```typescript
// Allow only specific Lambda security groups to connect
// Remove the VPC-wide CIDR rule entirely.
// Instead, grant access from Lambda security groups in the API stack:
//
// dbInstance.connections.allowFrom(
//   lambdaSecurityGroup,
//   ec2.Port.tcp(5432),
//   "Allow PostgreSQL from authorized Lambda functions"
// );
//
// This requires passing the Lambda security group from the API stack
// or creating a shared security group for database-accessing Lambdas.
```

---

### RDS-H4. Handler connection module lacks timeout configuration
- **Status:** ⬜ Open
- **File:** `cdk/cdk.out/asset.20379755b8f277769c405e258cda0d1d1cf353e446f3af0bd6c2b09f96e07a86/initializeConnection.js`
- **Description:** The main handler `initializeConnection.js` creates a PostgreSQL connection without specifying `max`, `idle_timeout`, or `connect_timeout` parameters. In contrast, the authorizer module correctly configures all three. Without timeouts, a Lambda function can hang indefinitely waiting for a database connection during network issues or RDS failover events, consuming the full Lambda timeout (up to 15 minutes) and incurring unnecessary costs.
- **Impact:** Lambda functions may hang for their entire configured timeout during database connectivity issues. This wastes compute costs and delays error responses to users. Connection leaks are also possible without `max` and `idle_timeout`.
- **Fix:**

❌ Current — no timeout or pool configuration:
```javascript
const connectionConfig = {
  host: RDS_PROXY_ENDPOINT,
  port: credentials.port,
  username: credentials.username,
  password: credentials.password,
  database: credentials.dbname,
  ssl: "require",
};

global.sqlConnection = postgres(connectionConfig);
```

✅ Recommended — add timeout and pool settings (matching authorizer pattern):
```javascript
const connectionConfig = {
  host: RDS_PROXY_ENDPOINT,
  port: credentials.port || 5432,
  username: credentials.username,
  password: credentials.password,
  database: credentials.dbname,
  ssl: "require",
  max: 1,              // Single connection per Lambda instance
  idle_timeout: 20,    // Close idle connections after 20 seconds
  connect_timeout: 10, // Fail fast if connection takes >10 seconds
};

global.sqlConnection = postgres(connectionConfig);
```

---

## Medium Issues

### RDS-M1. RDS Proxy IAM role uses wildcard resource
- **Status:** ⬜ Open
- **File:** `cdk/lib/database-stack.ts`
- **Description:** The RDS Proxy IAM role grants `rds-db:connect` on `"*"` (all resources). This should be scoped to the specific database instance ARN to follow least-privilege principles.
```typescript
rdsProxyRole.addToPolicy(
  new iam.PolicyStatement({
    resources: ["*"],
    actions: ["rds-db:connect"],
  }),
);
```
- **Impact:** If the role is assumed by an unintended principal, it could connect to any RDS database in the account, not just the LAIGO instance.
- **Fix:** Scope the resource to the specific DB instance:
```typescript
rdsProxyRole.addToPolicy(
  new iam.PolicyStatement({
    resources: [
      `arn:aws:rds-db:${this.region}:${this.account}:dbuser:${this.dbInstance.instanceResourceId}/*`
    ],
    actions: ["rds-db:connect"],
  }),
);
```

---

### RDS-M2. No Performance Insights or query-level monitoring enabled
- **Status:** ⬜ Open
- **File:** `cdk/lib/database-stack.ts`
- **Description:** Performance Insights is not enabled on the RDS instance, and the `pg_stat_statements` extension is not configured in the parameter group. Without these, there is no visibility into slow queries, lock contention, or query plan regressions. Enhanced Monitoring provides OS-level metrics but not application-level query insights.
- **Impact:** Database performance issues are difficult to diagnose. Slow queries can degrade user experience without any alerting or visibility until they cause timeouts.
- **Fix:** Enable Performance Insights and add monitoring parameters:
```typescript
this.dbInstance = new rds.DatabaseInstance(this, `${id}-database`, {
  // ... existing config ...
  enablePerformanceInsights: true,
  performanceInsightRetention: rds.PerformanceInsightRetention.DEFAULT, // 7 days free tier
});

// Add to parameter group:
parameters: {
  "rds.force_ssl": "1",
  "shared_preload_libraries": "pg_stat_statements",
  "pg_stat_statements.track": "all",
  "log_min_duration_statement": "1000", // Log queries taking >1 second
},
```

---

### RDS-M3. No CloudWatch Alarms for database health metrics
- **Status:** ⬜ Open
- **File:** `cdk/lib/database-stack.ts`
- **Description:** No CloudWatch Alarms are configured for critical RDS metrics such as CPU utilization, free storage space, database connections count, or read/write latency. The team has no automated alerting when the database approaches resource limits.
- **Impact:** Database issues (storage exhaustion, connection saturation, high CPU) go undetected until they cause user-visible failures. Proactive intervention is impossible without alerts.
- **Fix:** Add CloudWatch Alarms for key metrics:
```typescript
import * as cloudwatch from "aws-cdk-lib/aws-cloudwatch";
import * as actions from "aws-cdk-lib/aws-cloudwatch-actions";

// Free storage space alarm (< 10 GB)
new cloudwatch.Alarm(this, "RDSFreeStorageAlarm", {
  metric: this.dbInstance.metricFreeStorageSpace(),
  threshold: 10 * 1024 * 1024 * 1024, // 10 GB in bytes
  evaluationPeriods: 2,
  comparisonOperator: cloudwatch.ComparisonOperator.LESS_THAN_THRESHOLD,
});

// CPU utilization alarm (> 80%)
new cloudwatch.Alarm(this, "RDSCPUAlarm", {
  metric: this.dbInstance.metricCPUUtilization(),
  threshold: 80,
  evaluationPeriods: 3,
});

// Database connections alarm (> 80% of max)
new cloudwatch.Alarm(this, "RDSConnectionsAlarm", {
  metric: this.dbInstance.metricDatabaseConnections(),
  threshold: 80, // db.t4g.medium supports ~100 connections
  evaluationPeriods: 2,
});
```

---

### RDS-M4. Backup retention at minimum recommended level with no cross-region replication
- **Status:** ⬜ Open
- **File:** `cdk/lib/database-stack.ts`
- **Description:** Backup retention is set to 7 days (the minimum recommended for production) with `deleteAutomatedBackups: true`. Combined with no cross-region backup replication, a region-level failure could result in data loss. The 7-day window also limits the ability to recover from data corruption that isn't detected immediately.
- **Impact:** Data corruption discovered after 7 days cannot be recovered from automated backups. Region-level disaster has no recovery path. `deleteAutomatedBackups: true` means if deletion protection is ever removed and the instance deleted, all backups are permanently lost.
- **Fix:** Increase retention and consider cross-region backups:
```typescript
this.dbInstance = new rds.DatabaseInstance(this, `${id}-database`, {
  // ... existing config ...
  backupRetention: Duration.days(14), // Increase to 14 days minimum
  deleteAutomatedBackups: false,       // Retain backups even if instance deleted
});
```

---

### RDS-M5. No database logging parameters configured
- **Status:** ⬜ Open
- **File:** `cdk/lib/database-stack.ts`
- **Description:** The custom parameter group only sets `rds.force_ssl`. No logging parameters are configured for connection tracking, slow query logging, or disconnection events. This limits the ability to audit database access and diagnose performance issues.
- **Impact:** No visibility into who connects to the database, which queries are slow, or when connections are dropped. Security auditing and performance troubleshooting are significantly hampered.
- **Fix:** Add logging parameters to the parameter group:
```typescript
const parameterGroup = new rds.ParameterGroup(this, `${id}-rdsParameterGroup`, {
  engine: rds.DatabaseInstanceEngine.postgres({
    version: rds.PostgresEngineVersion.VER_17_9,
  }),
  description: "Custom parameter group for LAIGO database with SSL and logging",
  parameters: {
    "rds.force_ssl": "1",
    "log_connections": "1",
    "log_disconnections": "1",
    "log_min_duration_statement": "1000", // Log queries >1 second
    "log_statement": "ddl",               // Log DDL statements
  },
});
```

---

## Low Issues

### RDS-L1. Placeholder passwords visible in CloudFormation template
- **Status:** ⬜ Open
- **File:** `cdk/lib/database-stack.ts`
- **Description:** The application user and table creator secrets are created with `SecretValue.unsafePlainText("applicationPassword")`. While these are rotated at runtime by the `db_setup` Lambda, the placeholder values appear in the synthesized CloudFormation template and CloudFormation change sets, which may be visible to users with CloudFormation read access.
- **Impact:** Low — the passwords are replaced during deployment. However, the pattern is flagged by security scanning tools and could confuse developers into thinking these are real credentials.
- **Fix:** Use `Secret.fromGenerateSecretString()` to generate random initial values that never appear in templates.

---

### RDS-L2. AWS-managed KMS key used for storage encryption
- **Status:** ⬜ Open
- **File:** `cdk/lib/database-stack.ts`
- **Description:** Storage encryption uses the default AWS-managed KMS key (`aws/rds`). This provides encryption but does not allow customer-managed key rotation policies, cross-account access controls, or key usage auditing via CloudTrail.
- **Impact:** Reduced control over encryption key lifecycle. Cannot enforce custom rotation schedules or restrict key usage to specific principals. May not meet compliance requirements that mandate customer-managed keys.
- **Fix:** Create and use a customer-managed KMS key:
```typescript
const dbEncryptionKey = new kms.Key(this, "RDSEncryptionKey", {
  alias: `${id}-rds-encryption`,
  enableKeyRotation: true,
  description: "Customer-managed key for LAIGO RDS encryption",
});

this.dbInstance = new rds.DatabaseInstance(this, `${id}-database`, {
  // ... existing config ...
  encryptionKey: dbEncryptionKey,
});
```

---

### RDS-L3. No read replicas for read-heavy workloads
- **Status:** ⬜ Open
- **File:** `cdk/lib/database-stack.ts`
- **Description:** All read and write traffic is directed to a single RDS instance. For a legal AI application where case retrieval and conversation history reads may significantly outnumber writes, read replicas could offload read traffic and improve response times.
- **Impact:** All queries compete for the same instance resources. As the application scales, read latency may increase. No ability to serve reads from a different AZ for lower latency.
- **Fix:** Consider adding a read replica for production:
```typescript
const readReplica = new rds.DatabaseInstanceReadReplica(this, `${id}-read-replica`, {
  sourceDatabaseInstance: this.dbInstance,
  instanceType: ec2.InstanceType.of(
    ec2.InstanceClass.BURSTABLE4_GRAVITON,
    ec2.InstanceSize.MEDIUM,
  ),
  vpc: vpcStack.vpc,
  vpcSubnets: { subnetType: ec2.SubnetType.PRIVATE_ISOLATED },
});
```

---

## Architectural Recommendations

### R1. Implement automated secret rotation with Secrets Manager
- **Priority:** High
- **Description:** Replace the deployment-time-only password rotation with AWS Secrets Manager's native rotation schedules. This ensures credentials are rotated on a regular cadence (e.g., every 30 days) regardless of deployment frequency. RDS Proxy handles credential pinning during rotation, so application connections are not disrupted.

### R2. Enable Multi-AZ for production environments
- **Priority:** High
- **Description:** Use CDK context to differentiate between development (single-AZ, cost-optimized) and production (Multi-AZ, HA) configurations. The additional cost (~$50-70/month for db.t4g.medium) is justified by the elimination of single-AZ failure as a complete outage scenario.

### R3. Tighten security group rules to security-group-based references
- **Priority:** High
- **Description:** Replace the VPC CIDR-based ingress rule with security group references. Create a shared "database client" security group that is attached to all Lambda functions needing database access, and allow only that security group in the RDS ingress rules. This ensures only authorized compute resources can reach the database.

### R4. Add comprehensive database observability
- **Priority:** Medium
- **Description:** Enable Performance Insights, configure `pg_stat_statements`, add CloudWatch Alarms for key metrics (CPU, storage, connections, latency), and configure connection/disconnection logging. This provides the visibility needed to proactively manage database health and diagnose issues before they impact users.

### R5. Standardize connection configuration across all Lambda modules
- **Priority:** Medium
- **Description:** The authorizer module correctly configures `max`, `idle_timeout`, and `connect_timeout`, but the handler module does not. Create a shared connection configuration module or enforce consistent settings across all Lambda functions that connect to the database. This prevents connection leaks and ensures fast failure during connectivity issues.

---

## Review Progress

- [x] CDK Infrastructure
- [x] Lambda Functions (Python)
- [x] Lambda Functions (Node.js handlers)
- [x] Database (schema & migrations)
- [x] Frontend (React application)
- [x] Security (holistic cross-cutting)
- [x] RDS (configuration, security groups, backup/recovery, encryption)
- [ ] Bedrock (model invocation, prompt engineering, error handling)
- [ ] S3 Best Practices (bucket configs, access policies, lifecycle rules)
- [ ] Well-Architected (AWS framework pillars review)
