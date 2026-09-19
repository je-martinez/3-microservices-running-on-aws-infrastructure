-- The transactional outbox for TRACKING_STATUS_CHANGED.
--
-- A status transition writes the business rows and one row here in ONE transaction, and
-- the poller (internal/outbox) publishes to SNS afterwards. Without it the publish is a
-- second, independent operation: a process that dies between the commit and the SNS call
-- loses the email and the WebSocket push with nothing recording that it happened.
--
-- CONTRACT: This table lives in TRACKING's OWN database. There is no shared outbox store —
-- a shared one would put the business write and the outbox write in two transactions
-- against two databases, which is the exact loss window this table closes.
-- See [[cqrs]]
--
-- Column names and types are the schema `oagudo/outbox` v1.0.1 documents for MySQL, because
-- its Writer builds INSERT and the poller builds SELECT against these exact names. The
-- deviations from its README are deliberate and listed below.
CREATE TABLE outbox (
  -- BINARY(16), because the library marshals the message UUID to binary bytes for MySQL
  -- (db_context.go formatMessageIDForDB). A CHAR(36) column would take the bytes as a
  -- mangled string and the poller's DELETE would then match nothing, replaying every
  -- message forever.
  id              BINARY(16)   NOT NULL,
  -- TIMESTAMP(3), not the DATETIME the rest of this schema uses: the library compares
  -- scheduled_at against UTC_TIMESTAMP() and stamps created_at from Go. fsp 3 is the
  -- library's documented precision, and the retry backoff schedules sub-second delays that
  -- an fsp-0 column would round into the past.
  created_at      TIMESTAMP(3) NOT NULL,
  scheduled_at    TIMESTAMP(3) NOT NULL,
  -- The W3C trace context, so the publish span joins the trace of the request that wrote
  -- this row. The two would otherwise be orphans in the waterfall.
  metadata        BLOB         NULL,
  payload         BLOB         NOT NULL,
  times_attempted INT          NOT NULL,
  PRIMARY KEY (id)
) DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- CONTRACT: Keep this composite index on (scheduled_at, created_at). The poller's claim is
-- `WHERE scheduled_at <= UTC_TIMESTAMP() ORDER BY created_at LIMIT n FOR UPDATE SKIP
-- LOCKED`, and InnoDB locks the rows the SCAN touches, not the rows the query returns: on a
-- plain scan a second poller skips rows the first merely examined, so a backlog drains one
-- poller at a time while SKIP LOCKED looks like it is working.
CREATE INDEX idx_outbox_scheduled_at_created_at ON outbox (scheduled_at, created_at);
