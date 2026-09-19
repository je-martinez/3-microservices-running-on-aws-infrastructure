-- CONTRACT: Dropping this table discards any message not yet published. Drain the outbox
-- first (`SELECT COUNT(*) FROM outbox` at zero) or the transitions still queued lose their
-- email and WebSocket push permanently.
DROP TABLE outbox;
