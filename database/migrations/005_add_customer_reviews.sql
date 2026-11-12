-- =============================================================================
-- MIGRATION 005: Customer Reviews & Moderation Schema
-- Nails by Divya Platform — Phase 5.1B
--
-- 1. Creates customer_reviews table with unapproved default status
-- 2. Inserts 'reviews:moderate' permission
-- 3. Grants 'reviews:moderate' to 'super_operator' and 'artist_divya'
-- =============================================================================

-- 1. Create customer reviews table
CREATE TABLE IF NOT EXISTS customer_reviews (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    order_id UUID REFERENCES orders(id) ON DELETE SET NULL,
    booking_id UUID REFERENCES bookings(id) ON DELETE SET NULL,
    customer_name VARCHAR(150) NOT NULL,
    customer_phone VARCHAR(20),
    customer_email VARCHAR(255),
    rating INT NOT NULL CHECK (rating >= 1 AND rating <= 5),
    title VARCHAR(200),
    review_text TEXT NOT NULL,
    service_or_product_tag VARCHAR(100),
    source VARCHAR(50) NOT NULL DEFAULT 'storefront',
    is_approved BOOLEAN NOT NULL DEFAULT FALSE,
    moderated_by UUID REFERENCES users(id) ON DELETE SET NULL,
    moderated_at TIMESTAMPTZ,
    moderation_notes TEXT,
    created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS idx_customer_reviews_approved ON customer_reviews(is_approved);
CREATE INDEX IF NOT EXISTS idx_customer_reviews_created ON customer_reviews(created_at DESC);

-- Automatic timestamp trigger
DROP TRIGGER IF EXISTS trg_customer_reviews_updated_at ON customer_reviews;
CREATE TRIGGER trg_customer_reviews_updated_at
BEFORE UPDATE ON customer_reviews
FOR EACH ROW EXECUTE FUNCTION update_timestamp_column();

-- 2. Insert fine-grained permission for review moderation
INSERT INTO permissions (id, name, description) VALUES
('reviews:moderate', 'Moderate Customer Reviews', 'Approve, reject, and moderate submitted customer reviews and testimonials')
ON CONFLICT (id) DO NOTHING;

-- 3. Map permission to authorized roles (Super Operator and Artist Divya)
INSERT INTO role_permissions (role_id, permission_id) VALUES
('super_operator', 'reviews:moderate'),
('artist_divya', 'reviews:moderate')
ON CONFLICT DO NOTHING;
