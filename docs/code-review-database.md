# Code Review: Database (Schema, Migrations, Setup)

**Reviewer:** Kiro  
**Date:** 2026-05-15  
**Scope:** `cdk/lambda/db_setup/` — PostgreSQL 17.4 schema, migrations (node-pg-migrate), initialization Lambda  
**Status:** Complete

---

## Summary

| Severity | Count | Fixed |
|----------|-------|-------|
| Critical | 1     | 0     |
| High     | 2     | 0     |
| Medium   | 4     | 0     |
| Low      | 3     | 0     |
| **Total**| **10**| **0** |

---

## What's Well-Designed

**Migration system is solid.** Uses `node-pg-migrate` with numbered migrations, proper `up`/`down` functions, and idempotent seed data (`ON CONFLICT DO NOTHING`). Supports manual rollback via event payload (`{ "direction": "down", "count": 1 }`).

**Role-based access control at the database level.** Three credential tiers (admin, table-creator `app_tc`, read-write `app_rw`) with appropriate PostgreSQL role grants. The `readwrite` role gets SELECT/INSERT/UPDATE/DELETE but not CREATE/DROP. The `tablecreator` role additionally gets CREATE on schema.

**Password rotation on every deploy.** `createAppUsers()` generates fresh random passwords for `app_rw` and `app_tc` on each CDK deploy and updates Secrets Manager. This limits credential exposure window.

**Schema uses proper PostgreSQL features.** Enums for constrained values (`user_role`, `case_status`, `block_type`), UUID primary keys, array types for multi-value fields (`roles user_role[]`, `jurisdiction varchar[]`), and partial unique indexes for "one active" constraints.

**Foreign keys with appropriate cascade behavior.** `case_feedback`, `summaries`, `audio_files`, `messages` all cascade on case deletion. `annotations` cascade on summary deletion.

---

## Critical Issues

### C1. SQL injection vulnerability in `createAppUsers()` via string interpolation
- **Status:** ⬜ Open
- **File:** `db_setup/index.js`
- **Description:** The `createAppUsers` function builds SQL using template literals with interpolated passwords:
```javascript
const sql = `
  DO $$
  BEGIN
    IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = '${RW_NAME}') THEN
      EXECUTE format('CREATE USER ${RW_NAME} WITH PASSWORD %L', '${rwPass}');
    ELSE
      EXECUTE format('ALTER USER ${RW_NAME} WITH PASSWORD %L', '${rwPass}');
    END IF;
    ...
  END$$;
`;
await adminClient.query(sql);
```
While `RW_NAME` and `TC_NAME` are hardcoded constants (`"app_rw"`, `"app_tc"`), the passwords (`rwPass`, `tcPass`) are generated from `crypto.randomBytes(16).toString("hex")`. Since hex encoding only produces `[0-9a-f]`, SQL injection is not practically exploitable here. However, the pattern is dangerous — if the password generation ever changes to include special characters (e.g., base64), a single quote in the password would break the SQL or enable injection.

The `format(..., %L)` inside the `EXECUTE` properly quotes the password for the inner statement, but the outer `DO $$ ... END$$` block has the password interpolated directly into the PL/pgSQL string literal `'${rwPass}'`. If `rwPass` contained a single quote, it would escape the string.

- **Impact:** Currently not exploitable (hex-only passwords). But the pattern is a latent vulnerability.
- **Fix:** Use parameterized queries or ensure the password is properly escaped:
```javascript
// Option 1: Use pg's parameterized queries for user creation
await adminClient.query(`ALTER USER app_rw WITH PASSWORD $1`, [rwPass]);

// Option 2: Use dollar-quoting to avoid quote escaping issues
const sql = `
  DO $body$
  BEGIN
    EXECUTE format('ALTER USER app_rw WITH PASSWORD %L', $pass$${rwPass}$pass$);
  END$body$;
`;
```

---

## High Issues

### H1. `case_reviewers` table lacks `ON DELETE CASCADE` — orphan risk
- **Status:** ⬜ Open
- **File:** `migrations/000_initial_schema.js`
- **Description:**
```sql
ALTER TABLE case_reviewers ADD CONSTRAINT fk_caserev_case 
  FOREIGN KEY (case_id) REFERENCES cases(case_id);
-- No ON DELETE CASCADE!
```
All other case-related tables (`summaries`, `audio_files`, `messages`, `case_feedback`) have `ON DELETE CASCADE`. But `case_reviewers` does not. This means:
1. Deleting a case via SQL will fail with a foreign key violation
2. The instructor handler's `DELETE /instructor/delete_case` route manually deletes `case_reviewers` first (a workaround)
3. If any other code path tries to delete a case without this workaround, it will fail

- **Fix:** Add a migration to add CASCADE:
```sql
ALTER TABLE case_reviewers DROP CONSTRAINT fk_caserev_case;
ALTER TABLE case_reviewers ADD CONSTRAINT fk_caserev_case 
  FOREIGN KEY (case_id) REFERENCES cases(case_id) ON DELETE CASCADE;
```

---

### H2. No index on `cases.student_id` — slow queries for student dashboards
- **Status:** ⬜ Open
- **File:** `migrations/000_initial_schema.js`
- **Description:** The `cases` table has a foreign key `student_id` referencing `users(user_id)`, but there's no index on `cases.student_id`. Every student dashboard query (`WHERE student_id = $1`) and every instructor view (`WHERE student_id = ANY($1)`) performs a sequential scan on the cases table.
- **Impact:** As the cases table grows, dashboard load times degrade linearly. With 1000+ cases, queries become noticeably slow.
- **Fix:** Add an index:
```sql
CREATE INDEX idx_cases_student_id ON cases(student_id);
```
Also consider a composite index for the common paginated query pattern:
```sql
CREATE INDEX idx_cases_student_last_updated ON cases(student_id, last_updated DESC);
```

---

## Medium Issues

### M1. Migration 001 is empty — no-op migration in the chain
- **Status:** ⬜ Open
- **File:** `migrations/001_rename_unlocked_to_completed.js`
- **Description:** Both `up` and `down` functions are empty. The migration was likely applied before the initial schema was consolidated (the initial schema already uses `completed_blocks`). This is a no-op that adds confusion.
- **Impact:** No functional impact, but confusing for developers reading the migration history.
- **Fix:** Add a comment explaining it's intentionally empty (already applied in 000), or remove if safe.

---

### M2. No `updated_at` / `last_modified` timestamp on most tables
- **Status:** ⬜ Open
- **File:** `migrations/000_initial_schema.js`
- **Description:** Tables like `summaries`, `audio_files`, `messages`, and `prompt_versions` have `time_created` but no `updated_at` column. The `cases` table has `last_updated` but it's manually maintained by application code (not a database trigger).
- **Impact:** No audit trail for when records were modified. If `last_updated` on cases is not consistently updated by all code paths, it becomes unreliable.
- **Fix:** Add `updated_at` columns with a trigger:
```sql
CREATE OR REPLACE FUNCTION update_modified_column()
RETURNS TRIGGER AS $$
BEGIN
  NEW.updated_at = NOW();
  RETURN NEW;
END;
$$ language 'plpgsql';
```

---

### M3. `users.username` column exists but is never used
- **Status:** ⬜ Open
- **File:** `migrations/000_initial_schema.js`
- **Description:** The `users` table has a `username varchar` column, but no Lambda function or handler ever reads or writes to it. User identification is done via `user_email` and `idp_id`.
- **Impact:** Dead column consuming storage. Could confuse developers.
- **Fix:** Remove in a future migration if confirmed unused.

---

### M4. `cases.jurisdiction` is `varchar[]` but queried inconsistently
- **Status:** ⬜ Open
- **File:** `migrations/000_initial_schema.js`, various Lambda handlers
- **Description:** `jurisdiction` is defined as `varchar[]` (array), but:
- The student handler searches it with `CAST(jurisdiction AS TEXT) ILIKE ${search}` — casting array to text for search
- The summary generation Lambda checks `if isinstance(jurisdiction, list)` and joins it
- The case generation Lambda inserts it directly from the request body (could be string or array)
- **Impact:** Inconsistent handling. Text casting for search is inefficient and won't use indexes. The type mismatch between frontend (sometimes string, sometimes array) and database (always array) creates edge cases.
- **Fix:** Standardize: either always store as array and use `ANY()` or `array_to_string()` for search, or change to a simple `varchar` if single-jurisdiction is the common case.

---

## Low Issues

### L1. `users.metadata` JSONB column exists but is never used
- **Status:** ⬜ Open
- **File:** `migrations/000_initial_schema.js`
- **Description:** `metadata jsonb DEFAULT '{}'::jsonb` — no code reads or writes this column.
- **Impact:** Dead column. Minimal storage overhead due to empty default.

---

### L2. No database-level constraint preventing empty `roles` array
- **Status:** ⬜ Open
- **File:** `migrations/000_initial_schema.js`
- **Description:** `roles user_role[]` has no CHECK constraint ensuring at least one role. The admin handler prevents removing the last role at the application level, but the database doesn't enforce it.
- **Fix:** Add a constraint:
```sql
ALTER TABLE users ADD CONSTRAINT chk_users_roles_nonempty 
  CHECK (array_length(roles, 1) > 0);
```

---

### L3. Seed migrations use `ON CONFLICT DO NOTHING` without specifying conflict target
- **Status:** ⬜ Open
- **Files:** `migrations/004_seed_default_system_prompts.js`, `migrations/005_seed_default_disclaimer.js`
- **Description:** `ON CONFLICT DO NOTHING` without specifying which constraint to check. PostgreSQL will use any unique constraint violation as the conflict trigger. This works but is less explicit than `ON CONFLICT ON CONSTRAINT ... DO NOTHING`.
- **Impact:** Functional but could mask unexpected constraint violations during re-runs.

---

## Architectural Recommendations

### R1. Add missing indexes for common query patterns
- **Priority:** High
- **Description:** Add indexes for:
  - `cases(student_id)` — student dashboard queries
  - `cases(student_id, last_updated DESC)` — paginated case listing
  - `cases(status)` — status-filtered queries
  - `summaries(case_id, scope)` — summary lookups
  - `audio_files(case_id)` — transcription listing
- **Benefit:** Significant query performance improvement as data grows.

---

### R2. Add CASCADE to `case_reviewers` foreign key
- **Priority:** High
- **Description:** Align `case_reviewers` with all other case-related tables by adding `ON DELETE CASCADE`. This eliminates the need for manual deletion in application code and prevents orphan records.

---

### R3. Consider adding database-level audit triggers
- **Priority:** Medium
- **Description:** For a legal application handling privileged information, consider adding:
  - `updated_at` triggers on all mutable tables
  - An audit log table recording who changed what and when
  - Row-level security (RLS) policies as a defense-in-depth measure
- **Benefit:** Compliance, debugging, and security audit trail.

---

### R4. Document the schema with comments
- **Priority:** Low
- **Description:** Add PostgreSQL `COMMENT ON TABLE/COLUMN` statements to document the purpose of each table and non-obvious columns. This helps developers understand the schema without reading application code.

---

## Review Progress

- [x] Architecture & folder structure
- [x] Lambda functions (Python)
- [x] Lambda functions (Node.js handlers)
- [x] CDK infrastructure (all 7 stacks)
- [x] Frontend (React app, auth flow, API service layer)
- [x] Database (migrations, schema, setup)
- [ ] Security (holistic view — final summary)
