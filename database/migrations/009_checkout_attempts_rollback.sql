-- Remove checkout retry metadata only. Roll back the keyed-checkout code first.
BEGIN;
DROP TABLE checkout_attempts;
COMMIT;
