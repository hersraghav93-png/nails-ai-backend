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
INSERT INTO order_items
SELECT * FROM _archive_order_items
ON CONFLICT (id) DO NOTHING;

INSERT INTO order_status_history
SELECT * FROM _archive_order_status_history
ON CONFLICT (id) DO NOTHING;

INSERT INTO payments
SELECT * FROM _archive_payments
ON CONFLICT (id) DO NOTHING;

INSERT INTO booking_status_history
SELECT * FROM _archive_booking_status_history
ON CONFLICT (id) DO NOTHING;

INSERT INTO booking_action_tokens
SELECT * FROM _archive_booking_action_tokens
ON CONFLICT (id) DO NOTHING;

-- 3. Cleanup archive tables if rollback verified
-- DROP TABLE IF EXISTS _archive_booking_action_tokens;
-- DROP TABLE IF EXISTS _archive_booking_status_history;
-- DROP TABLE IF EXISTS _archive_payments;
-- DROP TABLE IF EXISTS _archive_order_status_history;
-- DROP TABLE IF EXISTS _archive_order_items;
-- DROP TABLE IF EXISTS _archive_orders;
-- DROP TABLE IF EXISTS _archive_bookings;

COMMIT;
