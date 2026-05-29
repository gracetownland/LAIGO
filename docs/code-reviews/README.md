# Code Reviews

Security and quality reviews for LAIGO (May 2026).

## Status Legend

| Indicator | Meaning |
|-----------|---------|
| ✅ Complete | Review finished, document available |
| 🔄 In Progress | Review currently being conducted |
| 📋 Planned | Review scheduled, not yet started |

## Review Documents

| Document | Scope | Status |
|----------|-------|--------|
| [CDK Infrastructure](code-review-cdk-infrastructure.md) | `cdk/lib/`, `cdk/bin/` | ✅ Complete |
| [Lambda Functions (Python)](code-review-lambda-functions.md) | `cdk/lambda/*/src/` (Python files) | ✅ Complete |
| [Lambda Functions (Node.js)](code-review-nodejs-handlers.md) | `cdk/lambda/*/src/` (JS files), authorizers | ✅ Complete |
| [Database](code-review-database.md) | `cdk/lambda/dbSetup/`, migrations | ✅ Complete |
| [Frontend](code-review-frontend.md) | `frontend/` (React application) | ✅ Complete |
| [Security](code-review-security.md) | Cross-cutting (all areas, security lens) | ✅ Complete |
| [RDS](code-review-rds.md) | RDS configuration, security groups, parameter groups, backup/recovery, encryption, connection management | ✅ Complete |
| [Bedrock](code-review-bedrock.md) | Model invocation patterns, prompt engineering, token management, error handling, cost optimization | ✅ Complete |
| [S3 Best Practices](code-review-s3-best-practices.md) | Bucket configurations, access policies, encryption, lifecycle rules, versioning, data protection | ✅ Complete |
| [Well-Architected](code-review-well-architected.md) | Cross-cutting review against AWS Well-Architected Framework pillars | ✅ Complete |

## Remediation Tracking

| Document | Description |
|----------|-------------|
| [REMEDIATION-STATUS.md](REMEDIATION-STATUS.md) | Master tracker — aggregated fix status across all reviews |
| [CROSS-TOPIC-SUMMARY.md](CROSS-TOPIC-SUMMARY.md) | Cross-topic analysis — systemic patterns, aggregate statistics, and top priorities |

## Review Progress

| Metric | Value |
|--------|-------|
| Total topics | 10 |
| Complete | 10 |
| In Progress | 0 |
| Planned | 0 |
| Overall completion | 100% |

**Finding Status Legend:** ✅ Fixed · ⚠️ Partial · ⏸ Deferred · ⬜ Open

---

## Completed Reviews — Topic Descriptions

All 10 topic reviews have been completed. Below are descriptions of each topic area for reference:

### RDS (`code-review-rds.md`)

RDS configuration, security groups, parameter groups, backup/recovery, encryption, and connection management. This review examines how the application provisions and connects to its relational database, including SSL/TLS enforcement, secret rotation, and connection pooling patterns.

### Bedrock (`code-review-bedrock.md`)

Model invocation patterns, prompt engineering, token management, error handling, and cost optimization. This review covers how the application interacts with Amazon Bedrock, including system prompt design, context window handling, throttling resilience, and model selection.

### S3 Best Practices (`code-review-s3-best-practices.md`)

Bucket configurations, access policies, encryption, lifecycle rules, versioning, and data protection. This review evaluates S3 usage patterns including pre-signed URL generation, public access blocks, CORS configuration, and data retention policies.

### Well-Architected (`code-review-well-architected.md`)

Cross-cutting review against the six AWS Well-Architected Framework pillars:
- **Operational Excellence** — IaC practices, deployment automation, monitoring/logging
- **Security** — IAM least privilege, encryption, network controls, secrets management
- **Reliability** — Fault tolerance, auto-scaling, backup/recovery, multi-AZ
- **Performance Efficiency** — Compute selection, caching, database optimization
- **Cost Optimization** — Right-sizing, reserved capacity, lifecycle policies
- **Sustainability** — Resource efficiency, managed services usage, data lifecycle

---

## Naming Convention

All review documents follow the naming pattern:

```
code-review-{topic-slug}.md
```

- **`{topic-slug}`** is a kebab-case identifier for the topic (e.g., `cdk-infrastructure`, `s3-best-practices`, `well-architected`)
- All review documents are placed in the `docs/code-reviews/` directory
- The slug should be concise but descriptive enough to identify the topic at a glance

**Examples:**

| Topic | Filename |
|-------|----------|
| CDK Infrastructure | `code-review-cdk-infrastructure.md` |
| RDS | `code-review-rds.md` |
| S3 Best Practices | `code-review-s3-best-practices.md` |
| Well-Architected | `code-review-well-architected.md` |

---

## Review Process

### Full Review Workflow

Each code review follows this sequence:

1. **Select Topic** — Choose a topic area from the Planned Reviews list (or define a new one). Topics can be reviewed in any order; there are no dependencies between them.

2. **Read All Files** — Examine every file within the topic's scope. Do not sample — read each file, configuration, and module relevant to the topic. Note patterns, anti-patterns, and interactions.

3. **Identify Findings** — Document each issue discovered. For each finding, capture the file reference, a description of the problem, and the potential impact.

4. **Classify Severity** — Assign a severity level to each finding:
   - **Critical** — Active security vulnerabilities, data loss risks, or production bugs
   - **High** — Significant risks requiring attention without immediate danger
   - **Medium** — Code quality, compliance, or operational risks with workarounds
   - **Low** — Style inconsistencies or minor improvements

   When a finding spans multiple severity levels, classify at the highest applicable level and note the range in the description.

5. **Write Document** — Produce the review document at `docs/code-reviews/code-review-{topic-slug}.md` following the template structure (header, summary table, "What's Well-Designed", findings by severity, architectural recommendations, review progress checklist). Include code examples for all Critical and High findings showing both the problem and the fix.

6. **Update README.md** — Add or update the topic entry in the Review Documents table with the correct link, scope, and status.

7. **Update Tracker** — Add entries for every finding to `REMEDIATION-STATUS.md` with the appropriate status and notes. Update the "Next recommended steps" section if priorities have shifted.

### Re-Reviewing a Topic

When code changes have been made and a topic needs re-review:

1. **Open the existing review document** — Do not create a new file. Update the existing `code-review-{topic-slug}.md` in place.

2. **Update the header date** — Set the date to the current review date. Optionally note "Re-review" in the scope or add a revision note.

3. **Re-read all files in scope** — Check which findings have been addressed and whether new issues have been introduced.

4. **Update finding statuses** — Change status indicators on individual findings:
   - `✅ Fixed` — The issue has been fully resolved
   - `⚠️ Partial` — The issue has been partially addressed but work remains
   - `⏸ Deferred` — The issue is intentionally deferred (add rationale)
   - `⬜ Open` — The issue remains unaddressed

5. **Add new findings** — If new issues are discovered, add them with the next available ID in the appropriate severity section. Update the severity summary table counts.

6. **Update the severity summary table** — Adjust the "Fixed" counts to reflect current status.

7. **Update REMEDIATION-STATUS.md** — Sync the tracker with the updated document. Ensure statuses match and any new findings are added.

### Handling Cross-References

When a finding in one topic affects or relates to another topic:

**Referencing a reviewed topic:**
- Add a cross-reference using the format: `See also: [topic-slug] {ID}` (e.g., `See also: [security] C2`)
- Link to the specific document: `[code-review-security.md](code-review-security.md)`

**Referencing an unreviewed topic:**
- Note the cross-reference with a "pending" marker: `See also: [rds] (pending review)`
- Do not create placeholder finding IDs in the unreviewed topic
- When the referenced topic is eventually reviewed, check existing documents for incoming cross-references and address them

**Findings that span multiple topics:**
- Document the finding in the topic where it is most impactful (primary ownership)
- Add a cross-reference note in the other affected topic's document
- In the remediation tracker, list the finding under its primary topic only

---

## Adding New Topics

To add a new review topic to the code review framework:

1. **Create the review document** — Create a new file in `docs/code-reviews/` following the naming convention `code-review-{topic-slug}.md`.

2. **Follow the document template structure** — Every review document must include:
   - **Header** — Reviewer name, date, scope description, and completion status
   - **Severity summary table** — Counts of Critical, High, Medium, and Low findings with fix counts
   - **"What's Well-Designed" section** — Positive patterns identified before listing issues
   - **Findings by severity** — Organized into Critical, High, Medium, and Low sections. Each finding needs a unique ID (prefix + number), status indicator, file reference, description, impact assessment, and recommended fix
   - **"Architectural Recommendations" section** — Cross-cutting improvements spanning multiple findings
   - **"Review Progress" checklist** — Shows which topic areas have been completed across the overall review process

3. **Update the README.md master index** — Add the new topic to the Review Documents table above with its document link, scope description, and status.

4. **Update REMEDIATION-STATUS.md** — After completing the review, add entries for all findings to the centralized remediation tracker with their current status and any notes.
