-- The customer-facing order number, mirrored from Orders.
--
-- CONTRACT: Tracking does NOT mint this and must never generate one. Orders owns the
-- format and the uniqueness guarantee; this column is a MIRROR so Tracking's own status
-- emails can print the friendly number, because the events pipeline holds no connection to
-- the Orders database and the envelope has to carry everything a template renders.
-- See [[friendly-order-number]]
--
-- CONTRACT: No UNIQUE constraint here, deliberately. `uq_tracking_order_id` already makes
-- one tracking per order, so uniqueness is inherited; declaring it again would make
-- Tracking reject a row for a duplicate it has no authority to adjudicate, turning an
-- Orders-side collision into a tracking that silently never gets created.
--
-- char(12): the canonical form is exactly this wide with no separator. NULL for a tracking
-- created before this column existed, and for an order predating the Orders-side backfill.
ALTER TABLE tracking
  ADD COLUMN order_number CHAR(12) NULL AFTER order_id;
