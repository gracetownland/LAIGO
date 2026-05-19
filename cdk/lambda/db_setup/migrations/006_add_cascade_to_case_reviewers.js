// Migration: Add ON DELETE CASCADE to case_reviewers foreign key constraint
// This ensures that deleting a case automatically removes associated reviewer records

exports.up = (pgm) => {
  pgm.sql(`
    ALTER TABLE case_reviewers
      DROP CONSTRAINT fk_caserev_case;
    ALTER TABLE case_reviewers
      ADD CONSTRAINT fk_caserev_case
      FOREIGN KEY (case_id) REFERENCES cases(case_id)
      ON DELETE CASCADE;
  `);
};

exports.down = (pgm) => {
  pgm.sql(`
    ALTER TABLE case_reviewers
      DROP CONSTRAINT fk_caserev_case;
    ALTER TABLE case_reviewers
      ADD CONSTRAINT fk_caserev_case
      FOREIGN KEY (case_id) REFERENCES cases(case_id);
  `);
};
