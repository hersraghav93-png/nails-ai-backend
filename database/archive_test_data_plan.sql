-- =============================================================================
-- REVERSIBLE TEST DATA ARCHIVE SCRIPT (PREPARE ONLY — DO NOT RUN WITHOUT EXPLICIT APPROVAL)
-- Nails by Divya Platform — Staging/Production Database
--
-- Safely archives automated synthetic test orders and test bookings
-- along with all dependent records into isolated _archive_* tables.
--
-- EXCLUSION:
-- Preserves Developer Smoke Orders: NBD-ORD-1241, NBD-ORD-1298 (Raghavendra Joshi)
-- Preserves Developer Smoke Booking: NBD-BKG-599 (Raghavendra Joshi)
-- Preserves all genuine customer records, studio users, products, services, portfolio entries.
-- =============================================================================

BEGIN;

-- 1. Create Archive Tables if not existing
CREATE TABLE IF NOT EXISTS _archive_orders (LIKE orders INCLUDING ALL);
CREATE TABLE IF NOT EXISTS _archive_order_items (LIKE order_items INCLUDING ALL);
CREATE TABLE IF NOT EXISTS _archive_order_status_history (LIKE order_status_history INCLUDING ALL);
CREATE TABLE IF NOT EXISTS _archive_payments (LIKE payments INCLUDING ALL);
CREATE TABLE IF NOT EXISTS _archive_order_claim_attempts (LIKE order_claim_attempts INCLUDING ALL);
CREATE TABLE IF NOT EXISTS _archive_discount_redemptions (LIKE discount_redemptions INCLUDING ALL);
CREATE TABLE IF NOT EXISTS _archive_bookings (LIKE bookings INCLUDING ALL);
CREATE TABLE IF NOT EXISTS _archive_booking_status_history (LIKE booking_status_history INCLUDING ALL);
CREATE TABLE IF NOT EXISTS _archive_booking_action_tokens (LIKE booking_action_tokens INCLUDING ALL);

-- 2. Identify Test Orders & Test Bookings Using Positive Cohort Matching
CREATE TEMP TABLE tmp_test_orders ON COMMIT DROP AS
SELECT id FROM orders
WHERE (
    order_number LIKE 'NBD-ORD-PAY-%'
    OR order_number LIKE 'NBD-ORD-OPS-%'
    OR customer_name IN (
      'Ananya Roy', 'Ops Customer', 'Cancel Customer', 'Customer A',
      'Aditi Sharma', 'Idem User', 'Rhea Sen', 'Verified Customer',
      'Aanya Verma', 'Staging Test Customer'
    )
  )
  AND customer_name NOT ILIKE '%Raghavendra%'
  AND customer_phone NOT IN ('+917307622189', '7307622189')
  AND order_number NOT IN ('NBD-ORD-1241', 'NBD-ORD-1298');

CREATE TEMP TABLE tmp_test_bookings ON COMMIT DROP AS
SELECT id FROM bookings
WHERE (
    booking_number LIKE 'NBD-BKG-OPS-%'
    OR customer_name IN (
      'Meera Kapoor', 'Aarti Verma', 'Idem User', 'Radhika Mehra',
      'Pooja Malhotra', 'Customer A', 'Ops Booking Customer',
      'Pooja Verma', 'Staging Test Customer'
    )
  )
  AND customer_name NOT ILIKE '%Raghavendra%'
  AND customer_phone NOT IN ('+917307622189', '7307622189')
  AND booking_number NOT IN ('NBD-BKG-599');

-- 3. Archive Dependent Records First
INSERT INTO _archive_order_items
SELECT * FROM order_items WHERE order_id IN (SELECT id FROM tmp_test_orders)
ON CONFLICT (id) DO NOTHING;

INSERT INTO _archive_order_status_history
SELECT * FROM order_status_history WHERE order_id IN (SELECT id FROM tmp_test_orders)
ON CONFLICT (id) DO NOTHING;

INSERT INTO _archive_payments
SELECT * FROM payments WHERE order_id IN (SELECT id FROM tmp_test_orders) OR booking_id IN (SELECT id FROM tmp_test_bookings)
ON CONFLICT (id) DO NOTHING;

INSERT INTO _archive_order_claim_attempts
SELECT * FROM order_claim_attempts WHERE order_id IN (SELECT id FROM tmp_test_orders)
ON CONFLICT (id) DO NOTHING;

INSERT INTO _archive_discount_redemptions
SELECT * FROM discount_redemptions WHERE order_id IN (SELECT id FROM tmp_test_orders)
ON CONFLICT (id) DO NOTHING;

INSERT INTO _archive_booking_status_history
SELECT * FROM booking_status_history WHERE booking_id IN (SELECT id FROM tmp_test_bookings)
ON CONFLICT (id) DO NOTHING;

INSERT INTO _archive_booking_action_tokens
SELECT * FROM booking_action_tokens WHERE booking_id IN (SELECT id FROM tmp_test_bookings)
ON CONFLICT (id) DO NOTHING;

-- 4. Archive Core Test Records
INSERT INTO _archive_orders
SELECT * FROM orders WHERE id IN (SELECT id FROM tmp_test_orders)
ON CONFLICT (id) DO NOTHING;

INSERT INTO _archive_bookings
SELECT * FROM bookings WHERE id IN (SELECT id FROM tmp_test_bookings)
ON CONFLICT (id) DO NOTHING;

-- 5. Safe Delete in Reverse Dependency Order (Only to be uncommented upon explicit approval)
-- DELETE FROM payments WHERE order_id IN (SELECT id FROM tmp_test_orders) OR booking_id IN (SELECT id FROM tmp_test_bookings);
-- DELETE FROM order_items WHERE order_id IN (SELECT id FROM tmp_test_orders);
-- DELETE FROM order_status_history WHERE order_id IN (SELECT id FROM tmp_test_orders);
-- DELETE FROM order_claim_attempts WHERE order_id IN (SELECT id FROM tmp_test_orders);
-- DELETE FROM discount_redemptions WHERE order_id IN (SELECT id FROM tmp_test_orders);
-- DELETE FROM booking_action_tokens WHERE booking_id IN (SELECT id FROM tmp_test_bookings);
-- DELETE FROM booking_status_history WHERE booking_id IN (SELECT id FROM tmp_test_bookings);
-- DELETE FROM orders WHERE id IN (SELECT id FROM tmp_test_orders);
-- DELETE FROM bookings WHERE id IN (SELECT id FROM tmp_test_bookings);

COMMIT;
