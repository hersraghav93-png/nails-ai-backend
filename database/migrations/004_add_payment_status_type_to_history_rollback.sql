-- =============================================================================
-- ROLLBACK MIGRATION 004: Payment Status History & Payment Verification Permission
-- Nails by Divya Platform — Phase 5.1A
-- =============================================================================

-- 1. Remove role permissions mapping
DELETE FROM role_permissions WHERE permission_id = 'orders:verify_payment';

-- 2. Remove permission definition
DELETE FROM permissions WHERE id = 'orders:verify_payment';

-- 3. Revert order_status_history chk_status_type constraint
DELETE FROM order_status_history WHERE status_type = 'payment';
ALTER TABLE order_status_history DROP CONSTRAINT IF EXISTS chk_status_type;
ALTER TABLE order_status_history ADD CONSTRAINT chk_status_type
    CHECK (status_type IN ('order', 'fulfilment', 'refund'));
