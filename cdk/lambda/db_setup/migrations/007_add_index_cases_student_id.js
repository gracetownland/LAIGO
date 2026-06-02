// Migration: Add index on cases.student_id for efficient lookups.
// The student dashboard queries cases by student_id on every page load.
// Without this index, PostgreSQL performs a sequential scan on the cases table.

exports.up = async function (pgm) {
  pgm.sql(`
    CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_cases_student_id
      ON cases (student_id);
  `);
};

exports.down = async function (pgm) {
  pgm.sql(`
    DROP INDEX IF EXISTS idx_cases_student_id;
  `);
};
