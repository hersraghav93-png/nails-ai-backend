-- =============================================================================
-- MIGRATION 003: RECONCILE SERVICE CATALOG PRICING & DESCRIPTIONS
-- Phase 4B.1: Service Catalog Alignment with Approved Canonical Offerings
-- =============================================================================

BEGIN;

-- 1. Bespoke Gel Extensions: Base ₹1499, Promotional ₹999
UPDATE services
SET 
    base_price = 1499.00,
    promotional_price = 999.00
WHERE id = 'gel_extensions';

-- 2. Natural Nail Overlay & Strengthening: Base ₹1299, Promotional ₹999
UPDATE services
SET 
    base_price = 1299.00,
    promotional_price = 999.00
WHERE id = 'natural_overlay';

-- 3. Signature Manicure & Power Polish: Base ₹1199, Promotional ₹999, Sanitize description
UPDATE services
SET 
    base_price = 1199.00,
    promotional_price = 999.00,
    description = 'A polished, high-gloss gel manicure service on natural nails for clients seeking long-lasting vibrant colour without tip extensions.'
WHERE id = 'power_polish';

-- 4. Custom Quote Services: Ensure base and promotional prices remain explicitly NULL
UPDATE services
SET 
    base_price = NULL,
    promotional_price = NULL
WHERE id IN ('custom_3d_art', 'extension_removal');

COMMIT;
