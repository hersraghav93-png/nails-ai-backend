-- =============================================================================
-- NAILS BY DIVYA — MIGRATION 001 ROLLBACK: CLEAN REVERSIBLE DROP
-- =============================================================================

BEGIN;

-- 1. Drop Triggers & Trigger Functions
DROP TRIGGER IF EXISTS trg_sync_payment_refund_status ON refunds;
DROP FUNCTION IF EXISTS sync_payment_refund_status CASCADE;
DROP TRIGGER IF EXISTS trg_refund_concurrency_ceiling ON refunds;
DROP FUNCTION IF EXISTS check_and_reserve_refund CASCADE;
DROP TRIGGER IF EXISTS trg_invalidate_prior_booking_tokens ON bookings;
DROP FUNCTION IF EXISTS invalidate_prior_booking_tokens CASCADE;

-- 2. Drop Tables in Reverse Dependency Order (50 Tables)
DROP TABLE IF EXISTS notification_delivery_logs CASCADE;
DROP TABLE IF EXISTS notification_jobs CASCADE;
DROP TABLE IF EXISTS loyalty_transactions CASCADE;
DROP TABLE IF EXISTS loyalty_accounts CASCADE;
DROP TABLE IF EXISTS refund_events CASCADE;
DROP TABLE IF EXISTS refunds CASCADE;
DROP TABLE IF EXISTS payment_events CASCADE;
DROP TABLE IF EXISTS payments CASCADE;
DROP TABLE IF EXISTS custom_quote_items CASCADE;
DROP TABLE IF EXISTS custom_quotes CASCADE;
DROP TABLE IF EXISTS custom_request_images CASCADE;
DROP TABLE IF EXISTS custom_design_requests CASCADE;
DROP TABLE IF EXISTS booking_action_tokens CASCADE;
DROP TABLE IF EXISTS booking_status_history CASCADE;
DROP TABLE IF EXISTS bookings CASCADE;
DROP TABLE IF EXISTS order_claim_attempts CASCADE;
DROP TABLE IF EXISTS shipments CASCADE;
DROP TABLE IF EXISTS discount_redemptions CASCADE;
DROP TABLE IF EXISTS order_status_history CASCADE;
DROP TABLE IF EXISTS order_items CASCADE;
DROP TABLE IF EXISTS orders CASCADE;
DROP TABLE IF EXISTS discount_code_services CASCADE;
DROP TABLE IF EXISTS discount_code_categories CASCADE;
DROP TABLE IF EXISTS discount_code_products CASCADE;
DROP TABLE IF EXISTS discount_codes CASCADE;
DROP TABLE IF EXISTS cart_items CASCADE;
DROP TABLE IF EXISTS carts CASCADE;
DROP TABLE IF EXISTS wishlist_items CASCADE;
DROP TABLE IF EXISTS wishlists CASCADE;
DROP TABLE IF EXISTS faqs CASCADE;
DROP TABLE IF EXISTS service_areas CASCADE;
DROP TABLE IF EXISTS service_addons CASCADE;
DROP TABLE IF EXISTS services CASCADE;
DROP TABLE IF EXISTS portfolio_designs CASCADE;
DROP TABLE IF EXISTS portfolio_categories CASCADE;
DROP TABLE IF EXISTS product_variants CASCADE;
DROP TABLE IF EXISTS product_images CASCADE;
DROP TABLE IF EXISTS products CASCADE;
DROP TABLE IF EXISTS product_categories CASCADE;
DROP TABLE IF EXISTS customer_consents CASCADE;
DROP TABLE IF EXISTS user_addresses CASCADE;
DROP TABLE IF EXISTS admin_profiles CASCADE;
DROP TABLE IF EXISTS customer_profiles CASCADE;
DROP TABLE IF EXISTS user_roles CASCADE;
DROP TABLE IF EXISTS role_permissions CASCADE;
DROP TABLE IF EXISTS permissions CASCADE;
DROP TABLE IF EXISTS roles CASCADE;
DROP TABLE IF EXISTS users CASCADE;
DROP TABLE IF EXISTS business_settings CASCADE;
DROP TABLE IF EXISTS audit_logs CASCADE;

-- 3. Drop Sequences
DROP SEQUENCE IF EXISTS refund_number_seq;
DROP SEQUENCE IF EXISTS quote_number_seq;
DROP SEQUENCE IF EXISTS custom_request_seq;
DROP SEQUENCE IF EXISTS booking_number_seq;
DROP SEQUENCE IF EXISTS order_number_seq;

-- 4. Drop Base Trigger Function
DROP FUNCTION IF EXISTS update_timestamp_column CASCADE;

COMMIT;
