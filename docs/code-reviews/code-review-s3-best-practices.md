# Code Review: S3 Best Practices

**Reviewer:** Kiro  
**Date:** 2025-07-14  
**Scope:** S3 bucket configurations, access policies, encryption, lifecycle rules, versioning, data protection (`cdk/lib/api-stack.ts`, `cdk/lambda/generatePreSignedURL/`, `cdk/lambda/audioToText/`, `cdk/lambda/handlers/adminFunction.js`, `cdk/lib/amplify-stack.ts`)  
**Status:** Complete (remediation tracked in [`REMEDIATION-STATUS.md`](REMEDIATION-STATUS.md))

---

## Summary

| Severity | Count | Fixed |
|----------|-------|-------|
| Critical | 0     | 0     |
| High     | 3     | 1     |
| Medium   | 5     | 0     |
| Low      | 4     | 0     |
| **Total**| **12**| **1** |

---

## What's Well-Designed

**Public access fully blocked on all buckets.** Both the whitelist upload bucket and the audio storage bucket use `s3.BlockPublicAccess.BLOCK_ALL`, which enables all four public access block settings. This is the strongest protection against accidental public exposure.

**Audio bucket enforces HTTPS-only access.** The `enforceSSL: true` setting on the audio storage bucket adds a bucket policy that denies any request made over plain HTTP, protecting audio content in transit.

**Pre-signed URL generation uses SigV4 with short expiration.** The Python Lambda generating audio upload URLs uses `signature_version="s3v4"` and a 120-second expiration window — both security best practices that limit the attack surface of pre-signed URLs.

**Server-side file integrity validation.** The `audioToText` Lambda validates uploaded files by reading magic bytes (first 32 bytes) to confirm the file type matches the declared content type before processing. Invalid files are immediately deleted.

**Ephemeral upload bucket has appropriate lifecycle rules.** The whitelist upload bucket has a 1-day expiration lifecycle rule, ensuring temporary CSV uploads are automatically cleaned up regardless of whether the processing Lambda succeeds.

**CSP headers whitelist specific S3 endpoints.** The Amplify stack's Content Security Policy `connect-src` directive explicitly lists the S3 bucket endpoints, preventing the frontend from making requests to unauthorized S3 locations.

---

## High Issues

### S3-H1. Whitelist upload bucket missing `enforceSSL` — allows unencrypted HTTP access
- **Status:** ✅ Fixed
- **File:** `cdk/lib/api-stack.ts`
- **Description:** The whitelist upload bucket does not set `enforceSSL: true`, unlike the audio storage bucket. This means the bucket accepts requests over plain HTTP, allowing data to be transmitted without TLS encryption. The bucket stores CSV files containing user whitelist data (email addresses, roles). Note: The bucket already has `BLOCK_ALL` public access and all SDK/CLI access uses HTTPS by default, so exploitation requires a non-standard access path.
- **Impact:** A defense-in-depth gap. An attacker performing a network-level interception (MITM) could theoretically read or modify whitelist CSV uploads if a non-HTTPS access path is used. In practice, all standard AWS SDK and CLI access uses HTTPS by default.
- **Fix:**

❌ Current configuration (missing enforceSSL):
```typescript
const whitelistUploadBucket = new s3.Bucket(
  this,
  `${id}-WhitelistUploadBucket`,
  {
    bucketName: `${id.toLowerCase()}-whitelist-uploads-${this.account}`,
    versioned: false,
    encryption: s3.BucketEncryption.S3_MANAGED,
    blockPublicAccess: s3.BlockPublicAccess.BLOCK_ALL,
    cors: [/* ... */],
    removalPolicy: cdk.RemovalPolicy.DESTROY,
    autoDeleteObjects: true,
    lifecycleRules: [
      { expiration: cdk.Duration.days(1), id: "cleanup-old-uploads" },
    ],
  },
);
```

✅ Fixed configuration:
```typescript
const whitelistUploadBucket = new s3.Bucket(
  this,
  `${id}-WhitelistUploadBucket`,
  {
    bucketName: `${id.toLowerCase()}-whitelist-uploads-${this.account}`,
    versioned: false,
    encryption: s3.BucketEncryption.S3_MANAGED,
    blockPublicAccess: s3.BlockPublicAccess.BLOCK_ALL,
    enforceSSL: true, // Deny HTTP requests via bucket policy
    cors: [/* ... */],
    removalPolicy: cdk.RemovalPolicy.DESTROY,
    autoDeleteObjects: true,
    lifecycleRules: [
      { expiration: cdk.Duration.days(1), id: "cleanup-old-uploads" },
    ],
  },
);
```

---

## High Issues

### S3-H2. Pre-signed URL for whitelist CSV upload has excessive 1-hour expiration
- **Status:** ⬜ Open
- **File:** `cdk/lambda/handlers/adminFunction.js`
- **Description:** The whitelist CSV upload pre-signed URL is generated with a 3600-second (1 hour) expiration. By contrast, the audio upload URL uses a 120-second (2 minute) expiration. A CSV upload is a single small file operation that should complete in seconds — a 1-hour window is unnecessarily long.
- **Impact:** If a pre-signed URL is leaked (via logs, browser history, or shared links), it remains valid for a full hour. An attacker could use the leaked URL to upload arbitrary CSV content to the whitelist bucket, potentially injecting unauthorized users into the system.
- **Fix:**

❌ Current code (1-hour expiration):
```javascript
const presignedUrl = await getSignedUrl(s3, cmd, { expiresIn: 3600 });
```

✅ Fixed code (5-minute expiration):
```javascript
const presignedUrl = await getSignedUrl(s3, cmd, { expiresIn: 300 });
```

---

### S3-H3. Duplicate and overly broad IAM permissions on `generatePreSignedURL` Lambda
- **Status:** ⬜ Open
- **File:** `cdk/lib/api-stack.ts`
- **Description:** The `generatePreSignedURL` Lambda receives permissions via two mechanisms: `audioStorageBucket.grantReadWrite(generatePreSignedURL)` (which grants `s3:GetObject*`, `s3:PutObject`, `s3:DeleteObject*`, `s3:Abort*`, and list permissions) AND an explicit `addToRolePolicy` granting `s3:PutObject` and `s3:GetObject`. The function only generates pre-signed PUT URLs — it never reads, deletes, or lists objects itself.
- **Impact:** Violates least-privilege principle. If this Lambda is compromised, the attacker gains full read/write/delete access to the audio storage bucket instead of only the ability to sign PUT requests. The redundant policy statements also make IAM auditing harder.
- **Fix:**

❌ Current code (overly broad + duplicate):
```typescript
audioStorageBucket.grantReadWrite(generatePreSignedURL);
generatePreSignedURL.addToRolePolicy(
  new iam.PolicyStatement({
    actions: ["s3:PutObject", "s3:GetObject"],
    resources: [
      audioStorageBucket.bucketArn,
      `${audioStorageBucket.bucketArn}/*`,
    ],
  }),
);
```

✅ Fixed code (minimal permissions for pre-signed URL signing):
```typescript
generatePreSignedURL.addToRolePolicy(
  new iam.PolicyStatement({
    effect: iam.Effect.ALLOW,
    actions: ["s3:PutObject"],
    resources: [`${audioStorageBucket.bucketArn}/*`],
  }),
);
```

---

## Medium Issues

### S3-M1. Audio storage bucket has no lifecycle rule for orphaned objects
- **Status:** ⬜ Open
- **File:** `cdk/lib/api-stack.ts`
- **Description:** The audio storage bucket has no lifecycle rules configured. Audio files are deleted programmatically by the `audioToText` Lambda after successful transcription, but if the Lambda fails, times out, or encounters an unhandled exception mid-processing, the audio file remains in the bucket indefinitely with no cleanup mechanism.
- **Impact:** Orphaned audio files accumulate over time, increasing storage costs and retaining potentially sensitive interview recordings longer than necessary. There is no visibility into how many orphaned files exist.
- **Fix:** Add a safety-net lifecycle rule that expires objects older than a reasonable processing window:
```typescript
const audioStorageBucket = new s3.Bucket(this, `${id}-audio-prompt-bucket`, {
  // ... existing config ...
  lifecycleRules: [
    {
      id: "cleanup-orphaned-audio",
      expiration: cdk.Duration.days(7), // Safety net: audio should be processed within minutes
    },
  ],
});
```

---

### S3-M2. `audioToText` Lambda granted unnecessary `s3:PutObject` permission
- **Status:** ⬜ Open
- **File:** `cdk/lib/api-stack.ts`
- **Description:** The `audioToText` Lambda is granted `s3:PutObject` via an explicit policy statement, but the function never writes objects to S3 — it only reads audio files (`GetObject`, `HeadObject`) and deletes them after transcription (`DeleteObject`). Additionally, `grantRead()` is called first, then a separate policy adds `PutObject`, `GetObject`, `DeleteObject`, and `HeadObject` — creating redundant and overly broad permissions.
- **Impact:** Violates least-privilege. If the Lambda is compromised, an attacker could write arbitrary content to the audio bucket. The redundant grants also make IAM policy auditing more difficult.
- **Fix:** Replace the overlapping grants with a single minimal policy:
```typescript
audioToTextFunction.addToRolePolicy(
  new iam.PolicyStatement({
    effect: iam.Effect.ALLOW,
    actions: ["s3:GetObject", "s3:HeadObject", "s3:DeleteObject"],
    resources: [audioStorageBucket.arnForObjects("*")],
  }),
);
audioToTextFunction.addToRolePolicy(
  new iam.PolicyStatement({
    effect: iam.Effect.ALLOW,
    actions: ["s3:ListBucket"],
    resources: [audioStorageBucket.bucketArn],
  }),
);
```

---

### S3-M3. Inconsistent file type validation between pre-signed URL and processing Lambdas
- **Status:** ⬜ Open
- **File:** `cdk/lambda/generatePreSignedURL/generatePreSignedURL.py`, `cdk/lambda/audioToText/src/main.py`
- **Description:** The pre-signed URL Lambda allows 8 audio file types (mp3, wav, m4a, mp4, flac, amr, ogg, webm) when generating upload URLs. However, the `audioToText` Lambda only validates magic bytes for 3 types (mp3, wav, m4a). Files uploaded as mp4, flac, amr, ogg, or webm will pass the pre-signed URL check but be rejected as "invalid" by the processing Lambda and deleted.
- **Impact:** Users can successfully upload files in 5 of the 8 "allowed" formats only to have them silently rejected during processing. This creates a confusing user experience and wastes bandwidth. The mismatch also means the magic-byte validation provides incomplete coverage.
- **Fix:** Align the allowed types between both Lambdas. Either add magic-byte validation for all 8 types in `audioToText`, or restrict the pre-signed URL Lambda to only the 3 types that are actually validated and processed.

---

### S3-M4. No S3 server access logging on either bucket
- **Status:** ⬜ Open
- **File:** `cdk/lib/api-stack.ts`
- **Description:** Neither the whitelist upload bucket nor the audio storage bucket has server access logging enabled. There is no audit trail of who accessed which objects, when, or whether access attempts failed.
- **Impact:** Without access logs, it is impossible to detect unauthorized access patterns, investigate security incidents involving S3 data, or satisfy compliance audit requirements. Failed access attempts (potential probing) are invisible.
- **Fix:** Create a dedicated logging bucket and enable server access logging:
```typescript
const s3AccessLogsBucket = new s3.Bucket(this, `${id}-s3-access-logs`, {
  encryption: s3.BucketEncryption.S3_MANAGED,
  blockPublicAccess: s3.BlockPublicAccess.BLOCK_ALL,
  enforceSSL: true,
  lifecycleRules: [{ expiration: cdk.Duration.days(90) }],
});

// Add to each bucket:
const audioStorageBucket = new s3.Bucket(this, `${id}-audio-prompt-bucket`, {
  // ... existing config ...
  serverAccessLogsBucket: s3AccessLogsBucket,
  serverAccessLogsPrefix: "audio-bucket/",
});
```

---

### S3-M5. `RemovalPolicy.DESTROY` with `autoDeleteObjects` on both buckets
- **Status:** ⬜ Open
- **File:** `cdk/lib/api-stack.ts`
- **Description:** Both S3 buckets use `removalPolicy: cdk.RemovalPolicy.DESTROY` with `autoDeleteObjects: true`. This means a `cdk destroy` command will permanently delete all bucket contents without any confirmation or recovery option. While appropriate for development environments, this is dangerous for production deployments where accidental stack deletion could destroy active data.
- **Impact:** Accidental or malicious stack deletion permanently destroys all uploaded whitelist CSVs and audio files. There is no recovery mechanism since versioning is disabled and no cross-region replication exists.
- **Fix:** Use environment-aware removal policies:
```typescript
const removalPolicy = isProduction
  ? cdk.RemovalPolicy.RETAIN
  : cdk.RemovalPolicy.DESTROY;

const autoDeleteObjects = !isProduction;
```

---

## Low Issues

### S3-L1. Overly permissive CORS HTTP methods on both buckets
- **Status:** ⬜ Open
- **File:** `cdk/lib/api-stack.ts`
- **Description:** Both buckets allow all HTTP methods in their CORS configuration (`GET`, `PUT`, `HEAD`, `POST`, `DELETE`). The whitelist bucket only needs `PUT` (for upload via pre-signed URL) and the audio bucket only needs `PUT` (upload) and `GET` (download for transcription, though this happens server-side).
- **Impact:** Minimal direct security impact since CORS only affects browser-based requests and the buckets have proper IAM policies. However, overly permissive CORS is a defense-in-depth gap and may trigger findings in security scanning tools.
- **Fix:** Restrict CORS methods to only what the frontend actually needs:
```typescript
// Whitelist bucket: frontend only uploads
allowedMethods: [s3.HttpMethods.PUT, s3.HttpMethods.HEAD],

// Audio bucket: frontend uploads and potentially downloads
allowedMethods: [s3.HttpMethods.GET, s3.HttpMethods.PUT, s3.HttpMethods.HEAD],
```

---

### S3-L2. `allowedHeaders: ["*"]` in CORS configuration
- **Status:** ⬜ Open
- **File:** `cdk/lib/api-stack.ts`
- **Description:** Both buckets use `allowedHeaders: ["*"]` in their CORS configuration, which permits any request header in cross-origin requests. The frontend likely only needs `Content-Type`, `Authorization`, and a few standard headers.
- **Impact:** Minimal direct security impact. Overly permissive allowed headers could theoretically be exploited in combination with other vulnerabilities but is primarily a defense-in-depth concern.
- **Fix:** Restrict to necessary headers:
```typescript
allowedHeaders: ["Content-Type", "Content-Length", "x-amz-*"],
```

---

### S3-L3. SSE-S3 encryption provides limited audit capability compared to SSE-KMS
- **Status:** ⬜ Open
- **File:** `cdk/lib/api-stack.ts`
- **Description:** Both buckets use `s3.BucketEncryption.S3_MANAGED` (SSE-S3). While this provides encryption at rest, it offers no key rotation control, no CloudTrail logging of key usage, and no ability to restrict access via KMS key policies. For audio files containing potentially sensitive interview content, KMS encryption would provide a better audit trail.
- **Impact:** No visibility into encryption key usage patterns. Cannot enforce separation of duties via key policies. Acceptable for ephemeral data but noted as a gap for sensitive content.
- **Fix:** For the audio bucket (which stores sensitive content), consider upgrading to KMS:
```typescript
encryption: s3.BucketEncryption.KMS_MANAGED,
// Or with a custom key for fine-grained control:
// encryptionKey: new kms.Key(this, 'AudioBucketKey', { enableKeyRotation: true }),
```

---

### S3-L4. ARN string interpolation instead of CDK construct methods in `audioToText` policy
- **Status:** ⬜ Open
- **File:** `cdk/lib/api-stack.ts`
- **Description:** The IAM policy for the `audioToText` function uses string interpolation to construct the S3 ARN:
```typescript
resources: [`arn:aws:s3:::${audioStorageBucket.bucketName}/*`]
```
Instead of using CDK's type-safe construct methods like `audioStorageBucket.arnForObjects("*")` or `audioStorageBucket.bucketArn`. This is less portable across partitions (e.g., GovCloud, China regions where the ARN format differs).
- **Impact:** Code will break if deployed to non-standard AWS partitions. Minor maintainability concern — CDK construct methods are the idiomatic approach.
- **Fix:** Use CDK construct methods:
```typescript
resources: [audioStorageBucket.arnForObjects("*")]
```

---

## Architectural Recommendations

### R1. Standardize S3 security baseline across all buckets
- **Priority:** High
- **Description:** Create a shared S3 bucket configuration factory or CDK construct that enforces the security baseline for all buckets: `enforceSSL: true`, `blockPublicAccess: BLOCK_ALL`, encryption, and server access logging. This prevents configuration drift where one bucket gets a security setting and another doesn't (as seen with `enforceSSL`).
- **Approach:** Create a `SecureBucket` construct that wraps `s3.Bucket` with mandatory security defaults, only allowing callers to override non-security properties.

### R2. Implement environment-aware bucket policies
- **Priority:** High
- **Description:** Bucket removal policies, CORS origins, and lifecycle rules should vary by environment. Production buckets should use `RETAIN` removal policy, strict CORS, and longer lifecycle retention. Development buckets can use `DESTROY` and permissive CORS.
- **Approach:** Use CDK context or a configuration object to drive environment-specific bucket settings.

### R3. Consolidate and audit IAM permissions for S3 access
- **Priority:** Medium
- **Description:** The current IAM permission model has redundant grants (both CDK helper methods and explicit policies), overly broad permissions, and unnecessary actions. Conduct a permission audit and consolidate to a single, minimal grant per Lambda function.
- **Approach:** For each Lambda, document the exact S3 operations it performs, then create a single `PolicyStatement` with only those actions. Remove all `grantReadWrite`/`grantRead` calls that overlap with explicit policies.

### R4. Add pre-signed URL content-length restrictions
- **Priority:** Medium
- **Description:** Neither pre-signed URL generation includes a `Content-Length` condition. This means a valid pre-signed URL can be used to upload files of any size, limited only by S3's 5GB single-PUT maximum. Adding content-length conditions at the pre-signed URL level provides defense-in-depth alongside the server-side size validation.
- **Approach:** Add `Conditions` to the pre-signed URL parameters:
```python
Params={
    "Bucket": BUCKET,
    "Key": key,
    "ContentType": content_type,
},
Conditions=[["content-length-range", 1, MAX_FILE_SIZE_BYTES]],
```

---

## Review Progress

- [x] CDK Infrastructure
- [x] Lambda Functions (Python)
- [x] Lambda Functions (Node.js handlers)
- [x] Database (schema & migrations)
- [x] Frontend (React application)
- [x] Security (holistic cross-cutting)
- [ ] RDS (configuration, security groups, backup/recovery, encryption)
- [ ] Bedrock (model invocation, prompt engineering, error handling)
- [x] S3 Best Practices (bucket configs, access policies, lifecycle rules)
- [ ] Well-Architected (AWS framework pillars review)
