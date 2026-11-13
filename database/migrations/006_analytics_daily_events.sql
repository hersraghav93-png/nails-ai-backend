-- =============================================================================
-- MIGRATION 006: ANALYTICS DAILY EVENTS (PRIVACY-SAFE OPERATIONAL AGGREGATES)
-- Nails by Divya Platform — Phase 5.2.1
--
-- Provides dedicated, high-performance daily aggregation for 6 core events:
-- product_view, add_to_cart, checkout_start, order_submission,
-- booking_submission, whatsapp_click.
-- Strictly zero PII, zero tokens, zero third-party tracking.
-- NOTE: Authored for staging deployment upon explicit operator approval.
-- DO NOT APPLY TO DATABASE WITHOUT EXPLICIT OPERATOR APPROVAL.
-- =============================================================================

BEGIN;

CREATE TABLE IF NOT EXISTS analytics_daily_events (
    event_date DATE NOT NULL,
    event_name VARCHAR(50) NOT NULL,
    event_count INTEGER NOT NULL DEFAULT 0 CHECK (event_count >= 0),
    created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    PRIMARY KEY (event_date, event_name),
    CONSTRAINT chk_analytics_event_name CHECK (
        event_name IN (
            'product_view',
            'add_to_cart',
            'checkout_start',
            'order_submission',
            'booking_submission',
            'whatsapp_click'
        )
    )
);

CREATE INDEX IF NOT EXISTS idx_analytics_daily_date
ON analytics_daily_events (event_date DESC);

CREATE TRIGGER trg_analytics_daily_events_updated_at
BEFORE UPDATE ON analytics_daily_events
FOR EACH ROW EXECUTE FUNCTION update_timestamp_column();

COMMIT;
