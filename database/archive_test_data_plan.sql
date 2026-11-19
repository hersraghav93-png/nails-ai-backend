-- =============================================================================
-- REVERSIBLE TEST DATA ARCHIVE SCRIPT (PREPARE ONLY — DO NOT RUN WITHOUT EXPLICIT APPROVAL)
-- Nails by Divya Platform — Staging/Production Database
--
-- This script safely archives 295 automated test orders and 96 automated test bookings
-- along with all dependent records into isolated _archive_* tables.
--
-- EXCLUSION:
-- Preserves Developer Smoke Orders: NBD-ORD-1241, NBD-ORD-1298 (Raghavendra Joshi)
-- Preserves Developer Smoke Booking: NBD-BKG-599 (Raghavendra Joshi)
-- Preserves all genuine users, customer profiles, products, services, portfolio designs.
-- =============================================================================

BEGIN;

-- 1. Create Archive Tables if not existing
CREATE TABLE IF NOT EXISTS _archive_orders (LIKE orders INCLUDING ALL);
CREATE TABLE IF NOT EXISTS _archive_order_items (LIKE order_items INCLUDING ALL);
CREATE TABLE IF NOT EXISTS _archive_order_status_history (LIKE order_status_history INCLUDING ALL);
CREATE TABLE IF NOT EXISTS _archive_payments (LIKE payments INCLUDING ALL);
CREATE TABLE IF NOT EXISTS _archive_bookings (LIKE bookings INCLUDING ALL);
CREATE TABLE IF NOT EXISTS _archive_booking_status_history (LIKE booking_status_history INCLUDING ALL);
CREATE TABLE IF NOT EXISTS _archive_booking_action_tokens (LIKE booking_action_tokens INCLUDING ALL);

-- 2. Identify Test Orders & Test Bookings
CREATE TEMP TABLE tmp_test_orders ON COMMIT DROP AS
SELECT id FROM orders
WHERE customer_name NOT ILIKE '%Raghavendra%'
  AND customer_phone NOT IN ('+917307622189', '7307622189');

CREATE TEMP TABLE tmp_test_bookings ON COMMIT DROP AS
SELECT id FROM bookings
WHERE customer_name NOT ILIKE '%Raghavendra%'
  AND customer_phone NOT IN ('+917307622189', '7307622189');

-- 3. Archive Dependent Records First
INSERT INTO _archive_order_items
SELECT * FROM order_items WHERE order_id IN (SELECT id FROM tmp_test_orders);

INSERT INTO _archive_order_status_history
SELECT * FROM order_status_history WHERE order_id IN (SELECT id FROM tmp_test_orders);

INSERT INTO _archive_payments
SELECT * FROM payments WHERE order_id IN (SELECT id FROM tmp_test_orders) OR booking_id IN (SELECT id FROM tmp_test_bookings);

INSERT INTO _archive_booking_status_history
SELECT * FROM booking_status_history WHERE booking_id IN (SELECT id FROM tmp_test_bookings);

INSERT INTO _archive_booking_action_tokens
SELECT * FROM booking_action_tokens WHERE booking_id IN (SELECT id FROM tmp_test_bookings);

-- 4. Archive Core Test Records
INSERT INTO _archive_orders
SELECT * FROM orders WHERE id IN (SELECT id FROM tmp_test_orders);

INSERT INTO _archive_bookings
SELECT * FROM bookings WHERE id IN (SELECT id FROM tmp_test_bookings);

-- 5. Safe Delete in Reverse Dependency Order (Only to be uncommented upon approval)
-- DELETE FROM payments WHERE order_id IN (SELECT id FROM tmp_test_orders) OR booking_id IN (SELECT id FROM tmp_test_bookings);
-- DELETE FROM order_items WHERE order_id IN (SELECT id FROM tmp_test_orders);
-- DELETE FROM order_status_history WHERE order_id IN (SELECT id FROM tmp_test_orders);
-- DELETE FROM booking_action_tokens WHERE booking_id IN (SELECT id FROM tmp_test_bookings);
-- DELETE FROM booking_status_history WHERE booking_id IN (SELECT id FROM tmp_test_bookings);
-- DELETE FROM orders WHERE id IN (SELECT id FROM tmp_test_orders);
-- DELETE FROM bookings WHERE id IN (SELECT id FROM tmp_test_bookings);

COMMIT;
