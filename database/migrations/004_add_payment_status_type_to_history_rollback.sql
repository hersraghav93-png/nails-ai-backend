-- =============================================================================
-- ROLLBACK MIGRATION 004: Payment Status History & Payment Verification Permission
-- Nails by Divya Platform — Phase 5.1A
--
-- SAFETY GUARD:
-- Fails safely if any payment status history records exist to prevent irreversible audit data loss.
-- =============================================================================

-- 0. Safety check: Abort immediately if payment history exists
DO $$
BEGIN
    IF EXISTS (SELECT 1 FROM order_status_history WHERE status_type = 'payment') THEN
        RAISE EXCEPTION 'Cannot rollback migration 004: order_status_history table contains records with status_type = ''payment''. Rollback aborted to prevent irreversible loss of payment audit history.';
    END IF;
END $$;

-- 1. Remove role permissions mapping
DELETE FROM role_permissions WHERE permission_id = 'orders:verify_payment';

-- 2. Remove permission definition
DELETE FROM permissions WHERE id = 'orders:verify_payment';

-- 3. Revert order_status_history chk_status_type constraint (safe only when 0 payment rows exist)
ALTER TABLE order_status_history DROP CONSTRAINT IF EXISTS chk_status_type;
ALTER TABLE order_status_history ADD CONSTRAINT chk_status_type
    CHECK (status_type IN ('order', 'fulfilment', 'refund'));
