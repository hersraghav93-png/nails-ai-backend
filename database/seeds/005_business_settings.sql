-- =============================================================================
-- SEED 005: DEFAULT BUSINESS SETTINGS & SYSTEM CONFIGURATION
-- Nails by Divya - Operational parameters, safety toggles, and compliance rules
-- All unresolved business policies are captured here as configurable settings.
-- =============================================================================

BEGIN;

INSERT INTO business_settings (key, value, description) VALUES
(
    'loyalty_program',
    '{"enabled": false, "status": "PENDING_BUSINESS_APPROVAL", "points_per_inr": 0, "redemption_rate_inr": 0, "notes": "Strictly disabled until business policies for earning, redemption, and expiry are formally approved."}'::jsonb,
    'Controls loyalty points accumulation and redemption. Disabled by default.'
),
(
    'guest_order_claim',
    '{"claim_secret_length_bytes": 16, "hash_algorithm": "SHA-256", "max_failed_attempts_per_hour": 5, "time_window_enforced": false, "claim_window_days": null, "status": "PENDING_BUSINESS_APPROVAL", "notes": "Claim secret hashing is enforced. Time-based cutoff is disabled/pending business policy approval."}'::jsonb,
    'Security controls for claiming historical guest orders into new registered accounts.'
),
(
    'service_area_policy',
    '{"policy": "MANUAL_ARTIST_CONFIRMATION", "allow_unlisted_delhi_ncr_pincodes": true, "default_travel_fee": null, "status": "PROVISIONAL_PENDING_DIVYA_APPROVAL", "notes": "Freelance artist model: Divya manually reviews scheduling and travel feasibility per location via WhatsApp/phone."}'::jsonb,
    'Service area coverage rules and manual artist appointment review policy.'
),
(
    'cancellation_grace_window',
    '{"press_on_cancellation_window_hours": null, "service_cancellation_window_hours": null, "status": "PENDING_BUSINESS_CONFIRMATION", "notes": "Existing policy states cancellations only possible before production begins. Exact cutoff window pending operator confirmation."}'::jsonb,
    'Grace period during which customers may cancel press-on orders or appointment bookings.'
),
(
    'custom_design_upload',
    '{"max_file_size_bytes": 10485760, "max_files_per_quote": 5, "allowed_mime_types": ["image/jpeg", "image/png", "image/webp"]}'::jsonb,
    'Upload constraints for customer inspiration and custom quote image attachments (10MB max).'
),
(
    'booking_action_token',
    '{"token_validity_hours": 24, "max_reschedule_attempts": 2, "single_use_enforced": true, "auto_invalidate_prior_on_reschedule": true}'::jsonb,
    'TTL, replay-prevention, and auto-invalidation constraints for booking action tokens.'
),
(
    'shipping_policy',
    '{"pricing_model": "location_based_manual_confirmation", "free_shipping_threshold_inr": null, "notes": "FAQ 17: Delivery charges calculated based on location and kept separate from product price."}'::jsonb,
    'Shipping cost rules for nationwide delivery of press-on nails.'
),
(
    'service_travel_fee',
    '{"pricing_model": "manual_location_confirmation", "base_fee_inr": null, "covered_regions": ["Delhi", "Gurgaon", "Noida", "South Delhi", "Central Delhi", "Aerocity"]}'::jsonb,
    'Travel fee configuration for at-home salon visits across Delhi NCR.'
),
(
    'dpdp_privacy_and_consent',
    '{"retention_days_guest_orders": 2555, "transactional_notifications_enabled": true, "promotional_opt_in_default": false, "notes": "DPDP compliance: consent revocation must never cancel existing active orders or bookings."}'::jsonb,
    'Privacy rules, retention periods (7 years for tax/accounting records), and consent management.'
)
ON CONFLICT (key) DO UPDATE
SET value = EXCLUDED.value,
    description = EXCLUDED.description,
    updated_at = CURRENT_TIMESTAMP;

COMMIT;
