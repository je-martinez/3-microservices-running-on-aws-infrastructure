-- Verification queries for 000001_baseline. Run against a database the baseline
-- has been applied to. Every SELECT must return the stated expected row.

-- 1. Both tables exist with the inherited (NOT the MySQL 8 default) collation.
--    Expected: two rows, both utf8mb4_unicode_ci.
SELECT TABLE_NAME, TABLE_COLLATION
FROM information_schema.TABLES
WHERE TABLE_SCHEMA = DATABASE()
  AND TABLE_NAME IN ('tracking', 'tracking_history')
ORDER BY TABLE_NAME;

-- 2. tags is NOT NULL and carries an expression default.
--    Expected: IS_NULLABLE='NO', COLUMN_DEFAULT contains 'json_array'.
SELECT COLUMN_NAME, IS_NULLABLE, COLUMN_DEFAULT
FROM information_schema.COLUMNS
WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'tracking' AND COLUMN_NAME = 'tags';

-- 3. The history primary key is the composite (tracking_id, status).
--    Expected: exactly two rows, tracking_id at position 1, status at position 2.
SELECT COLUMN_NAME, ORDINAL_POSITION
FROM information_schema.KEY_COLUMN_USAGE
WHERE TABLE_SCHEMA = DATABASE()
  AND TABLE_NAME = 'tracking_history'
  AND CONSTRAINT_NAME = 'PRIMARY'
ORDER BY ORDINAL_POSITION;

-- 4. The FK exists with no ON DELETE/ON UPDATE clause, which MySQL enforces as
--    RESTRICT but REPORTS in information_schema as 'NO ACTION'. The two are
--    synonyms in InnoDB (there are no deferred checks), and 'NO ACTION' is what
--    the live Alembic-managed `tracking` database reports for this same FK —
--    verified 2026-08-27 on MySQL 8.0.46. Expect NO ACTION here, not RESTRICT.
--    Expected: DELETE_RULE='NO ACTION', UPDATE_RULE='NO ACTION'.
SELECT CONSTRAINT_NAME, DELETE_RULE, UPDATE_RULE
FROM information_schema.REFERENTIAL_CONSTRAINTS
WHERE CONSTRAINT_SCHEMA = DATABASE()
  AND CONSTRAINT_NAME = 'fk_tracking_history_tracking_id';

-- 5. Both UNIQUE constraints are present under their declared names.
--    Expected: uq_tracking_order_id and uq_tracking_tracking_number.
SELECT CONSTRAINT_NAME
FROM information_schema.TABLE_CONSTRAINTS
WHERE TABLE_SCHEMA = DATABASE()
  AND TABLE_NAME = 'tracking'
  AND CONSTRAINT_TYPE = 'UNIQUE'
ORDER BY CONSTRAINT_NAME;

-- 6. All eight indexes exist.
--    Expected 8 names: the five on tracking, the three on tracking_history.
SELECT DISTINCT INDEX_NAME
FROM information_schema.STATISTICS
WHERE TABLE_SCHEMA = DATABASE()
  AND TABLE_NAME IN ('tracking', 'tracking_history')
  AND INDEX_NAME LIKE 'idx_%'
ORDER BY INDEX_NAME;
