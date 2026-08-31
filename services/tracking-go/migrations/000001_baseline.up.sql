-- Baseline schema for the Tracking service.
--
-- Squash of Alembic revisions da01eaebb060 -> b17f4c2e9a30 -> 0a1cc6845c4a ->
-- c93b7d1f52ae. See migrations/README.md before applying this to a database that
-- an Alembic-managed Python service has already migrated: there you STAMP
-- (`migrate force 1`), you do not run this file.
--
-- CHARSET/COLLATE are declared EXPLICITLY even though the Python DDL never did.
-- Python inherited utf8mb4_unicode_ci from the server. MySQL 8 would otherwise
-- default a fresh database to utf8mb4_0900_ai_ci, silently changing string
-- comparison semantics for order_id and cognito_sub lookups.

CREATE TABLE tracking (
  id               VARCHAR(28)  NOT NULL,
  user_id          VARCHAR(28)  NOT NULL,
  order_id         VARCHAR(28)  NOT NULL,
  status           VARCHAR(50)  NOT NULL,
  shipping_address JSON         NULL,
  -- Backticked: `datetime` is also a type keyword. Every query that selects it
  -- must backtick it and alias it (`datetime` AS occurred_at).
  `datetime`       DATETIME     NOT NULL,
  created_by       VARCHAR(64)  NULL,
  created_at       DATETIME     NOT NULL,
  updated_by       VARCHAR(64)  NULL,
  updated_at       DATETIME     NOT NULL,
  deleted_by       VARCHAR(64)  NULL,
  deleted_at       DATETIME     NULL,
  cognito_sub      VARCHAR(255) NULL,
  -- The parentheses around JSON_ARRAY() are MANDATORY. MySQL rejects a bare
  -- literal default on a JSON column; only a parenthesized expression default is
  -- legal. NOT NULL because JSON_CONTAINS(NULL, ...) is NULL, not FALSE, which
  -- would silently exclude a NULL-tags row from the e2e-cleanup predicate.
  tags             JSON         NOT NULL DEFAULT (JSON_ARRAY()),
  tracking_number  VARCHAR(20)  NOT NULL,
  PRIMARY KEY (id),
  CONSTRAINT uq_tracking_order_id        UNIQUE (order_id),
  CONSTRAINT uq_tracking_tracking_number UNIQUE (tracking_number)
) DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE INDEX idx_tracking_deleted_at            ON tracking (deleted_at);
CREATE INDEX idx_tracking_order_id_user_id      ON tracking (order_id, user_id);
CREATE INDEX idx_tracking_user_id               ON tracking (user_id);
CREATE INDEX idx_tracking_order_id_cognito_sub  ON tracking (order_id, cognito_sub);
CREATE INDEX idx_tracking_cognito_sub           ON tracking (cognito_sub);

-- tracking_history deliberately has NO surrogate id, NO tags, and NO
-- shipping_address. The address is fixed for a tracking's lifetime, so
-- snapshotting it per transition would store identical JSON five times. The
-- composite PK (tracking_id, status) is a SECOND enforcement of the forward-only
-- state machine: at most one row per status, so a duplicate transition fails at
-- INSERT even if an application guard is bypassed.
CREATE TABLE tracking_history (
  tracking_id  VARCHAR(28)  NOT NULL,
  status       VARCHAR(50)  NOT NULL,
  user_id      VARCHAR(28)  NOT NULL,
  order_id     VARCHAR(28)  NOT NULL,
  `datetime`   DATETIME     NOT NULL,
  created_by   VARCHAR(64)  NULL,
  created_at   DATETIME     NOT NULL,
  updated_by   VARCHAR(64)  NULL,
  updated_at   DATETIME     NOT NULL,
  deleted_by   VARCHAR(64)  NULL,
  deleted_at   DATETIME     NULL,
  cognito_sub  VARCHAR(255) NULL,
  PRIMARY KEY (tracking_id, status),
  -- No ON DELETE / ON UPDATE clause: MySQL applies RESTRICT, which is what we
  -- want. The application never issues DELETE (it soft-deletes via deleted_at)
  -- and the DB user has no DELETE grant. Do not add ON DELETE CASCADE.
  CONSTRAINT fk_tracking_history_tracking_id FOREIGN KEY (tracking_id) REFERENCES tracking (id)
) DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE INDEX idx_tracking_history_deleted_at           ON tracking_history (deleted_at);
CREATE INDEX idx_tracking_history_order_id_user_id     ON tracking_history (order_id, user_id);
CREATE INDEX idx_tracking_history_order_id_cognito_sub ON tracking_history (order_id, cognito_sub);
