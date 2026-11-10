-- =============================================================================
-- SEED 001: ROLES, PERMISSIONS, CATEGORIES & BASELINE SERVICES
-- =============================================================================

BEGIN;

-- 1. Roles
INSERT INTO roles (id, name, description) VALUES
('super_operator', 'Super Operator / Business Owner', 'Full operational, configuration, and financial control'),
('artist_divya', 'Lead Nail Artist (Divya)', 'Full authority over catalog availability, orders, bookings, and custom design quotes'),
('staff_artist', 'Staff Assistant Artist', 'Assigned order fulfillment and appointment assistance'),
('support_staff', 'Customer Support Assistant', 'Customer inquiries and basic order status tracking')
ON CONFLICT (id) DO NOTHING;

-- 2. Core Permissions
INSERT INTO permissions (id, name, description) VALUES
('catalog:view', 'View Catalog', 'View products, services, and inventory settings'),
('catalog:edit_details', 'Edit Catalog Details', 'Modify product descriptions, photos, and variants'),
('catalog:edit_base_pricing', 'Edit Base Pricing', 'Modify product and service base price values'),
('catalog:toggle_availability', 'Toggle Availability', 'Mark products or services available/unavailable'),
('orders:read', 'View Orders', 'View order list, shipping addresses, and items'),
('orders:update_status', 'Update Order Fulfillment', 'Advance orders from in-production to dispatched'),
('orders:refund', 'Process Refunds', 'Issue full or partial financial refunds on orders'),
('bookings:read', 'View Bookings', 'View calendar and appointment requests'),
('bookings:approve_decline', 'Confirm or Decline Bookings', 'Approve, decline, or reschedule appointment slots'),
('quotes:create', 'Create Custom Quotes', 'Create and issue itemized custom design quotes'),
('discounts:manage', 'Manage Promotions', 'Create, update, and deactivate discount codes'),
('staff:manage', 'Manage Staff Accounts', 'Create user accounts and assign staff roles'),
('financials:view', 'View Financial Analytics', 'View revenue, average order value, and gateway payouts'),
('audit:view', 'View Audit Logs', 'Inspect immutable audit logs'),
('config:edit', 'Edit Platform Configuration', 'Modify operational business settings')
ON CONFLICT (id) DO NOTHING;

-- 3. Role Permissions Mapping
-- Super Operator has all permissions
INSERT INTO role_permissions (role_id, permission_id)
SELECT 'super_operator', id FROM permissions
ON CONFLICT DO NOTHING;

-- Artist Divya Permissions
INSERT INTO role_permissions (role_id, permission_id) VALUES
('artist_divya', 'catalog:view'),
('artist_divya', 'catalog:edit_details'),
('artist_divya', 'catalog:edit_base_pricing'),
('artist_divya', 'catalog:toggle_availability'),
('artist_divya', 'orders:read'),
('artist_divya', 'orders:update_status'),
('artist_divya', 'bookings:read'),
('artist_divya', 'bookings:approve_decline'),
('artist_divya', 'quotes:create'),
('artist_divya', 'discounts:manage')
ON CONFLICT DO NOTHING;

-- Staff Artist Permissions
INSERT INTO role_permissions (role_id, permission_id) VALUES
('staff_artist', 'catalog:view'),
('staff_artist', 'orders:read'),
('staff_artist', 'orders:update_status'),
('staff_artist', 'bookings:read')
ON CONFLICT DO NOTHING;

-- 4. Product Categories
INSERT INTO product_categories (id, name, description, display_order, is_active) VALUES
('wedding', 'Wedding & Bridal Collection', 'Intricate 24K gold foil, French lace, and pearl accents for festive and bridal celebrations', 1, TRUE),
('party', 'Party & Evening Collection', 'Liquid chrome, cat-eye velvet, and celestial starlight statements for celebrations', 2, TRUE),
('office', 'Office & Daily Wear Collection', 'Understated micro-French, glazed chrome, and sheer milky almond silhouettes for daily wear', 3, TRUE),
('casual', 'Casual & Statement Artistry', '3D sculpted ripples, molten chrome, and dimensional fluid effects', 4, TRUE)
ON CONFLICT (id) DO NOTHING;

-- 5. Portfolio Categories
INSERT INTO portfolio_categories (id, name, description) VALUES
('chrome', '3D Chrome & Metallic Accents', 'Liquid silver, reflective chrome, and dimensional metallic accents'),
('nude', 'Minimalist Nude, Sheer & Natural Overlays', 'Understated French fades, milky glazes, and minimalist line details'),
('bridal', 'Bridal, Wedding & Festive Elegance', 'Gold foil, zari borders, Swarovski-inspired crystals, and velvet gems'),
('art', 'Creative Hand-Painted Nail Art & Patterns', 'Floral motifs, intricate linework, and outfit-matched bespoke artistry')
ON CONFLICT (id) DO NOTHING;

-- 6. Services Menu
INSERT INTO services (id, name, base_price, promotional_price, estimated_duration_minutes, description, is_active) VALUES
('gel_extensions', 'Bespoke Gel Extensions', NULL, 999.00, 120, 'Sculpted tips using professional soft gel or polygel. Lightweight, durable, and tailored to custom length and shape.', TRUE),
('natural_overlay', 'Natural Nail Overlay & Strengthening', NULL, 999.00, 90, 'Structured gel layer applied directly over natural nails to add strength, prevent breaking, and provide a flawless chip-free canvas.', TRUE),
('power_polish', 'Signature Manicure & Power Polish', NULL, 999.00, 60, 'Precision Russian cuticle cleanup, nail shaping, and long-lasting gel polish application staying ultra-shiny for 3+ weeks.', TRUE),
('custom_3d_art', '3D, Chrome & Custom Artistry', NULL, NULL, 60, 'Custom hand-painted floral motifs, glazed chrome aura effects, French ombré fades, or 3D textured accents tailored to your outfit.', TRUE),
('extension_removal', 'Nail Extension Removal', NULL, NULL, 45, 'Gentle, damage-free professional soak-off and conditioning removal for existing sets.', TRUE)
ON CONFLICT (id) DO NOTHING;

-- 7. Service Add-ons (Prices unverified - kept unset pending operator approval)
INSERT INTO service_addons (service_id, name, price, is_active) VALUES
('gel_extensions', 'French Tip Precision Detailing', NULL, TRUE),
('gel_extensions', 'Liquid Chrome Mirror Finish', NULL, TRUE),
('natural_overlay', '3D Dimensional Art Accents (Per Pair)', NULL, TRUE)
ON CONFLICT (service_id, name) DO NOTHING;

-- 8. Baseline Service Area (Delhi NCR Freelance Artist Manual Confirmation)
-- NOTE: The website specifies at-home service coverage across Delhi NCR localities
-- (Delhi, Gurgaon, Noida, South Delhi, Central Delhi, Aerocity).
-- Unverified specific PIN-code restrictions have been removed to prevent arbitrary exclusions.
-- Customers can submit booking requests with any PIN code for manual review and confirmation by Divya.
INSERT INTO service_areas (id, city, locality, is_serviceable, travel_surcharge, confirmation_policy, notes) VALUES
('DELHI-NCR', 'Delhi NCR', 'Delhi NCR Locality (Artist Manual Review)', TRUE, 0.00, 'MANUAL_ARTIST_CONFIRMATION', 'General Delhi NCR coverage; appointment feasibility and schedule confirmed directly by Divya')
ON CONFLICT (id) DO NOTHING;

COMMIT;
