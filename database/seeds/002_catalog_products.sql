-- =============================================================================
-- SEED 002: VERIFIED CATALOG PRODUCTS (22 PRESS-ON SETS)
-- Sources: script.js (PRODUCT_PRICES) & index.html (#shop)
-- =============================================================================

BEGIN;

INSERT INTO products (sku, name, slug, category_id, base_price, description, craftsmanship_details, is_made_to_order, is_available) VALUES
-- Wedding & Bridal Collection (7)
('WED-005', 'Rosewood Bloom', 'rosewood-bloom', 'wedding', 999.00,
 'Delicate white floral overlays hand-painted over sheer rosewood gel. Perfect for weddings and sangeet celebrations.',
 'Custom hand-crafted with salon-grade soft gel, tailored to custom nail sizing. Complete 10-piece set with full prep kit.', TRUE, TRUE),

('WED-001', 'Pearl Blossom', 'pearl-blossom', 'wedding', 999.00,
 'Translucent ivory gel infused with micro-pearl shimmer and sculpted 3D petal details for timeless elegance.',
 'Custom hand-crafted with salon-grade soft gel, tailored to custom nail sizing. Complete 10-piece set with full prep kit.', TRUE, TRUE),

('WED-002', 'Golden Empress', 'golden-empress', 'wedding', 799.00,
 'Intricate 24K gold metallic foil accents layered over sheer milky white gel. Designed for royal Indian festivities.',
 'Custom hand-crafted with salon-grade soft gel, tailored to custom nail sizing. Complete 10-piece set with full prep kit.', TRUE, TRUE),

('WED-006', 'Blush Lace Symphony', 'blush-lace-symphony', 'wedding', 1399.00,
 'Soft blush ombré base with fine hand-painted French lace tips. An immaculate choice for receptions and engagements.',
 'Custom hand-crafted with salon-grade soft gel, tailored to custom nail sizing. Complete 10-piece set with full prep kit.', TRUE, TRUE),

('WED-007', 'Champagne Aura', 'champagne-aura', 'wedding', 1299.00,
 'Warm champagne chrome fade with encapsulated glitter dust. Radiant under evening chandelier lighting.',
 'Custom hand-crafted with salon-grade soft gel, tailored to custom nail sizing. Complete 10-piece set with full prep kit.', TRUE, TRUE),

('WED-008', 'Maharaja Velvet', 'maharaja-velvet', 'wedding', 699.00,
 'Rich crimson cat-eye velvet gel with gold zari-inspired metallic borders. Bold, traditional, and captivating.',
 'Custom hand-crafted with salon-grade soft gel, tailored to custom nail sizing. Complete 10-piece set with full prep kit.', TRUE, TRUE),

('WED-009', 'Ivory Diamond Veil', 'ivory-diamond-veil', 'wedding', 1399.00,
 'Pristine ivory French tips encrusted with Swarovski-inspired crystal placements at the cuticle line.',
 'Custom hand-crafted with salon-grade soft gel, tailored to custom nail sizing. Complete 10-piece set with full prep kit.', TRUE, TRUE),

-- Party & Evening Collection (6)
('PAR-003', 'Bordeaux Veil', 'bordeaux-veil', 'party', 1299.00,
 'Deep wine red gel with precision gold metallic threadwork. Commands instant attention at evening celebrations and dinners.',
 'Custom hand-crafted with salon-grade soft gel, tailored to custom nail sizing. Complete 10-piece set with full prep kit.', TRUE, TRUE),

('PAR-004', 'Midnight Chrome', 'midnight-chrome', 'party', 1299.00,
 'Sultry obsidian black gel topped with color-shifting emerald and sapphire mirror chrome.',
 'Custom hand-crafted with salon-grade soft gel, tailored to custom nail sizing. Complete 10-piece set with full prep kit.', TRUE, TRUE),

('PAR-008', 'Crimson Glaze', 'crimson-glaze', 'party', 999.00,
 'Vibrant ruby red jelly gel layered with ultra-gloss top coat for a high-fashion wet glass finish.',
 'Custom hand-crafted with salon-grade soft gel, tailored to custom nail sizing. Complete 10-piece set with full prep kit.', TRUE, TRUE),

('PAR-009', 'Electric Lavender', 'electric-lavender', 'party', 1199.00,
 'Bold violet cat-eye gel with mesmerizing silver aura highlights that shift with every movement.',
 'Custom hand-crafted with salon-grade soft gel, tailored to custom nail sizing. Complete 10-piece set with full prep kit.', TRUE, TRUE),

('PAR-0010', 'Starlight Metallic', 'starlight-metallic', 'party', 1299.00,
 'Sheer nude base with hand-sculpted silver chrome stars and celestial constellations.',
 'Custom hand-crafted with salon-grade soft gel, tailored to custom nail sizing. Complete 10-piece set with full prep kit.', TRUE, TRUE),

('PAR-0011', 'Leopard French', 'leopard-french', 'party', 799.00,
 'A refined French set with hand-painted leopard detailing along the tips, kept soft and wearable over a natural nude base.',
 'Custom hand-crafted with salon-grade soft gel, tailored to custom nail sizing. Complete 10-piece set with full prep kit.', TRUE, TRUE),

-- Office & Daily Collection (5)
('WORK-004', 'Velvet Pearl', 'velvet-pearl', 'office', 999.00,
 'Luminous glazed chrome over soft blush pink gel. Clean, sophisticated, and engineered for effortless everyday wear.',
 'Custom hand-crafted with salon-grade soft gel, tailored to custom nail sizing. Complete 10-piece set with full prep kit.', TRUE, TRUE),

('WORK-002', 'Classic Micro French', 'classic-micro-french', 'office', 1099.00,
 'Natural pink camouflage gel paired with ultra-thin precision white smile lines. Understated and professional.',
 'Custom hand-crafted with salon-grade soft gel, tailored to custom nail sizing. Complete 10-piece set with full prep kit.', TRUE, TRUE),

('WORK-003', 'Milky Almond Cloud', 'milky-almond-cloud', 'office', 799.00,
 'Translucent milky white gel in a flattering soft almond silhouette that lengthens fingers naturally.',
 'Custom hand-crafted with salon-grade soft gel, tailored to custom nail sizing. Complete 10-piece set with full prep kit.', TRUE, TRUE),

('WORK-006', 'Rose Quartz Polish', 'rose-quartz-polish', 'office', 1199.00,
 'Semi-sheer rosy quartz gel with subtle internal marbling effect inspired by natural gemstones.',
 'Custom hand-crafted with salon-grade soft gel, tailored to custom nail sizing. Complete 10-piece set with full prep kit.', TRUE, TRUE),

('WORK-007', 'Soft Mauve Silk', 'soft-mauve-silk', 'office', 1299.00,
 'Muted dusty mauve gel with a velvety satin matte finish. Versatile and effortlessly chic.',
 'Custom hand-crafted with salon-grade soft gel, tailored to custom nail sizing. Complete 10-piece set with full prep kit.', TRUE, TRUE),

-- Casual & Statement Artistry (4)
('CAS-005', 'Silver Petal', 'silver-petal', 'casual', 799.00,
 'Icy silver-blue chrome tips with 3D sculpted floral petals. A standout statement set handcrafted to your preferred length.',
 'Custom hand-crafted with salon-grade soft gel, tailored to custom nail sizing. Complete 10-piece set with full prep kit.', TRUE, TRUE),

('CAS-004', 'Molten Chrome Ripple', 'molten-chrome-ripple', 'casual', 899.00,
 'Hand-formed 3D liquid silver ripples flowing over sheer blush gel. High texture and dimensional artistry.',
 'Custom hand-crafted with salon-grade soft gel, tailored to custom nail sizing. Complete 10-piece set with full prep kit.', TRUE, TRUE),

('CAS-007', 'Celestial Opal 3D', 'celestial-opal-3d', 'casual', 1199.00,
 'Opal-infused builder gel sculpted with organic water-droplet textures that catch light beautifully.',
 'Custom hand-crafted with salon-grade soft gel, tailored to custom nail sizing. Complete 10-piece set with full prep kit.', TRUE, TRUE),

('CAS-008', 'Glazed Aura Chrome', 'glazed-aura-chrome', 'casual', 1199.00,
 'Ultra-reflective chrome powder buffed over pink gel with hand-painted aura centers.',
 'Custom hand-crafted with salon-grade soft gel, tailored to custom nail sizing. Complete 10-piece set with full prep kit.', TRUE, TRUE)
ON CONFLICT (sku) DO NOTHING;

-- Attach Hero Images to Products
INSERT INTO product_images (product_id, image_url, alt_text, is_hero, display_order)
SELECT id, 'assets/products/wedding/WED-005/herowedd5.png', 'Rosewood Bloom handmade press-on nail set', TRUE, 0 FROM products WHERE sku = 'WED-005'
UNION ALL
SELECT id, 'assets/products/wedding/WED-001/herowedd1.png', 'Pearl Blossom handmade press-on nail set', TRUE, 0 FROM products WHERE sku = 'WED-001'
UNION ALL
SELECT id, 'assets/products/wedding/WED-002/herowedd2.png', 'Golden Empress handmade press-on nail set', TRUE, 0 FROM products WHERE sku = 'WED-002'
UNION ALL
SELECT id, 'assets/products/wedding/WED-006/herowedd6.jpg', 'Blush Lace Symphony handmade press-on nail set', TRUE, 0 FROM products WHERE sku = 'WED-006'
UNION ALL
SELECT id, 'assets/products/wedding/WED-007/herowedd7.jpg', 'Champagne Aura handmade press-on nail set', TRUE, 0 FROM products WHERE sku = 'WED-007'
UNION ALL
SELECT id, 'assets/products/wedding/WED-008/herowedd8.jpg', 'Maharaja Velvet handmade press-on nail set', TRUE, 0 FROM products WHERE sku = 'WED-008'
UNION ALL
SELECT id, 'assets/products/wedding/WED-009/herowedd9.png', 'Ivory Diamond Veil handmade press-on nail set', TRUE, 0 FROM products WHERE sku = 'WED-009'
UNION ALL
SELECT id, 'assets/products/party/PAR-003/heroparty3.jpg', 'Bordeaux Veil handmade press-on nail set', TRUE, 0 FROM products WHERE sku = 'PAR-003'
UNION ALL
SELECT id, 'assets/products/party/PAR-004/heroparty4.jpg', 'Midnight Chrome handmade press-on nail set', TRUE, 0 FROM products WHERE sku = 'PAR-004'
UNION ALL
SELECT id, 'assets/products/party/PAR-008/heroparty8.jpg', 'Crimson Glaze handmade press-on nail set', TRUE, 0 FROM products WHERE sku = 'PAR-008'
UNION ALL
SELECT id, 'assets/products/party/PAR-009/heroparty9.jpg', 'Electric Lavender handmade press-on nail set', TRUE, 0 FROM products WHERE sku = 'PAR-009'
UNION ALL
SELECT id, 'assets/products/party/PAR-0010/heroparty10.jpg', 'Starlight Metallic handmade press-on nail set', TRUE, 0 FROM products WHERE sku = 'PAR-0010'
UNION ALL
SELECT id, 'assets/products/party/PAR-0011/PAR-0011.png', 'Leopard French handmade press-on nail set', TRUE, 0 FROM products WHERE sku = 'PAR-0011'
UNION ALL
SELECT id, 'assets/products/work/WORK-004/herowork4.jpg', 'Velvet Pearl handmade press-on nail set', TRUE, 0 FROM products WHERE sku = 'WORK-004'
UNION ALL
SELECT id, 'assets/products/work/WORK-002/herowork2.jpg', 'Classic Micro French handmade press-on nail set', TRUE, 0 FROM products WHERE sku = 'WORK-002'
UNION ALL
SELECT id, 'assets/products/work/WORK-003/herowork3.jpg', 'Milky Almond Cloud handmade press-on nail set', TRUE, 0 FROM products WHERE sku = 'WORK-003'
UNION ALL
SELECT id, 'assets/products/work/WORK-006/herowork6.jpg', 'Rose Quartz Polish handmade press-on nail set', TRUE, 0 FROM products WHERE sku = 'WORK-006'
UNION ALL
SELECT id, 'assets/products/work/WORK-007/herowork7.jpg', 'Soft Mauve Silk handmade press-on nail set', TRUE, 0 FROM products WHERE sku = 'WORK-007'
UNION ALL
SELECT id, 'assets/products/casual/CAS-005/herocasual5.jpg', 'Silver Petal handmade press-on nail set', TRUE, 0 FROM products WHERE sku = 'CAS-005'
UNION ALL
SELECT id, 'assets/products/casual/CAS-004/herocasual4.jpg', 'Molten Chrome Ripple handmade press-on nail set', TRUE, 0 FROM products WHERE sku = 'CAS-004'
UNION ALL
SELECT id, 'assets/products/casual/CAS-007/herocasual7.jpg', 'Celestial Opal 3D handmade press-on nail set', TRUE, 0 FROM products WHERE sku = 'CAS-007'
UNION ALL
SELECT id, 'assets/products/casual/CAS-008/herocasual8.jpg', 'Glazed Aura Chrome handmade press-on nail set', TRUE, 0 FROM products WHERE sku = 'CAS-008'
ON CONFLICT (product_id, image_url) DO NOTHING;

COMMIT;
