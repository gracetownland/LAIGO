# S3 Research Notes — Code Review Deep Dive

## Overview

This document captures all S3-related findings from reading the LAIGO codebase. It serves as input for task 5.2 (producing the formal `code-review-s3-best-practices.md`).

---

## 1. CDK S3 Bucket Definitions

All S3 buckets are defined in `cdk/lib/api-stack.ts`. There are **two** S3 buckets in the project:

### 1.1 Whitelist Upload Bucket

**File:** `cdk/lib/api-stack.ts` (lines ~1350–1381)

```typescript
const whitelistUploadBucket = new s3.Bucket(
  this,
  `${id}-WhitelistUploadBucket`,
  {
    bucketName: `${id.toLowerCase()}-whitelist-uploads-${this.account}`,
    versioned: false,
    encryption: s3.BucketEncryption.S3_MANAGED,
    blockPublicAccess: s3.BlockPublicAccess.BLOCK_ALL,
    cors: [
      {
        allowedHeaders: ["*"],
        allowedMethods: [
          s3.HttpMethods.GET,
          s3.HttpMethods.PUT,
          s3.HttpMethods.HEAD,
          s3.HttpMethods.POST,
          s3.HttpMethods.DELETE,
        ],
        allowedOrigins: s3CorsAllowedOrigins,
      },
    ],
    removalPolicy: cdk.RemovalPolicy.DESTROY,
    autoDeleteObjects: true,
    lifecycleRules: [
      {
        expiration: cdk.Duration.days(1),
        id: "cleanup-old-uploads",
      },
    ],
  },
);
```

**Key observations:**
- ✅ `blockPublicAccess: BLOCK_ALL`
- ✅ `encryption: S3_MANAGED` (SSE-S3)
- ✅ Lifecycle rule: 1-day expiration (appropriate for ephemeral uploads)
- ✅ `autoDeleteObjects: true` (stack cleanup)
- ❌ **Missing `enforceSSL: true`** — unlike the audio bucket, this bucket does NOT enforce HTTPS-only access
- ❌ **Versioning disabled** (`versioned: false`) — acceptable for ephemeral data but noted
- ❌ **No server access logging** configured

### 1.2 Audio Storage Bucket

**File:** `cdk/lib/api-stack.ts` (lines ~1939–1965)

```typescript
const audioStorageBucket = new s3.Bucket(
  this,
  `${id}-audio-prompt-bucket`,
  {
    bucketName: `${id.toLowerCase()}-audio-prompt-${this.account}`,
    blockPublicAccess: s3.BlockPublicAccess.BLOCK_ALL,
    cors: [
      {
        allowedHeaders: ["*"],
        allowedMethods: [
          s3.HttpMethods.GET,
          s3.HttpMethods.PUT,
          s3.HttpMethods.HEAD,
          s3.HttpMethods.POST,
          s3.HttpMethods.DELETE,
        ],
        allowedOrigins: s3CorsAllowedOrigins,
      },
    ],
    removalPolicy: cdk.RemovalPolicy.DESTROY,
    autoDeleteObjects: true,
    enforceSSL: true,
    encryption: s3.BucketEncryption.S3_MANAGED,
  },
);
```

**Key observations:**
- ✅ `blockPublicAccess: BLOCK_ALL`
- ✅ `encryption: S3_MANAGED` (SSE-S3)
- ✅ `enforceSSL: true` — enforces HTTPS-only access via bucket policy
- ✅ `autoDeleteObjects: true` (stack cleanup)
- ❌ **No versioning** — not explicitly set (defaults to disabled)
- ❌ **No lifecycle rules** — audio files are deleted programmatically after transcription, but no fallback lifecycle rule exists for orphaned objects
- ❌ **No server access logging** configured

---

## 2. Bucket Access Policies and IAM Permissions

### 2.1 Whitelist Upload Bucket — Admin Function

**File:** `cdk/lib/api-stack.ts` (lines ~1543–1553)

```typescript
lambdaAdminFunction.addToRolePolicy(
  new iam.PolicyStatement({
    effect: iam.Effect.ALLOW,
    actions: ["s3:GetObject", "s3:PutObject", "s3:DeleteObject", "s3:ListBucket"],
    resources: [
      whitelistUploadBucket.bucketArn,
      whitelistUploadBucket.arnForObjects("*"),
    ],
  }),
);
```

**Observations:**
- ✅ Scoped to specific bucket ARN and objects
- ✅ Uses `arnForObjects("*")` for object-level actions
- ⚠️ `s3:ListBucket` is granted but may not be needed (admin only reads specific keys)

### 2.2 Audio Storage Bucket — GeneratePreSignedURL Function

**File:** `cdk/lib/api-stack.ts` (lines ~1992–2001)

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

**Observations:**
- ❌ **DUPLICATE PERMISSIONS**: `grantReadWrite()` already grants `s3:GetObject`, `s3:PutObject`, `s3:DeleteObject`, `s3:AbortMultipartUpload`, and list permissions. The explicit `addToRolePolicy` is redundant.
- ⚠️ `grantReadWrite` is overly broad for a function that only generates pre-signed PUT URLs — it doesn't need `s3:DeleteObject` or `s3:GetObject*` itself (the pre-signed URL grants temporary access to the caller).

### 2.3 Audio Storage Bucket — AudioToText Function

**File:** `cdk/lib/api-stack.ts` (lines ~2036–2065)

```typescript
audioStorageBucket.grantRead(audioToTextFunction);

// Additional explicit policies:
audioToTextFunction.addToRolePolicy(
  new iam.PolicyStatement({
    effect: iam.Effect.ALLOW,
    actions: ["s3:ListBucket"],
    resources: [audioStorageBucket.bucketArn],
  }),
);

audioToTextFunction.addToRolePolicy(
  new iam.PolicyStatement({
    effect: iam.Effect.ALLOW,
    actions: ["s3:PutObject", "s3:GetObject", "s3:DeleteObject", "s3:HeadObject"],
    resources: [`arn:aws:s3:::${audioStorageBucket.bucketName}/*`],
  }),
);
```

**Observations:**
- ❌ **DUPLICATE/CONFLICTING PERMISSIONS**: `grantRead()` already provides `s3:GetObject*` and `s3:GetBucket*`. Then explicit policies add `s3:PutObject`, `s3:DeleteObject`, `s3:HeadObject`, and `s3:ListBucket` — effectively granting full read/write/delete.
- ⚠️ The function legitimately needs read, head, and delete (validates file, reads for transcription, deletes after processing). But `s3:PutObject` is unnecessary — the function never writes to S3.
- ⚠️ Uses string interpolation for ARN (`arn:aws:s3:::${audioStorageBucket.bucketName}/*`) instead of CDK's `bucketArn` property — less portable.

---

## 3. Encryption Settings

| Bucket | Encryption | Key Management |
|--------|-----------|----------------|
| Whitelist Upload | SSE-S3 (`S3_MANAGED`) | AWS-managed keys |
| Audio Storage | SSE-S3 (`S3_MANAGED`) | AWS-managed keys |

**Observations:**
- ✅ Both buckets use server-side encryption at rest
- ⚠️ Neither bucket uses SSE-KMS — this means no key rotation control, no CloudTrail key usage logging, and no ability to restrict access via key policies. For audio files containing potentially sensitive interview content, KMS encryption would provide better audit trail.
- No client-side encryption is used anywhere in the codebase.

---

## 4. Lifecycle Rules and Intelligent Tiering

| Bucket | Lifecycle Rules | Intelligent Tiering |
|--------|----------------|---------------------|
| Whitelist Upload | ✅ 1-day expiration | ❌ None |
| Audio Storage | ❌ None | ❌ None |

**Observations:**
- ✅ Whitelist bucket has appropriate 1-day expiration for ephemeral CSV uploads
- ❌ Audio bucket has NO lifecycle rules. Files are deleted programmatically after transcription, but if the Lambda fails or times out, orphaned audio files will persist indefinitely with no cleanup mechanism.
- Neither bucket uses Intelligent Tiering (acceptable given the ephemeral nature of data).

---

## 5. Versioning and MFA Delete

| Bucket | Versioning | MFA Delete |
|--------|-----------|------------|
| Whitelist Upload | ❌ Disabled (`versioned: false`) | ❌ Not configured |
| Audio Storage | ❌ Disabled (default) | ❌ Not configured |

**Observations:**
- Both buckets store ephemeral data that is deleted after processing, so versioning is not strictly necessary.
- MFA Delete is not applicable for ephemeral data buckets.
- No compliance or regulatory requirements appear to mandate versioning for these use cases.

---

## 6. Data Protection Patterns

### 6.1 CORS Configuration

**File:** `cdk/lib/api-stack.ts` (lines ~103–107)

```typescript
const allowedOrigin = props.domainName ? `https://${props.domainName}` : "";
const s3CorsAllowedOrigins = allowedOrigin
  ? [allowedOrigin]  // Production: only the configured domain
  : ["*"];           // Development: allow all (no domain configured)
```

**Observations:**
- ✅ Production: CORS locked to specific domain
- ⚠️ Development: CORS allows all origins (`*`) — acceptable for dev but should be documented
- ⚠️ Both buckets allow ALL HTTP methods (`GET`, `PUT`, `HEAD`, `POST`, `DELETE`) in CORS — overly permissive. The whitelist bucket only needs `PUT` (upload) and the audio bucket only needs `PUT` (upload).
- ⚠️ `allowedHeaders: ["*"]` — overly permissive, should be restricted to necessary headers

### 6.2 Public Access Blocks

- ✅ Both buckets use `s3.BlockPublicAccess.BLOCK_ALL` — all four public access block settings are enabled.

### 6.3 Bucket Policies

- ✅ Audio bucket has `enforceSSL: true` which adds a bucket policy denying non-HTTPS requests
- ❌ Whitelist bucket is **missing** `enforceSSL: true` — allows HTTP access

### 6.4 Content Security Policy (CSP)

**File:** `cdk/lib/amplify-stack.ts` (lines ~38–40)

```typescript
const audioPromptBucketEndpoint = `https://${apiStack.getAudioPromptBucketName()}.s3.${this.region}.amazonaws.com`;
const whitelistUploadBucketEndpoint = `https://${apiStack.getWhitelistUploadBucketName()}.s3.${this.region}.amazonaws.com`;
connectSrc = `'self' ${apiEndpoint} ${wsUrl} ${cognitoIdpEndpoint} ${cognitoIdentityEndpoint} ${audioPromptBucketEndpoint} ${whitelistUploadBucketEndpoint}`;
```

**Observations:**
- ✅ CSP `connect-src` explicitly whitelists S3 bucket endpoints in production
- ✅ Uses path-style URLs with HTTPS

---

## 7. Pre-Signed URL Generation Patterns

### 7.1 Python Lambda — Audio File Upload (PUT)

**File:** `cdk/lambda/generatePreSignedURL/generatePreSignedURL.py`

```python
s3 = boto3.client(
    "s3",
    endpoint_url=f"https://s3.{REGION}.amazonaws.com",
    config=Config(
        s3={"addressing_style": "virtual"}, region_name=REGION, signature_version="s3v4"
    ),
)

presigned_url = s3.generate_presigned_url(
    ClientMethod="put_object",
    Params={
        "Bucket": BUCKET,
        "Key": key,
        "ContentType": content_type,
    },
    ExpiresIn=120,
    HttpMethod="PUT",
)
```

**Observations:**
- ✅ Uses SigV4 (`signature_version="s3v4"`) — required for security
- ✅ Short expiration (120 seconds / 2 minutes) — good security practice
- ✅ Validates file type against allowed audio types before generating URL
- ✅ Sets `ContentType` in pre-signed params — prevents content-type mismatch attacks
- ✅ Uses virtual-hosted style addressing
- ⚠️ No file size limit enforced at pre-signed URL level (no `Content-Length` condition). Size validation happens server-side in `audioToText` after upload.
- ⚠️ The `key` is constructed from user-provided `audio_file_id` and `file_name` — potential path traversal if not validated (though UUID format limits this risk)

### 7.2 Node.js — Whitelist CSV Upload (PUT)

**File:** `cdk/lambda/handlers/adminFunction.js` (lines ~1830–1855)

```javascript
const s3 = new S3Client();
const bucketName = process.env.WHITELIST_UPLOAD_BUCKET;
const key = `whitelist-${Date.now()}.csv`;

const cmd = new PutObjectCommand({
  Bucket: bucketName,
  Key: key,
  ContentType: "text/csv",
});

const presignedUrl = await getSignedUrl(s3, cmd, { expiresIn: 3600 });
```

**Observations:**
- ✅ Server-generated key (`whitelist-${Date.now()}.csv`) — no user-controlled path
- ✅ Sets `ContentType: "text/csv"` — restricts upload type
- ❌ **Long expiration (3600 seconds / 1 hour)** — significantly longer than the audio URL (120s). For a simple CSV upload, 5-10 minutes would be more appropriate.
- ⚠️ No `Content-Length` restriction in the pre-signed URL
- ⚠️ Uses AWS SDK v3 `@aws-sdk/client-s3` and `@aws-sdk/s3-request-presigner` (modern, good)

---

## 8. S3 Object Operations in Lambda Functions

### 8.1 AudioToText Lambda — File Validation and Cleanup

**File:** `cdk/lambda/audioToText/src/main.py`

Key S3 operations:
1. **`head_object`** — checks file size against configurable limit
2. **`get_object` (Range: bytes=0-31)** — reads magic bytes for file type validation
3. **`delete_object`** — deletes invalid files immediately after validation failure
4. **`delete_object`** — deletes audio file after successful transcription

**Observations:**
- ✅ Server-side file integrity validation (magic number checks for mp3, wav, m4a)
- ✅ Immediate cleanup of invalid/malicious files
- ✅ Post-processing cleanup of audio files
- ⚠️ Only validates mp3, wav, m4a magic numbers — other allowed types (mp4, flac, amr, ogg, webm) in the pre-signed URL Lambda are NOT validated and will be rejected as invalid
- ⚠️ If transcription fails mid-process, the audio file may not be cleaned up (exception handling doesn't guarantee deletion)

### 8.2 Admin Function — Whitelist CSV Processing

**File:** `cdk/lambda/handlers/adminFunction.js` (lines ~1877–1992)

Key S3 operations:
1. **`GetObjectCommand`** — reads uploaded CSV from S3
2. **`DeleteObjectCommand`** — deletes CSV after processing

**Observations:**
- ✅ Reads and processes CSV, then cleans up
- ⚠️ No validation of CSV file size before reading into memory (`transformToString()`) — could cause Lambda OOM with large files
- ⚠️ The `s3Key` parameter comes from the request body — potential for reading arbitrary keys if not validated (though bucket is scoped and key format is server-generated)

---

## 9. CloudFront Integration

**Finding:** S3 buckets are NOT served via CloudFront. The frontend (React app) is served via AWS Amplify (which uses CloudFront internally), but S3 bucket access is direct via pre-signed URLs.

- The WAF stack (`cdk/lib/waf-stack.ts`) creates a CloudFront-scoped WAF for the Amplify app, not for S3.
- Pre-signed URLs point directly to S3 endpoints, bypassing any CDN or WAF protection.

**Observations:**
- ⚠️ Direct S3 access via pre-signed URLs means no WAF protection on uploads/downloads
- ⚠️ No CloudFront distribution for S3 means no edge caching (acceptable for ephemeral data)
- The CSP headers in Amplify whitelist the S3 bucket endpoints directly

---

## 10. Additional Security Observations

### 10.1 No S3 Access Logging
Neither bucket has server access logging enabled. This means:
- No audit trail of who accessed what objects
- No visibility into failed access attempts
- Harder to detect unauthorized access patterns

### 10.2 No Object Lock
Neither bucket uses S3 Object Lock (acceptable for ephemeral data).

### 10.3 Removal Policy
Both buckets use `RemovalPolicy.DESTROY` with `autoDeleteObjects: true`. This means:
- Stack deletion will permanently destroy all bucket contents
- Appropriate for development but risky for production data

### 10.4 No Cross-Region Replication
No replication configured (acceptable given ephemeral nature of data).

### 10.5 Input Validation in Pre-Signed URL Lambda
The Python Lambda validates:
- `audio_file_id` is present (but doesn't validate UUID format)
- `file_name` is present (but doesn't validate for path traversal characters)
- `file_type` is in allowed list

The S3 key is constructed as: `f"{audio_file_id}/{file_name}.{file_type}"`
- If `audio_file_id` or `file_name` contain path separators or special characters, this could lead to unexpected key paths (though not a security vulnerability given bucket isolation).

---

## Summary of Key Findings for Review Document

| Category | Finding | Severity Estimate |
|----------|---------|-------------------|
| Missing enforceSSL | Whitelist bucket allows HTTP access | High |
| Duplicate IAM permissions | generatePreSignedURL has redundant grants | Medium |
| Overly broad IAM | generatePreSignedURL gets full read/write but only needs put_object signing | Medium |
| Unnecessary s3:PutObject | audioToText function granted PutObject but never writes | Low |
| Long pre-signed URL expiry | Whitelist CSV URL valid for 1 hour | Medium |
| No lifecycle rule on audio bucket | Orphaned files persist indefinitely | Medium |
| No S3 access logging | No audit trail for either bucket | Medium |
| Overly permissive CORS methods | All HTTP methods allowed on both buckets | Low |
| Inconsistent file type validation | Pre-signed URL allows 8 types, server validates only 3 | Medium |
| No file size limit in pre-signed URL | Size only checked server-side after upload | Low |
| No KMS encryption | SSE-S3 provides less audit/control than SSE-KMS | Low |
| RemovalPolicy.DESTROY in production | Stack deletion destroys all data | Medium |
