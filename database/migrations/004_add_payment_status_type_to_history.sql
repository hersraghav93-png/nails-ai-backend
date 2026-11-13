-- =============================================================================
-- MIGRATION 004: Payment Status History & Payment Verification Permission
-- Nails by Divya Platform — Phase 5.1A
--
-- 1. Expands order_status_history chk_status_type constraint to accept 'payment'
-- 2. Inserts 'orders:verify_payment' permission
-- 3. Grants 'orders:verify_payment' to 'super_operator' and 'artist_divya'
-- =============================================================================

-- 1. Expand order_status_history constraint
ALTER TABLE order_status_history DROP CONSTRAINT IF EXISTS chk_status_type;
ALTER TABLE order_status_history ADD CONSTRAINT chk_status_type
    CHECK (status_type IN ('order', 'fulfilment', 'refund', 'payment'));

-- 2. Insert fine-grained permission for manual payment verification
INSERT INTO permissions (id, name, description) VALUES
('orders:verify_payment', 'Verify Payments', 'Manually verify received customer payments and update payment status')
ON CONFLICT (id) DO NOTHING;

-- 3. Map permission to authorized roles (Super Operator and Artist Divya)
INSERT INTO role_permissions (role_id, permission_id) VALUES
('super_operator', 'orders:verify_payment'),
('artist_divya', 'orders:verify_payment')
ON CONFLICT DO NOTHING;
