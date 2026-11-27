-- Manual release step. The startup migrator does not include this file.
BEGIN;

CREATE TABLE checkout_attempts (
    -- SHA-256 of buyer type, verified account ID or guest session, and retry key.
    attempt_hash TEXT PRIMARY KEY,
    request_hash TEXT NOT NULL,
    -- A receipt must survive expiry, claim, merge and removal of its cart.
    cart_id UUID NOT NULL,
    order_id UUID NOT NULL UNIQUE REFERENCES orders(id) ON DELETE CASCADE
);

COMMIT;
