-- =============================================================================
-- ROLLBACK 008: CUSTOMER EMAIL AUTHENTICATION MAGIC-LINK TOKENS
-- =============================================================================

BEGIN;

DROP INDEX IF EXISTS idx_email_login_tokens_active_expires;
DROP INDEX IF EXISTS idx_email_login_tokens_email_created;
DROP INDEX IF EXISTS idx_email_login_tokens_hash;
DROP TABLE IF EXISTS email_login_tokens;

COMMIT;
