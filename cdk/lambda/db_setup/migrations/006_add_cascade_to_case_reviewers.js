// Migration: Add ON DELETE CASCADE to case_reviewers foreign key on case_id.
// When a case is deleted, its reviewer assignments are automatically cleaned up.
// This prevents orphaned rows in case_reviewers and aligns with the CASCADE
// behavior already present on case_feedback, summaries, audio_files, and messages.

exports.up = async function (pgm) {
  pgm.sql(`
    -- Drop existing FK without CASCADE
    ALTER TABLE case_reviewers DROP CONSTRAINT IF EXISTS fk_caserev_case;

    -- Re-add with ON DELETE CASCADE
    ALTER TABLE case_reviewers
      ADD CONSTRAINT fk_caserev_case
      FOREIGN KEY (case_id) REFERENCES cases(case_id) ON DELETE CASCADE;
  `);
};

exports.down = async function (pgm) {
  pgm.sql(`
    -- Revert to FK without CASCADE
    ALTER TABLE case_reviewers DROP CONSTRAINT IF EXISTS fk_caserev_case;

    ALTER TABLE case_reviewers
      ADD CONSTRAINT fk_caserev_case
      FOREIGN KEY (case_id) REFERENCES cases(case_id);
  `);
};
