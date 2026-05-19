/**
 * Unit Tests: Migration 006 - Add ON DELETE CASCADE to case_reviewers
 *
 * Feature: security-hardening
 *
 * Validates: Requirements 10.3, 10.4
 *
 * Verifies that the migration SQL correctly drops and recreates the
 * fk_caserev_case constraint with ON DELETE CASCADE (up), and reverts
 * to the original constraint without CASCADE (down).
 */

const migration = require("../lambda/db_setup/migrations/006_add_cascade_to_case_reviewers");

describe("Migration 006: Add ON DELETE CASCADE to case_reviewers", () => {
  let pgm: { sql: jest.Mock; capturedSql: string[] };

  beforeEach(() => {
    pgm = {
      capturedSql: [],
      sql: jest.fn((sqlStr: string) => {
        pgm.capturedSql.push(sqlStr);
      }),
    };
  });

  describe("up migration", () => {
    beforeEach(() => {
      migration.up(pgm);
    });

    it("calls pgm.sql exactly once", () => {
      expect(pgm.sql).toHaveBeenCalledTimes(1);
    });

    it("drops the existing fk_caserev_case constraint", () => {
      const sql = pgm.capturedSql[0];
      expect(sql).toMatch(/DROP\s+CONSTRAINT\s+fk_caserev_case/i);
    });

    it("recreates the constraint with ON DELETE CASCADE", () => {
      const sql = pgm.capturedSql[0];
      expect(sql).toMatch(
        /ADD\s+CONSTRAINT\s+fk_caserev_case\s+FOREIGN\s+KEY\s*\(case_id\)\s*REFERENCES\s+cases\s*\(case_id\)\s*ON\s+DELETE\s+CASCADE/i
      );
    });

    it("targets the case_reviewers table", () => {
      const sql = pgm.capturedSql[0];
      expect(sql).toMatch(/ALTER\s+TABLE\s+case_reviewers/i);
    });
  });

  describe("down migration", () => {
    beforeEach(() => {
      migration.down(pgm);
    });

    it("calls pgm.sql exactly once", () => {
      expect(pgm.sql).toHaveBeenCalledTimes(1);
    });

    it("drops the CASCADE constraint", () => {
      const sql = pgm.capturedSql[0];
      expect(sql).toMatch(/DROP\s+CONSTRAINT\s+fk_caserev_case/i);
    });

    it("recreates the constraint without ON DELETE CASCADE", () => {
      const sql = pgm.capturedSql[0];
      // Should have ADD CONSTRAINT with FOREIGN KEY but NOT ON DELETE CASCADE
      expect(sql).toMatch(
        /ADD\s+CONSTRAINT\s+fk_caserev_case\s+FOREIGN\s+KEY\s*\(case_id\)\s*REFERENCES\s+cases\s*\(case_id\)/i
      );
      // The down SQL should NOT contain ON DELETE CASCADE
      const addConstraintMatch = sql.match(
        /ADD\s+CONSTRAINT\s+fk_caserev_case\s+FOREIGN\s+KEY\s*\(case_id\)\s*REFERENCES\s+cases\s*\(case_id\)(.*?)(?:;|$)/is
      );
      expect(addConstraintMatch).not.toBeNull();
      const afterReferences = addConstraintMatch![1];
      expect(afterReferences).not.toMatch(/ON\s+DELETE\s+CASCADE/i);
    });

    it("targets the case_reviewers table", () => {
      const sql = pgm.capturedSql[0];
      expect(sql).toMatch(/ALTER\s+TABLE\s+case_reviewers/i);
    });
  });
});
