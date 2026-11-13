-- =============================================================================
-- MIGRATION 002 ROLLBACK: REMOVE FIREBASE UID FROM USERS
-- Phase 1C: Customer Authentication & User Accounts Rollback
-- =============================================================================

BEGIN;

DROP INDEX IF EXISTS idx_users_firebase_uid;

ALTER TABLE users DROP COLUMN IF EXISTS firebase_uid;

COMMIT;
