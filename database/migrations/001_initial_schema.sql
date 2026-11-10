-- =============================================================================
-- NAILS BY DIVYA — MIGRATION 001: INITIAL COMPLETE RELATIONAL SCHEMA
-- Version: 1.0.0
-- Database: PostgreSQL 15+ (Compatible with Supabase / Neon / Standard PG)
-- Description: Core schema supporting e-commerce, at-home appointments,
--              custom designs, RBAC, decoupled payments, refunds, and audits.
-- =============================================================================

BEGIN;

-- Enable required extensions
CREATE EXTENSION IF NOT EXISTS "pgcrypto";

-- =============================================================================
-- 00. REUSABLE UTILITY FUNCTIONS & TRIGGERS
-- =============================================================================

CREATE OR REPLACE FUNCTION update_timestamp_column()
RETURNS TRIGGER AS $$
BEGIN
    NEW.updated_at = CURRENT_TIMESTAMP;
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

-- Sequence generators for human-readable, safe collision-free reference numbers
CREATE SEQUENCE IF NOT EXISTS order_number_seq START WITH 1001 INCREMENT BY 1;
CREATE SEQUENCE IF NOT EXISTS booking_number_seq START WITH 501 INCREMENT BY 1;
CREATE SEQUENCE IF NOT EXISTS custom_request_seq START WITH 101 INCREMENT BY 1;
CREATE SEQUENCE IF NOT EXISTS quote_number_seq START WITH 101 INCREMENT BY 1;
CREATE SEQUENCE IF NOT EXISTS refund_number_seq START WITH 101 INCREMENT BY 1;

-- =============================================================================
-- 01. IDENTITY, ACCESS CONTROL & AUDIT LOGS
-- =============================================================================

CREATE TABLE users (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    phone VARCHAR(15) UNIQUE,
    phone_verified_at TIMESTAMPTZ,
    email VARCHAR(255) UNIQUE,
    email_verified_at TIMESTAMPTZ,
    password_hash TEXT,
    is_active BOOLEAN NOT NULL DEFAULT TRUE,
    created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE TRIGGER trg_users_updated_at
BEFORE UPDATE ON users
FOR EACH ROW EXECUTE FUNCTION update_timestamp_column();

CREATE TABLE roles (
    id VARCHAR(30) PRIMARY KEY,
    name VARCHAR(100) NOT NULL,
    description TEXT,
    created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE permissions (
    id VARCHAR(60) PRIMARY KEY,
    name VARCHAR(100) NOT NULL,
    description TEXT,
    created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE role_permissions (
    role_id VARCHAR(30) NOT NULL REFERENCES roles(id) ON DELETE CASCADE,
    permission_id VARCHAR(60) NOT NULL REFERENCES permissions(id) ON DELETE CASCADE,
    PRIMARY KEY (role_id, permission_id)
);

CREATE TABLE user_roles (
    user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    role_id VARCHAR(30) NOT NULL REFERENCES roles(id) ON DELETE CASCADE,
    assigned_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    assigned_by UUID REFERENCES users(id) ON DELETE SET NULL,
    PRIMARY KEY (user_id, role_id)
);

CREATE TABLE customer_profiles (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id UUID UNIQUE NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    full_name VARCHAR(100) NOT NULL,
    preferred_nail_shape VARCHAR(30),
    preferred_nail_length VARCHAR(30),
    custom_nail_measurements JSONB,
    sizing_preset VARCHAR(20),
    allergies_or_notes TEXT,
    created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE TRIGGER trg_customer_profiles_updated_at
BEFORE UPDATE ON customer_profiles
FOR EACH ROW EXECUTE FUNCTION update_timestamp_column();

CREATE TABLE admin_profiles (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id UUID UNIQUE NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    display_name VARCHAR(100) NOT NULL,
    totp_secret_encrypted TEXT,
    is_mfa_enabled BOOLEAN NOT NULL DEFAULT FALSE,
    backup_codes_hashed JSONB,
    last_login_ip INET,
    last_login_at TIMESTAMPTZ,
    created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE TRIGGER trg_admin_profiles_updated_at
BEFORE UPDATE ON admin_profiles
FOR EACH ROW EXECUTE FUNCTION update_timestamp_column();

CREATE TABLE user_addresses (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    recipient_name VARCHAR(100) NOT NULL,
    recipient_phone VARCHAR(15) NOT NULL,
    address_line1 TEXT NOT NULL,
    address_line2 TEXT,
    landmark VARCHAR(100),
    city VARCHAR(50) NOT NULL,
    state VARCHAR(50) NOT NULL,
    postal_code VARCHAR(10) NOT NULL,
    is_default_shipping BOOLEAN NOT NULL DEFAULT FALSE,
    is_default_service BOOLEAN NOT NULL DEFAULT FALSE,
    created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX idx_user_addresses_user_id ON user_addresses(user_id);
CREATE INDEX idx_user_addresses_postal ON user_addresses(postal_code);

CREATE TABLE customer_consents (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    phone VARCHAR(15) NOT NULL,
    user_id UUID REFERENCES users(id) ON DELETE SET NULL,
    consent_type VARCHAR(40) NOT NULL,
    is_granted BOOLEAN NOT NULL,
    consent_source VARCHAR(50) NOT NULL,
    ip_address INET,
    user_agent TEXT,
    recorded_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    revoked_at TIMESTAMPTZ,
    CONSTRAINT chk_consent_type CHECK (consent_type IN ('transactional_whatsapp', 'promotional_whatsapp', 'privacy_policy_terms'))
);

CREATE INDEX idx_consents_phone_type ON customer_consents(phone, consent_type);

-- =============================================================================
-- 02. CATALOGUE, PORTFOLIO & FAQS
-- =============================================================================

CREATE TABLE product_categories (
    id VARCHAR(50) PRIMARY KEY,
    name VARCHAR(100) NOT NULL,
    description TEXT,
    display_order INT NOT NULL DEFAULT 0,
    is_active BOOLEAN NOT NULL DEFAULT TRUE
);

CREATE TABLE products (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    sku VARCHAR(30) UNIQUE NOT NULL,
    name VARCHAR(150) NOT NULL,
    slug VARCHAR(150) UNIQUE NOT NULL,
    category_id VARCHAR(50) NOT NULL REFERENCES product_categories(id) ON DELETE RESTRICT,
    base_price NUMERIC(10, 2) NOT NULL,
    description TEXT NOT NULL,
    craftsmanship_details TEXT,
    is_made_to_order BOOLEAN NOT NULL DEFAULT TRUE,
    is_available BOOLEAN NOT NULL DEFAULT TRUE,
    is_archived BOOLEAN NOT NULL DEFAULT FALSE,
    created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT chk_product_base_price CHECK (base_price >= 0)
);

CREATE TRIGGER trg_products_updated_at
BEFORE UPDATE ON products
FOR EACH ROW EXECUTE FUNCTION update_timestamp_column();

CREATE INDEX idx_products_sku ON products(sku);
CREATE INDEX idx_products_slug ON products(slug);
CREATE INDEX idx_products_category ON products(category_id);

CREATE TABLE product_images (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    product_id UUID NOT NULL REFERENCES products(id) ON DELETE CASCADE,
    image_url TEXT NOT NULL,
    alt_text VARCHAR(255) NOT NULL,
    is_hero BOOLEAN NOT NULL DEFAULT FALSE,
    display_order INT NOT NULL DEFAULT 0,
    CONSTRAINT uq_product_images_product_url UNIQUE (product_id, image_url)
);

CREATE INDEX idx_product_images_product_id ON product_images(product_id);

CREATE TABLE product_variants (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    product_id UUID NOT NULL REFERENCES products(id) ON DELETE CASCADE,
    shape VARCHAR(30) NOT NULL,
    length VARCHAR(30) NOT NULL,
    sizing_mode VARCHAR(20) NOT NULL DEFAULT 'custom_or_preset',
    price_adjustment NUMERIC(10, 2) NOT NULL DEFAULT 0.00,
    is_available BOOLEAN NOT NULL DEFAULT TRUE,
    CONSTRAINT chk_price_adjustment CHECK (price_adjustment >= 0)
);

CREATE INDEX idx_product_variants_product_id ON product_variants(product_id);

CREATE TABLE portfolio_categories (
    id VARCHAR(30) PRIMARY KEY,
    name VARCHAR(100) NOT NULL,
    description TEXT
);

CREATE TABLE portfolio_designs (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    design_number INT UNIQUE NOT NULL,
    name VARCHAR(150) NOT NULL,
    category_id VARCHAR(30) NOT NULL REFERENCES portfolio_categories(id) ON DELETE RESTRICT,
    image_url TEXT NOT NULL,
    alt_text VARCHAR(255) NOT NULL,
    is_active BOOLEAN NOT NULL DEFAULT TRUE,
    created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX idx_portfolio_designs_cat ON portfolio_designs(category_id);

CREATE TABLE services (
    id VARCHAR(50) PRIMARY KEY,
    name VARCHAR(100) NOT NULL,
    base_price NUMERIC(10, 2),
    promotional_price NUMERIC(10, 2),
    estimated_duration_minutes INT,
    description TEXT NOT NULL,
    is_active BOOLEAN NOT NULL DEFAULT TRUE,
    CONSTRAINT chk_service_base_price CHECK (base_price IS NULL OR base_price >= 0),
    CONSTRAINT chk_service_promo_price CHECK (promotional_price IS NULL OR promotional_price >= 0),
    CONSTRAINT chk_service_duration CHECK (estimated_duration_minutes IS NULL OR estimated_duration_minutes > 0)
);

CREATE TABLE service_addons (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    service_id VARCHAR(50) NOT NULL REFERENCES services(id) ON DELETE CASCADE,
    name VARCHAR(100) NOT NULL,
    price NUMERIC(10, 2),
    is_active BOOLEAN NOT NULL DEFAULT TRUE,
    CONSTRAINT chk_addon_price CHECK (price IS NULL OR price >= 0),
    CONSTRAINT uq_service_addons_service_name UNIQUE (service_id, name)
);

CREATE TABLE service_areas (
    id VARCHAR(10) PRIMARY KEY,
    city VARCHAR(50) NOT NULL,
    locality VARCHAR(100) NOT NULL,
    is_serviceable BOOLEAN NOT NULL DEFAULT TRUE,
    travel_surcharge NUMERIC(10, 2) NOT NULL DEFAULT 0.00,
    confirmation_policy VARCHAR(40) NOT NULL DEFAULT 'MANUAL_ARTIST_CONFIRMATION',
    notes TEXT,
    CONSTRAINT chk_travel_surcharge CHECK (travel_surcharge >= 0)
);

CREATE TABLE faqs (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    faq_number INT UNIQUE NOT NULL,
    category VARCHAR(50) NOT NULL,
    question TEXT NOT NULL,
    answer TEXT NOT NULL,
    source_page VARCHAR(50) NOT NULL,
    section_anchor VARCHAR(50),
    display_order INT NOT NULL DEFAULT 0,
    is_active BOOLEAN NOT NULL DEFAULT TRUE,
    created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE TRIGGER trg_faqs_updated_at
BEFORE UPDATE ON faqs
FOR EACH ROW EXECUTE FUNCTION update_timestamp_column();

CREATE INDEX idx_faqs_category ON faqs(category);
CREATE INDEX idx_faqs_source_page ON faqs(source_page);

-- =============================================================================
-- 03. WISHLISTS & SHOPPING CARTS
-- =============================================================================

CREATE TABLE wishlists (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id UUID REFERENCES users(id) ON DELETE CASCADE,
    session_token VARCHAR(100),
    created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT chk_wishlist_owner CHECK (user_id IS NOT NULL OR session_token IS NOT NULL)
);

CREATE TABLE wishlist_items (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    wishlist_id UUID NOT NULL REFERENCES wishlists(id) ON DELETE CASCADE,
    product_id UUID NOT NULL REFERENCES products(id) ON DELETE CASCADE,
    added_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    UNIQUE (wishlist_id, product_id)
);

CREATE TABLE carts (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id UUID REFERENCES users(id) ON DELETE SET NULL,
    session_token VARCHAR(100) UNIQUE NOT NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    expires_at TIMESTAMPTZ NOT NULL
);

CREATE TRIGGER trg_carts_updated_at
BEFORE UPDATE ON carts
FOR EACH ROW EXECUTE FUNCTION update_timestamp_column();

CREATE INDEX idx_carts_expires_at ON carts(expires_at);

CREATE TABLE cart_items (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    cart_id UUID NOT NULL REFERENCES carts(id) ON DELETE CASCADE,
    product_id UUID NOT NULL REFERENCES products(id) ON DELETE RESTRICT,
    shape VARCHAR(30) NOT NULL,
    length VARCHAR(30) NOT NULL,
    sizing_preset VARCHAR(20),
    custom_measurements JSONB,
    quantity INT NOT NULL DEFAULT 1,
    created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT chk_cart_quantity CHECK (quantity > 0)
);

-- =============================================================================
-- 04. PROMOTIONS & DISCOUNTS
-- =============================================================================

CREATE TABLE discount_codes (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    code VARCHAR(50) UNIQUE NOT NULL,
    discount_type VARCHAR(20) NOT NULL,
    value NUMERIC(10, 2) NOT NULL,
    minimum_order_value NUMERIC(10, 2) NOT NULL DEFAULT 0.00,
    applies_to VARCHAR(30) NOT NULL DEFAULT 'ALL_PRODUCTS',
    is_stackable BOOLEAN NOT NULL DEFAULT FALSE,
    max_uses_total INT,
    max_uses_per_customer INT NOT NULL DEFAULT 1,
    current_uses INT NOT NULL DEFAULT 0,
    is_first_order_only BOOLEAN NOT NULL DEFAULT FALSE,
    starts_at TIMESTAMPTZ NOT NULL,
    expires_at TIMESTAMPTZ,
    is_active BOOLEAN NOT NULL DEFAULT TRUE,
    created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT chk_discount_type CHECK (discount_type IN ('percentage', 'fixed_amount')),
    CONSTRAINT chk_discount_value CHECK (value >= 0),
    CONSTRAINT chk_min_order_value CHECK (minimum_order_value >= 0),
    CONSTRAINT chk_applies_to CHECK (applies_to IN ('ALL_PRODUCTS', 'SPECIFIC_PRODUCTS', 'SPECIFIC_CATEGORIES', 'AT_HOME_SERVICES_ONLY', 'COMBINED')),
    CONSTRAINT chk_uses_limit CHECK (max_uses_total IS NULL OR max_uses_total > 0),
    CONSTRAINT chk_uses_per_cust CHECK (max_uses_per_customer > 0),
    CONSTRAINT chk_current_uses CHECK (current_uses >= 0)
);

CREATE TABLE discount_code_products (
    discount_code_id UUID NOT NULL REFERENCES discount_codes(id) ON DELETE CASCADE,
    product_id UUID NOT NULL REFERENCES products(id) ON DELETE CASCADE,
    PRIMARY KEY (discount_code_id, product_id)
);

CREATE TABLE discount_code_categories (
    discount_code_id UUID NOT NULL REFERENCES discount_codes(id) ON DELETE CASCADE,
    category_id VARCHAR(50) NOT NULL REFERENCES product_categories(id) ON DELETE CASCADE,
    PRIMARY KEY (discount_code_id, category_id)
);

CREATE TABLE discount_code_services (
    discount_code_id UUID NOT NULL REFERENCES discount_codes(id) ON DELETE CASCADE,
    service_id VARCHAR(50) NOT NULL REFERENCES services(id) ON DELETE CASCADE,
    PRIMARY KEY (discount_code_id, service_id)
);

-- =============================================================================
-- 05. ORDERS, ITEMS & STATUS HISTORY
-- =============================================================================

CREATE TABLE orders (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    order_number VARCHAR(30) UNIQUE NOT NULL,
    user_id UUID REFERENCES users(id) ON DELETE SET NULL,
    guest_session_token VARCHAR(100),
    customer_name VARCHAR(100) NOT NULL,
    customer_phone VARCHAR(15) NOT NULL,
    customer_email VARCHAR(255),
    shipping_address JSONB NOT NULL,
    subtotal NUMERIC(10, 2) NOT NULL,
    discount_amount NUMERIC(10, 2) NOT NULL DEFAULT 0.00,
    discount_code_id UUID REFERENCES discount_codes(id) ON DELETE SET NULL,
    shipping_fee NUMERIC(10, 2) NOT NULL DEFAULT 0.00,
    total_amount NUMERIC(10, 2) NOT NULL,
    currency VARCHAR(5) NOT NULL DEFAULT 'INR',
    order_status VARCHAR(30) NOT NULL DEFAULT 'PENDING',
    payment_status VARCHAR(30) NOT NULL DEFAULT 'PENDING',
    fulfilment_status VARCHAR(30) NOT NULL DEFAULT 'UNFULFILLED',
    guest_claim_hash VARCHAR(64),
    claimed_at TIMESTAMPTZ,
    claimed_by_user_id UUID REFERENCES users(id) ON DELETE SET NULL,
    customer_notes TEXT,
    artist_internal_notes TEXT,
    created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT chk_subtotal CHECK (subtotal >= 0),
    CONSTRAINT chk_discount_amount CHECK (discount_amount >= 0),
    CONSTRAINT chk_shipping_fee CHECK (shipping_fee >= 0),
    CONSTRAINT chk_total_amount CHECK (total_amount >= 0),
    CONSTRAINT chk_order_status CHECK (order_status IN ('PENDING', 'CONFIRMED', 'IN_PRODUCTION', 'COMPLETED', 'CANCELLED')),
    CONSTRAINT chk_payment_status CHECK (payment_status IN ('PENDING', 'INITIATED', 'VERIFIED', 'FAILED', 'MANUAL_VERIFY_REQ', 'PARTIALLY_REFUNDED', 'REFUNDED')),
    CONSTRAINT chk_fulfilment_status CHECK (fulfilment_status IN ('UNFULFILLED', 'READY_FOR_DISPATCH', 'DISPATCHED', 'DELIVERED', 'RETURNED'))
);

CREATE TRIGGER trg_orders_updated_at
BEFORE UPDATE ON orders
FOR EACH ROW EXECUTE FUNCTION update_timestamp_column();

CREATE INDEX idx_orders_customer_phone ON orders(customer_phone);
CREATE INDEX idx_orders_user_id ON orders(user_id);
CREATE INDEX idx_orders_status ON orders(order_status);
CREATE INDEX idx_orders_claim_hash ON orders(guest_claim_hash) WHERE guest_claim_hash IS NOT NULL;

CREATE TABLE order_items (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    order_id UUID NOT NULL REFERENCES orders(id) ON DELETE CASCADE,
    product_id UUID REFERENCES products(id) ON DELETE SET NULL,
    product_name VARCHAR(150) NOT NULL,
    sku VARCHAR(30) NOT NULL,
    unit_price NUMERIC(10, 2) NOT NULL,
    quantity INT NOT NULL DEFAULT 1,
    total_price NUMERIC(10, 2) NOT NULL,
    variant_details JSONB NOT NULL,
    CONSTRAINT chk_unit_price CHECK (unit_price >= 0),
    CONSTRAINT chk_quantity CHECK (quantity > 0),
    CONSTRAINT chk_total_price CHECK (total_price >= 0)
);

CREATE INDEX idx_order_items_order_id ON order_items(order_id);

CREATE TABLE order_status_history (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    order_id UUID NOT NULL REFERENCES orders(id) ON DELETE CASCADE,
    status_type VARCHAR(30) NOT NULL,
    from_status VARCHAR(30),
    to_status VARCHAR(30) NOT NULL,
    actor_type VARCHAR(20) NOT NULL,
    actor_id UUID,
    notes TEXT,
    created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT chk_status_type CHECK (status_type IN ('order', 'fulfilment', 'refund')),
    CONSTRAINT chk_actor_type CHECK (actor_type IN ('customer', 'operator', 'divya', 'system', 'webhook'))
);

CREATE INDEX idx_order_status_history_order ON order_status_history(order_id, created_at);

CREATE TABLE discount_redemptions (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    discount_code_id UUID NOT NULL REFERENCES discount_codes(id) ON DELETE RESTRICT,
    order_id UUID NOT NULL REFERENCES orders(id) ON DELETE CASCADE,
    user_id UUID REFERENCES users(id) ON DELETE SET NULL,
    phone VARCHAR(15) NOT NULL,
    discount_amount_applied NUMERIC(10, 2) NOT NULL,
    redeemed_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT chk_discount_applied CHECK (discount_amount_applied >= 0)
);

CREATE INDEX idx_discount_redemptions_code_phone ON discount_redemptions(discount_code_id, phone);

CREATE TABLE shipments (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    order_id UUID NOT NULL REFERENCES orders(id) ON DELETE RESTRICT,
    courier_name VARCHAR(50) NOT NULL,
    tracking_number VARCHAR(100) NOT NULL,
    tracking_url TEXT,
    dispatched_at TIMESTAMPTZ,
    delivered_at TIMESTAMPTZ,
    created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE order_claim_attempts (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    order_id UUID REFERENCES orders(id) ON DELETE CASCADE,
    attempted_by_user_id UUID REFERENCES users(id) ON DELETE SET NULL,
    attempted_phone VARCHAR(15) NOT NULL,
    ip_address INET,
    user_agent TEXT,
    is_successful BOOLEAN NOT NULL,
    failure_reason VARCHAR(50),
    attempted_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT chk_claim_failure_reason CHECK (
        is_successful = TRUE OR failure_reason IS NOT NULL
    )
);

CREATE INDEX idx_claim_attempts_user ON order_claim_attempts(attempted_by_user_id, attempted_at);
CREATE INDEX idx_claim_attempts_ip ON order_claim_attempts(ip_address, attempted_at);
CREATE INDEX idx_claim_attempts_order ON order_claim_attempts(order_id);

-- =============================================================================
-- 06. APPOINTMENTS (AT-HOME SERVICES)
-- =============================================================================

CREATE TABLE bookings (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    booking_number VARCHAR(30) UNIQUE NOT NULL,
    user_id UUID REFERENCES users(id) ON DELETE SET NULL,
    guest_session_token VARCHAR(100),
    customer_name VARCHAR(100) NOT NULL,
    customer_phone VARCHAR(15) NOT NULL,
    customer_email VARCHAR(255),
    service_id VARCHAR(50) NOT NULL REFERENCES services(id) ON DELETE RESTRICT,
    service_address JSONB NOT NULL,
    postal_code VARCHAR(10) NOT NULL,
    service_area_id VARCHAR(10) REFERENCES service_areas(id) ON DELETE SET NULL DEFAULT 'DELHI-NCR',
    requested_date DATE NOT NULL,
    requested_time_slot VARCHAR(30) NOT NULL,
    alternative_proposed_date DATE,
    alternative_proposed_time_slot VARCHAR(30),
    reschedule_reason TEXT,
    confirmed_start_time TIMESTAMPTZ,
    confirmed_end_time TIMESTAMPTZ,
    booking_status VARCHAR(30) NOT NULL DEFAULT 'REQUESTED',
    payment_status VARCHAR(30) NOT NULL DEFAULT 'PENDING',
    estimated_total NUMERIC(10, 2) NOT NULL,
    customer_notes TEXT,
    artist_private_notes TEXT,
    created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT chk_estimated_total CHECK (estimated_total >= 0),
    CONSTRAINT chk_booking_status CHECK (booking_status IN ('REQUESTED', 'DIVYA_REVIEWING', 'ALTERNATIVE_PROPOSED', 'CONFIRMED', 'IN_PROGRESS', 'COMPLETED', 'DECLINED', 'CANCELLED_BY_CUSTOMER', 'CANCELLED_BY_ARTIST'))
);

CREATE TRIGGER trg_bookings_updated_at
BEFORE UPDATE ON bookings
FOR EACH ROW EXECUTE FUNCTION update_timestamp_column();

CREATE OR REPLACE FUNCTION invalidate_prior_booking_tokens()
RETURNS TRIGGER AS $$
BEGIN
    IF NEW.booking_status = 'ALTERNATIVE_PROPOSED' AND
       (OLD.alternative_proposed_date IS DISTINCT FROM NEW.alternative_proposed_date OR
        OLD.alternative_proposed_time_slot IS DISTINCT FROM NEW.alternative_proposed_time_slot) THEN
        UPDATE booking_action_tokens
        SET expires_at = CURRENT_TIMESTAMP
        WHERE booking_id = NEW.id
          AND used_at IS NULL
          AND expires_at > CURRENT_TIMESTAMP;
    END IF;
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER trg_invalidate_prior_booking_tokens
BEFORE UPDATE OF alternative_proposed_date, alternative_proposed_time_slot, booking_status ON bookings
FOR EACH ROW EXECUTE FUNCTION invalidate_prior_booking_tokens();

CREATE INDEX idx_bookings_customer_phone ON bookings(customer_phone);
CREATE INDEX idx_bookings_user_id ON bookings(user_id);
CREATE INDEX idx_bookings_status ON bookings(booking_status);

CREATE TABLE booking_status_history (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    booking_id UUID NOT NULL REFERENCES bookings(id) ON DELETE CASCADE,
    from_status VARCHAR(30),
    to_status VARCHAR(30) NOT NULL,
    actor_type VARCHAR(20) NOT NULL,
    actor_id UUID,
    notes TEXT,
    created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT chk_booking_actor CHECK (actor_type IN ('customer', 'divya', 'operator', 'system'))
);

CREATE INDEX idx_booking_history_booking ON booking_status_history(booking_id, created_at);

CREATE TABLE booking_action_tokens (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    booking_id UUID NOT NULL REFERENCES bookings(id) ON DELETE CASCADE,
    action_type VARCHAR(30) NOT NULL,
    token_hash VARCHAR(64) UNIQUE NOT NULL,
    expires_at TIMESTAMPTZ NOT NULL,
    used_at TIMESTAMPTZ,
    created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT chk_token_action CHECK (action_type IN ('ACCEPT_ALTERNATIVE', 'DECLINE_ALTERNATIVE', 'CANCEL_APPOINTMENT'))
);

CREATE INDEX idx_booking_action_tokens_hash ON booking_action_tokens(token_hash);

-- =============================================================================
-- 07. CUSTOM DESIGN REQUESTS & QUOTES
-- =============================================================================

CREATE TABLE custom_design_requests (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    request_number VARCHAR(30) UNIQUE NOT NULL,
    user_id UUID REFERENCES users(id) ON DELETE SET NULL,
    guest_session_token VARCHAR(100),
    customer_name VARCHAR(100) NOT NULL,
    customer_phone VARCHAR(15) NOT NULL,
    intended_format VARCHAR(30) NOT NULL,
    preferred_shape VARCHAR(30),
    preferred_length VARCHAR(30),
    design_description TEXT NOT NULL,
    status VARCHAR(30) NOT NULL DEFAULT 'PENDING_REVIEW',
    created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT chk_intended_format CHECK (intended_format IN ('press_on_delivery', 'at_home_appointment')),
    CONSTRAINT chk_custom_status CHECK (status IN ('PENDING_REVIEW', 'CLARIFICATION_REQUESTED', 'QUOTE_ISSUED', 'QUOTE_ACCEPTED', 'CONVERTED_TO_ORDER', 'CONVERTED_TO_BOOKING', 'DECLINED'))
);

CREATE TRIGGER trg_custom_design_requests_updated_at
BEFORE UPDATE ON custom_design_requests
FOR EACH ROW EXECUTE FUNCTION update_timestamp_column();

CREATE TABLE custom_request_images (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    request_id UUID NOT NULL REFERENCES custom_design_requests(id) ON DELETE CASCADE,
    storage_path TEXT NOT NULL,
    file_size_bytes INT NOT NULL,
    mime_type VARCHAR(50) NOT NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT chk_image_size CHECK (file_size_bytes > 0 AND file_size_bytes <= 10485760),
    CONSTRAINT chk_image_mime CHECK (mime_type IN ('image/jpeg', 'image/png', 'image/webp'))
);

CREATE TABLE custom_quotes (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    request_id UUID NOT NULL REFERENCES custom_design_requests(id) ON DELETE CASCADE,
    quote_number VARCHAR(30) UNIQUE NOT NULL,
    total_quoted_amount NUMERIC(10, 2) NOT NULL,
    valid_until TIMESTAMPTZ NOT NULL,
    artist_notes TEXT,
    status VARCHAR(30) NOT NULL DEFAULT 'ISSUED',
    created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT chk_quoted_amount CHECK (total_quoted_amount >= 0),
    CONSTRAINT chk_quote_status CHECK (status IN ('ISSUED', 'ACCEPTED', 'DECLINED', 'EXPIRED'))
);

CREATE TABLE custom_quote_items (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    quote_id UUID NOT NULL REFERENCES custom_quotes(id) ON DELETE CASCADE,
    item_description VARCHAR(200) NOT NULL,
    amount NUMERIC(10, 2) NOT NULL,
    CONSTRAINT chk_item_amount CHECK (amount >= 0)
);

-- =============================================================================
-- 08. PAYMENTS & REFUNDS LEDGER
-- =============================================================================

CREATE TABLE payments (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    order_id UUID REFERENCES orders(id) ON DELETE RESTRICT,
    booking_id UUID REFERENCES bookings(id) ON DELETE RESTRICT,
    custom_quote_id UUID REFERENCES custom_quotes(id) ON DELETE RESTRICT,
    payment_method VARCHAR(30) NOT NULL,
    gateway_order_id VARCHAR(100) UNIQUE,
    gateway_payment_id VARCHAR(100) UNIQUE,
    amount NUMERIC(10, 2) NOT NULL,
    currency VARCHAR(5) NOT NULL DEFAULT 'INR',
    status VARCHAR(30) NOT NULL DEFAULT 'PENDING',
    gateway_signature TEXT,
    idempotency_key VARCHAR(100) UNIQUE NOT NULL,
    verified_at TIMESTAMPTZ,
    created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT chk_payment_amount CHECK (amount > 0),
    CONSTRAINT chk_payment_method CHECK (payment_method IN ('razorpay', 'manual_upi', 'cash')),
    CONSTRAINT chk_payment_status_values CHECK (status IN ('PENDING', 'INITIATED', 'VERIFIED', 'FAILED', 'MANUAL_VERIFY_REQ', 'PARTIALLY_REFUNDED', 'REFUNDED')),
    CONSTRAINT chk_payment_single_parent CHECK (
        (CASE WHEN order_id IS NOT NULL THEN 1 ELSE 0 END +
         CASE WHEN booking_id IS NOT NULL THEN 1 ELSE 0 END +
         CASE WHEN custom_quote_id IS NOT NULL THEN 1 ELSE 0 END) = 1
    )
);

CREATE INDEX idx_payments_order ON payments(order_id);
CREATE INDEX idx_payments_booking ON payments(booking_id);
CREATE INDEX idx_payments_quote ON payments(custom_quote_id);

CREATE TABLE payment_events (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    gateway VARCHAR(30) NOT NULL DEFAULT 'razorpay',
    event_id VARCHAR(100) UNIQUE NOT NULL,
    event_type VARCHAR(100) NOT NULL,
    payload JSONB NOT NULL,
    signature TEXT NOT NULL,
    is_verified BOOLEAN NOT NULL,
    processed_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE refunds (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    refund_number VARCHAR(30) UNIQUE NOT NULL,
    payment_id UUID NOT NULL REFERENCES payments(id) ON DELETE RESTRICT,
    order_id UUID REFERENCES orders(id) ON DELETE RESTRICT,
    booking_id UUID REFERENCES bookings(id) ON DELETE RESTRICT,
    gateway VARCHAR(30) NOT NULL DEFAULT 'razorpay',
    gateway_refund_id VARCHAR(100) UNIQUE,
    amount NUMERIC(10, 2) NOT NULL,
    currency VARCHAR(5) NOT NULL DEFAULT 'INR',
    reason TEXT NOT NULL,
    status VARCHAR(30) NOT NULL DEFAULT 'PENDING',
    requested_by UUID REFERENCES users(id) ON DELETE SET NULL,
    approved_by UUID REFERENCES users(id) ON DELETE SET NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    processed_at TIMESTAMPTZ,
    CONSTRAINT chk_refund_amount CHECK (amount > 0),
    CONSTRAINT chk_refund_status CHECK (status IN ('PENDING', 'INITIATED', 'PROCESSED', 'FAILED'))
);

CREATE TRIGGER trg_refunds_updated_at
BEFORE UPDATE ON refunds
FOR EACH ROW EXECUTE FUNCTION update_timestamp_column();

CREATE OR REPLACE FUNCTION check_and_reserve_refund()
RETURNS TRIGGER AS $$
DECLARE
    v_payment RECORD;
    v_reserved_refunds NUMERIC(10, 2);
    v_available_refundable NUMERIC(10, 2);
BEGIN
    -- 1. Concurrency control: Lock the parent payment row exclusively.
    -- This serializes any concurrent refund requests on the same payment.
    SELECT id, amount, status, payment_method
    INTO v_payment
    FROM payments
    WHERE id = NEW.payment_id
    FOR UPDATE;

    IF NOT FOUND THEN
        RAISE EXCEPTION 'Parent payment record % does not exist', NEW.payment_id;
    END IF;

    -- Ensure parent payment is in a refundable state
    IF v_payment.status NOT IN ('VERIFIED', 'PARTIALLY_REFUNDED') THEN
        RAISE EXCEPTION 'Payment % is not in a refundable status (current status: %)',
            NEW.payment_id, v_payment.status;
    END IF;

    -- 2. If the new refund status is FAILED, it consumes 0 refundable balance
    IF NEW.status = 'FAILED' THEN
        RETURN NEW;
    END IF;

    -- 3. Calculate all existing reserved refunds (PENDING, INITIATED, PROCESSED)
    -- Exclude FAILED refunds, and exclude the current row if this is an UPDATE.
    SELECT COALESCE(SUM(amount), 0.00)
    INTO v_reserved_refunds
    FROM refunds
    WHERE payment_id = NEW.payment_id
      AND status IN ('PENDING', 'INITIATED', 'PROCESSED')
      AND (TG_OP = 'INSERT' OR id != NEW.id);

    v_available_refundable := v_payment.amount - v_reserved_refunds;

    -- 4. Check if the new/updated refund amount exceeds available refundable balance
    IF NEW.amount > v_available_refundable THEN
        RAISE EXCEPTION 'Requested refund amount ₹% exceeds remaining refundable balance ₹% (Total captured: ₹%, Already reserved/refunded: ₹%)',
            NEW.amount, v_available_refundable, v_payment.amount, v_reserved_refunds;
    END IF;

    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER trg_refund_concurrency_ceiling
BEFORE INSERT OR UPDATE OF amount, status, payment_id ON refunds
FOR EACH ROW EXECUTE FUNCTION check_and_reserve_refund();

CREATE OR REPLACE FUNCTION sync_payment_refund_status()
RETURNS TRIGGER AS $$
DECLARE
    v_payment_amount NUMERIC(10, 2);
    v_total_processed NUMERIC(10, 2);
BEGIN
    IF NEW.status = 'PROCESSED' AND (TG_OP = 'INSERT' OR OLD.status != 'PROCESSED') THEN
        SELECT amount INTO v_payment_amount FROM payments WHERE id = NEW.payment_id;
        SELECT COALESCE(SUM(amount), 0.00) INTO v_total_processed
        FROM refunds
        WHERE payment_id = NEW.payment_id AND status = 'PROCESSED';

        IF v_total_processed >= v_payment_amount THEN
            UPDATE payments SET status = 'REFUNDED' WHERE id = NEW.payment_id;
        ELSE
            UPDATE payments SET status = 'PARTIALLY_REFUNDED' WHERE id = NEW.payment_id;
        END IF;
    END IF;
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER trg_sync_payment_refund_status
AFTER INSERT OR UPDATE OF status ON refunds
FOR EACH ROW EXECUTE FUNCTION sync_payment_refund_status();

CREATE INDEX idx_refunds_payment_id ON refunds(payment_id);

CREATE TABLE refund_events (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    refund_id UUID NOT NULL REFERENCES refunds(id) ON DELETE CASCADE,
    event_type VARCHAR(50) NOT NULL,
    gateway_event_id VARCHAR(100) UNIQUE NOT NULL,
    payload JSONB NOT NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP
);

-- =============================================================================
-- 09. LOYALTY PROGRAM (DISABLED BY DEFAULT VIA BUSINESS SETTING)
-- =============================================================================

CREATE TABLE loyalty_accounts (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id UUID UNIQUE NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    current_points_balance INT NOT NULL DEFAULT 0,
    lifetime_points_earned INT NOT NULL DEFAULT 0,
    tier VARCHAR(20) NOT NULL DEFAULT 'BRONZE',
    created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT chk_points_balance CHECK (current_points_balance >= 0)
);

CREATE TABLE loyalty_transactions (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    account_id UUID NOT NULL REFERENCES loyalty_accounts(id) ON DELETE CASCADE,
    transaction_type VARCHAR(20) NOT NULL,
    points INT NOT NULL,
    reference_order_id UUID REFERENCES orders(id) ON DELETE SET NULL,
    notes TEXT,
    created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT chk_loyalty_txn_type CHECK (transaction_type IN ('EARNED', 'REDEEMED', 'REVERSED_REFUND', 'ADJUSTMENT', 'EXPIRED'))
);

-- =============================================================================
-- 10. NOTIFICATIONS, WHATSAPP & AUDIT
-- =============================================================================

CREATE TABLE notification_jobs (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    channel VARCHAR(20) NOT NULL DEFAULT 'whatsapp',
    recipient_phone VARCHAR(15) NOT NULL,
    template_name VARCHAR(100) NOT NULL,
    template_variables JSONB NOT NULL,
    priority INT NOT NULL DEFAULT 5,
    status VARCHAR(20) NOT NULL DEFAULT 'QUEUED',
    retry_count INT NOT NULL DEFAULT 0,
    max_retries INT NOT NULL DEFAULT 3,
    scheduled_for TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    idempotency_key VARCHAR(100) UNIQUE NOT NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT chk_notif_status CHECK (status IN ('QUEUED', 'PROCESSING', 'SENT', 'FAILED', 'CANCELLED')),
    CONSTRAINT chk_notif_priority CHECK (priority BETWEEN 1 AND 10)
);

CREATE INDEX idx_notification_jobs_dispatch ON notification_jobs(status, scheduled_for);

CREATE TABLE notification_delivery_logs (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    job_id UUID NOT NULL REFERENCES notification_jobs(id) ON DELETE CASCADE,
    provider_message_id VARCHAR(100) UNIQUE,
    delivery_status VARCHAR(30) NOT NULL,
    error_code VARCHAR(50),
    error_message TEXT,
    updated_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE audit_logs (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    actor_id UUID REFERENCES users(id) ON DELETE SET NULL,
    actor_role VARCHAR(30) NOT NULL,
    action VARCHAR(100) NOT NULL,
    target_entity VARCHAR(50) NOT NULL,
    target_id VARCHAR(100) NOT NULL,
    diff JSONB,
    ip_address INET,
    created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX idx_audit_logs_actor ON audit_logs(actor_id);
CREATE INDEX idx_audit_logs_target ON audit_logs(target_entity, target_id);

CREATE TABLE business_settings (
    key VARCHAR(100) PRIMARY KEY,
    value JSONB NOT NULL,
    description TEXT,
    updated_by UUID REFERENCES users(id) ON DELETE SET NULL,
    updated_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE TRIGGER trg_business_settings_updated_at
BEFORE UPDATE ON business_settings
FOR EACH ROW EXECUTE FUNCTION update_timestamp_column();

COMMIT;
