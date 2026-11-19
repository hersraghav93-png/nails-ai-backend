-- =============================================================================
-- REVERSIBLE TEST DATA RESTORE / ROLLBACK SCRIPT
-- Nails by Divya Platform — Staging/Production Database
--
-- Restores archived test data from _archive_* tables back into live tables.
-- =============================================================================

BEGIN;

-- 1. Restore Core Orders & Bookings
INSERT INTO orders
SELECT * FROM _archive_orders
ON CONFLICT (id) DO NOTHING;

INSERT INTO bookings
SELECT * FROM _archive_bookings
ON CONFLICT (id) DO NOTHING;

-- 2. Restore Dependents
INSERT INTO shipments
SELECT * FROM _archive_shipments
ON CONFLICT (id) DO NOTHING;

INSERT INTO order_items
SELECT * FROM _archive_order_items
ON CONFLICT (id) DO NOTHING;

INSERT INTO order_status_history
SELECT * FROM _archive_order_status_history
ON CONFLICT (id) DO NOTHING;

INSERT INTO payments
SELECT * FROM _archive_payments
ON CONFLICT (id) DO NOTHING;

INSERT INTO order_claim_attempts
SELECT * FROM _archive_order_claim_attempts
ON CONFLICT (id) DO NOTHING;

INSERT INTO discount_redemptions
SELECT * FROM _archive_discount_redemptions
ON CONFLICT (id) DO NOTHING;

INSERT INTO booking_status_history
SELECT * FROM _archive_booking_status_history
ON CONFLICT (id) DO NOTHING;

INSERT INTO booking_action_tokens
SELECT * FROM _archive_booking_action_tokens
ON CONFLICT (id) DO NOTHING;

-- 3. Clear Archive Tables (Only upon verified restoration)
-- TRUNCATE TABLE _archive_payments, _archive_order_items, _archive_order_status_history, _archive_order_claim_attempts, _archive_discount_redemptions, _archive_booking_action_tokens, _archive_booking_status_history, _archive_orders, _archive_bookings;

COMMIT;
