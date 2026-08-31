-- Reverse of 000001_baseline.
--
-- tracking_history is dropped FIRST: its FK references tracking.id, and the FK
-- is RESTRICT, so dropping tracking while the child table exists fails with
-- errno 3730.

DROP TABLE IF EXISTS tracking_history;
DROP TABLE IF EXISTS tracking;
