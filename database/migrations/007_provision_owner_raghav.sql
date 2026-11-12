-- ==============================================================================
-- MIGRATION 007: Provision Owner Raghav and Configure Admin Profiles
-- Nails by Divya Platform — Phase 5.4 Three-Role Account Architecture
--
-- 1. Provisions Owner (Raghav, +917827437985) with role 'super_operator'.
--    firebase_uid is set to NULL to allow seamless first-time phone OTP binding.
-- 2. Ensures Lead Artist (Divya, +918447391310) retains 'artist_divya' and has
--    admin_profile display_name set to 'Divya'.
-- ==============================================================================

-- 1. Provision Raghav (Owner)
INSERT INTO users (id, phone, firebase_uid, phone_verified_at, is_active)
VALUES (
    '78274379-8500-4000-8000-000000000001',
    '+917827437985',
    NULL,
    CURRENT_TIMESTAMP,
    TRUE
)
ON CONFLICT (phone) DO UPDATE
SET is_active = TRUE,
    updated_at = CURRENT_TIMESTAMP;

INSERT INTO user_roles (user_id, role_id)
SELECT id, 'super_operator'
FROM users
WHERE phone = '+917827437985'
ON CONFLICT (user_id, role_id) DO NOTHING;

INSERT INTO admin_profiles (user_id, display_name, is_mfa_enabled)
SELECT id, 'Raghav', TRUE
FROM users
WHERE phone = '+917827437985'
ON CONFLICT (user_id) DO UPDATE
SET display_name = 'Raghav',
    updated_at = CURRENT_TIMESTAMP;

-- 2. Configure Divya (Lead Artist) admin profile
INSERT INTO admin_profiles (user_id, display_name, is_mfa_enabled)
SELECT id, 'Divya', TRUE
FROM users
WHERE phone = '+918447391310'
ON CONFLICT (user_id) DO UPDATE
SET display_name = 'Divya',
    updated_at = CURRENT_TIMESTAMP;
