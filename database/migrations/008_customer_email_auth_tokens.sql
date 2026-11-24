-- =============================================================================
-- MIGRATION 008: CUSTOMER EMAIL AUTHENTICATION MAGIC-LINK TOKENS
-- Nails by Divya Platform — Phase 2 Customer Passwordless Email Login
--
-- Description:
-- Adds `email_login_tokens` table to store SHA-256 hashed, single-use,
-- short-lived (15 minute) authentication tokens for passwordless email login.
-- Raw login tokens are never persisted in the database.
-- =============================================================================

BEGIN;

CREATE TABLE IF NOT EXISTS email_login_tokens (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    email VARCHAR(255) NOT NULL,
    token_hash VARCHAR(64) NOT NULL UNIQUE,
    expires_at TIMESTAMPTZ NOT NULL,
    used_at TIMESTAMPTZ,
    request_ip INET,
    consumed_ip INET,
    user_agent TEXT,
    created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS idx_email_login_tokens_hash
    ON email_login_tokens(token_hash);

CREATE INDEX IF NOT EXISTS idx_email_login_tokens_email_created
    ON email_login_tokens(LOWER(email), created_at DESC);

CREATE INDEX IF NOT EXISTS idx_email_login_tokens_active_expires
    ON email_login_tokens(expires_at)
    WHERE used_at IS NULL;

COMMIT;
