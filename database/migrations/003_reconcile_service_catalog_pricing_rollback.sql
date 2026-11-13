-- =============================================================================
-- MIGRATION 003 ROLLBACK: REVERT SERVICE CATALOG PRICING & DESCRIPTIONS
-- Phase 4B.1 Rollback
-- =============================================================================

BEGIN;

-- Revert core services to NULL base prices
UPDATE services
SET 
    base_price = NULL,
    promotional_price = 999.00
WHERE id IN ('gel_extensions', 'natural_overlay');

-- Revert power polish to NULL base price and legacy description
UPDATE services
SET 
    base_price = NULL,
    promotional_price = 999.00,
    description = 'Precision Russian cuticle cleanup, nail shaping, and long-lasting gel polish application staying ultra-shiny for 3+ weeks.'
WHERE id = 'power_polish';

-- Custom quote services remain NULL
UPDATE services
SET 
    base_price = NULL,
    promotional_price = NULL
WHERE id IN ('custom_3d_art', 'extension_removal');

COMMIT;
