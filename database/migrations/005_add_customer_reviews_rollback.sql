-- =============================================================================
-- ROLLBACK MIGRATION 005: Customer Reviews & Moderation Schema
-- Nails by Divya Platform — Phase 5.1B
--
-- SAFETY GUARD:
-- Fails safely if any customer review records exist to prevent irreversible data loss.
-- =============================================================================

-- 0. Safety check: Abort immediately if any customer reviews exist
DO $$
BEGIN
    IF EXISTS (SELECT 1 FROM information_schema.tables WHERE table_name = 'customer_reviews') THEN
        IF EXISTS (SELECT 1 FROM customer_reviews) THEN
            RAISE EXCEPTION 'Cannot rollback migration 005: customer_reviews table contains records. Rollback aborted to prevent irreversible loss of client review data.';
        END IF;
    END IF;
END $$;

-- 1. Drop trigger and table
DROP TRIGGER IF EXISTS trg_customer_reviews_updated_at ON customer_reviews;
DROP TABLE IF EXISTS customer_reviews CASCADE;

-- 2. Remove role permissions mapping
DELETE FROM role_permissions WHERE permission_id = 'reviews:moderate';

-- 3. Remove permission definition
DELETE FROM permissions WHERE id = 'reviews:moderate';
