-- ==============================================================================
-- ROLLBACK 007: Remove Provisioned Owner Raghav
-- ==============================================================================

DELETE FROM user_roles
WHERE user_id IN (SELECT id FROM users WHERE phone = '+917827437985');

DELETE FROM admin_profiles
WHERE user_id IN (SELECT id FROM users WHERE phone = '+917827437985');

DELETE FROM users
WHERE phone = '+917827437985';
