# RDS Deep-Dive Research Notes

> **Purpose:** This document captures raw findings from reading all RDS-related code in the LAIGO codebase. It serves as input for task 3.2 (producing the formal `code-review-rds.md`).

---

## 1. CDK RDS Construct Definitions

### File: `cdk/lib/database-stack.ts`

**RDS Instance Configuration:**
- Engine: PostgreSQL 17.9
- Instance type: `db.t4g.medium` (BURSTABLE4_GRAVITON, ARM-based)
- Storage: 100 GB allocated, 150 GB max auto-scaling
- Multi-AZ: **Disabled** (`multiAz: false`)
- Publicly accessible: **No**
- Deletion protection: **Enabled**
- Auto minor version upgrade: **Enabled**
- Major version upgrade: **Disabled**
- Database name: `laigo`

**RDS Proxy:**
- Created via `dbInstance.addProxy()`
- Secrets: Application user, Table creator, Admin credentials
- `requireTLS: true` — enforces TLS for proxy connections
- Uses same security groups as the database instance
- Dedicated IAM role with `rds-db:connect` permission
- Target group name manually overridden to "default" (CDK workaround)

**Credentials Management:**
- Admin secret: Imported from existing Secrets Manager secret (`LAIGOSecrets` → `{id}-LAIGO/credentials/rdsDbCredential`)
- Application user secret: Created with placeholder values (`applicationUsername`/`applicationPassword`), updated at runtime by db_setup Lambda
- Table creator secret: Same pattern as application user secret
- Both user secrets have `RemovalPolicy.DESTROY`

**Notable Observations:**
- Admin credentials are sourced from a pre-existing secret (`LAIGOSecrets`) using `fromSecretNameV2`
- The `credentials` field uses `rds.Credentials.fromUsername()` with `unsafeUnwrap()` to extract the username from the imported secret
- No automatic secret rotation is configured via AWS Secrets Manager rotation schedules
- Password rotation is handled manually by the `db_setup` Lambda (generates random passwords with `crypto.randomBytes(16)`)

---

## 2. Security Group Configurations

### File: `cdk/lib/database-stack.ts`

**Ingress Rules:**
1. If existing VPC with private subnet CIDRs: Each private subnet CIDR gets a rule allowing TCP 5432
2. Entire VPC CIDR range: Allows TCP 5432 from `vpcStack.vpcCidrString`

**Observations:**
- The VPC-wide CIDR rule (`vpcStack.vpcCidrString`) is broad — it allows any resource in the VPC to connect to the database on port 5432
- When private subnet CIDRs are provided (existing VPC path), they are added individually, but the VPC-wide rule is ALSO added unconditionally
- This means in the existing VPC path, there are redundant rules (private subnet CIDRs + full VPC CIDR)
- No explicit egress rules are defined (CDK defaults allow all outbound)
- RDS Proxy reuses the same security groups as the database instance

---

## 3. Parameter Group Settings

### File: `cdk/lib/database-stack.ts`

**Custom Parameter Group:**
- Engine: PostgreSQL 17.9
- Parameters:
  - `rds.force_ssl`: `"1"` — **SSL is enforced at the database level**
- Description: "Custom parameter group for LAIGO database with SSL enforcement"

**Observations:**
- Only one parameter is customized (`rds.force_ssl`)
- No performance-related parameters are tuned (e.g., `shared_buffers`, `work_mem`, `max_connections`, `effective_cache_size`)
- No logging parameters configured (e.g., `log_min_duration_statement`, `log_connections`, `log_disconnections`)
- No `pg_stat_statements` extension enabled for query performance monitoring

---

## 4. Backup/Recovery Configurations

### File: `cdk/lib/database-stack.ts`

**Settings:**
- `backupRetention`: 7 days
- `deleteAutomatedBackups`: true (backups deleted when instance is deleted)
- `deletionProtection`: true
- `multiAz`: false (no automatic failover)
- `allowMajorVersionUpgrade`: false
- `autoMinorVersionUpgrade`: true

**Observations:**
- 7-day backup retention is the minimum recommended for production
- No point-in-time recovery (PITR) configuration is explicitly mentioned (though it's enabled by default with backups)
- `deleteAutomatedBackups: true` means if the instance is deleted (despite deletion protection), all automated backups are lost
- No cross-region backup replication
- No manual snapshot strategy documented
- Single-AZ deployment means no automatic failover during AZ outages
- No read replicas configured

---

## 5. Encryption Settings

### At-Rest Encryption
- `storageEncrypted: true` — enabled using AWS-managed KMS key (default)
- No custom KMS key specified

### In-Transit Encryption
- **Database level:** `rds.force_ssl: "1"` in parameter group forces all connections to use SSL
- **RDS Proxy level:** `requireTLS: true` enforces TLS between clients and proxy
- **db_setup Lambda:** Uses `sslmode=verify-full` with explicit CA certificate validation (`global-bundle.pem`)
- **Node.js handlers (via RDS Proxy):** Use `ssl: "require"` (validates server certificate via RDS Proxy's TLS)
- **Python Lambdas (via RDS Proxy):** Use `sslmode="require"` (validates server certificate via RDS Proxy's TLS)
- **Authorizer Lambdas:** Use `ssl: "require"` with connection via RDS Proxy

**Observations:**
- Encryption at rest uses AWS-managed key (no customer-managed KMS key for additional control)
- The db_setup Lambda uses the strongest SSL mode (`verify-full`) with explicit CA cert — this is the gold standard
- All other Lambdas use `ssl: "require"` / `sslmode="require"` which encrypts traffic but does NOT verify the server's certificate identity
  - This is acceptable when connecting through RDS Proxy (AWS manages the TLS termination)
  - RDS Proxy handles certificate validation on the backend connection to the database
- The RDS CA certificate bundle is deployed as a Lambda layer (`rds-ca-bundle`) for the db_setup Lambda
- `NODE_EXTRA_CA_CERTS` environment variable is set to `/opt/rds-ca/global-bundle.pem` for the db_setup Lambda

---

## 6. Connection Management Patterns

### 6.1 Node.js Handlers (`cdk/lambda/handlers/initializeConnection.js`)

**Pattern:**
- Retrieves credentials from Secrets Manager
- Creates a `postgres` (postgres.js library) connection with `ssl: "require"`
- Stores connection in `global.sqlConnection` for Lambda execution context reuse
- Connection test: `SELECT 1` after creation
- No explicit `max` connections setting (defaults to library default)
- No `idle_timeout` or `connect_timeout` configured

**Connection Reuse:**
- `utils.js` wraps `initializeConnection` with a staleness check (`SELECT 1`)
- If stale, nullifies global connection and reinitializes

### 6.2 Node.js Authorizers (`cdk/lambda/authorization/initializeConnection.js`)

**Pattern:**
- Same Secrets Manager retrieval pattern
- Creates `postgres` connection with:
  - `ssl: "require"`
  - `max: 1` (single connection per Lambda instance)
  - `idle_timeout: 20` seconds
  - `connect_timeout: 10` seconds
- Stores in `global.sqlConnection` for reuse
- Uses structured logging via Powertools

### 6.3 Python Lambdas (text_generation, case_generation, summary_generation, assess_progress, audioToText)

**Pattern:**
- All use `psycopg` (psycopg3) library
- Retrieve credentials from Secrets Manager (cached in global `db_secret`)
- Connect with `sslmode="require"` via RDS Proxy endpoint
- Store connection in global `connection` variable
- Staleness check: `SELECT 1` before reuse, reconnect if stale
- No connection pooling within the Lambda (single connection per instance)
- No explicit timeout configuration

**assess_progress Lambda has enhanced error handling:**
- Catches `psycopg.OperationalError` specifically
- Logs SSL-specific errors with diagnostic information
- Checks for 'SSL' or 'certificate' in error messages

### 6.4 db_setup Lambda (`cdk/lambda/db_setup/index.js`)

**Pattern:**
- Uses `pg` (node-postgres) `Client` class (not `postgres.js`)
- Connects with `ssl: { rejectUnauthorized: true, ca: rdsCaCert.toString() }` — full certificate validation
- Uses connection URL with `sslmode=verify-full` for migrations
- Directly connects to RDS instance (NOT through RDS Proxy) — uses admin credentials
- Creates application users with random passwords and updates Secrets Manager

### 6.5 Cognito Post-Confirmation Lambda (`addStudentOnSignUp.js`)

**Pattern:**
- Uses shared `initializeConnection` from authorization module
- Passes `SM_DB_CREDENTIALS` and `RDS_PROXY_ENDPOINT` as parameters
- Connects via RDS Proxy with `ssl: "require"`
- Uses `postgres.js` tagged template literals for queries

---

## 7. RDS Proxy Configuration

### File: `cdk/lib/database-stack.ts`

**Configuration:**
- Attached to the database instance via `dbInstance.addProxy()`
- Secrets registered: Admin, Application User, Table Creator
- VPC: Same as database
- Security groups: Same as database instance
- `requireTLS: true`
- IAM role: Dedicated role with `rds-db:connect` on `*` resources

**Usage:**
- All Lambda functions (except db_setup) connect through the RDS Proxy
- Proxy endpoint stored in `DatabaseStack.rdsProxyEndpoint` and passed as environment variable
- Provides connection pooling, credential management, and TLS termination

**Observations:**
- The proxy IAM role has `rds-db:connect` on `*` (all resources) — could be scoped to specific DB resource ARN
- No idle client timeout configured on the proxy (uses defaults)
- No max connections percentage configured (uses default 100%)
- No connection borrow timeout configured
- Target group name requires manual override (CDK bug workaround)

---

## 8. VPC Network Configuration (RDS-relevant)

### File: `cdk/lib/vpc-stack.ts`

**New VPC Path:**
- CIDR: `10.0.0.0/16` (configurable via context)
- 2 AZs maximum
- Subnet types: Public, Private with Egress, Private Isolated
- RDS deployed in `PRIVATE_ISOLATED` subnets
- VPC endpoints: Secrets Manager, RDS (in isolated subnets)
- VPC Flow Logs enabled

**Existing VPC Path:**
- Uses imported VPC attributes from Control Tower
- 3 AZs with private subnets
- VPC endpoints: SSM, Secrets Manager, RDS (in isolated subnets, `privateDnsEnabled: false`)
- VPC Flow Logs enabled

**Observations:**
- RDS is correctly placed in isolated subnets (no internet access)
- VPC endpoints for Secrets Manager ensure Lambda can retrieve credentials without internet
- RDS VPC endpoint allows management API calls without internet
- `privateDnsEnabled: false` on endpoints in existing VPC path may require explicit endpoint URLs

---

## 9. IAM Permissions for RDS Access

### Database Stack:
- RDS service-linked role created via custom resource
- RDS Proxy role: `rds-db:connect` on `*`
- `grantConnect()` called for authorizer functions

### API Stack:
- Each Lambda role gets `grantRead` on the appropriate secret (User or TableCreator)
- Authorizer roles: VPC access + secret read
- Handler roles: VPC access + secret read
- db_setup role: Read/write on all three secrets + VPC access

### DBFlow Stack:
- Lambda role: Read on admin secret, read/write on user and table creator secrets
- VPC access permissions (CreateNetworkInterface, etc.)
- SSM read-only access

---

## 10. Monitoring and Observability

**Enhanced Monitoring:**
- `monitoringInterval: Duration.seconds(60)` — Enhanced Monitoring enabled at 60-second granularity

**CloudWatch Logs:**
- `cloudwatchLogsRetention: logs.RetentionDays.THREE_MONTHS` — PostgreSQL logs retained for 3 months

**Observations:**
- No Performance Insights enabled
- No CloudWatch Alarms configured for RDS metrics (CPU, connections, storage, replication lag)
- No custom CloudWatch dashboard for database metrics
- Enhanced Monitoring provides OS-level metrics but no application-level query insights

---

## 11. Summary of Key Findings for Review Document

### Positive Patterns:
1. RDS Proxy for connection pooling — excellent for Lambda workloads
2. SSL/TLS enforced at multiple levels (parameter group, proxy, application)
3. Database in isolated subnets with no public access
4. Deletion protection enabled
5. Storage encryption at rest enabled
6. VPC endpoints for Secrets Manager (avoids internet for credential retrieval)
7. Separate database users with least-privilege roles (readwrite vs tablecreator)
8. db_setup Lambda uses `verify-full` SSL mode with explicit CA certificate
9. VPC Flow Logs enabled for network monitoring
10. Enhanced Monitoring enabled

### Potential Issues:
1. **Multi-AZ disabled** — no automatic failover, single point of failure
2. **No automatic secret rotation** — passwords rotated only when db_setup Lambda runs (deployment-time only)
3. **VPC-wide security group rule** — allows any resource in VPC to connect on port 5432
4. **No Performance Insights** — limited query-level visibility
5. **No CloudWatch Alarms** — no automated alerting on database health
6. **Handler connection module lacks timeouts** — `initializeConnection.js` in handlers has no `max`, `idle_timeout`, or `connect_timeout`
7. **7-day backup retention** — minimum recommended; may be insufficient for compliance
8. **`deleteAutomatedBackups: true`** — backups lost if instance deleted
9. **No cross-region backup** — no disaster recovery for region-level failures
10. **RDS Proxy IAM role uses `*` resource** — could be scoped to specific DB ARN
11. **No `pg_stat_statements`** — no query performance tracking
12. **No logging parameters** — no slow query logging configured
13. **AWS-managed KMS key** — no customer-managed key for encryption at rest
14. **Placeholder passwords in secrets** — `SecretValue.unsafePlainText("applicationPassword")` visible in CloudFormation template (though rotated at runtime)
15. **No read replicas** — all read/write traffic hits single instance
