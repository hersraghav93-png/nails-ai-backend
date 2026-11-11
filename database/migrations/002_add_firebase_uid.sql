-- =============================================================================
-- MIGRATION 002: ADD FIREBASE UID TO USERS
-- Phase 1C: Customer Authentication & User Accounts
-- =============================================================================

BEGIN;

-- Add firebase_uid to users for identity provider linking
ALTER TABLE users ADD COLUMN IF NOT EXISTS firebase_uid VARCHAR(128) UNIQUE;

-- Fast partial/btree index for token verification lookups
CREATE INDEX IF NOT EXISTS idx_users_firebase_uid ON users(firebase_uid);

COMMIT;
