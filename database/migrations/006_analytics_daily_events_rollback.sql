-- =============================================================================
-- ROLLBACK 006: ANALYTICS DAILY EVENTS
-- Nails by Divya Platform — Phase 5.2.1
-- =============================================================================

BEGIN;

DROP TRIGGER IF EXISTS trg_analytics_daily_events_updated_at ON analytics_daily_events;
DROP TABLE IF EXISTS analytics_daily_events CASCADE;

COMMIT;
