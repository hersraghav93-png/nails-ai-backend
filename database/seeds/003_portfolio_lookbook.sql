-- =============================================================================
-- SEED 003: VERIFIED PORTFOLIO DESIGNS (60 ARTWORKS)
-- Source: index.html (#portfolio)
-- =============================================================================

BEGIN;

INSERT INTO portfolio_designs (design_number, name, category_id, image_url, alt_text, is_active) VALUES
(1, 'Sculpted Nude Elegance', 'chrome', 'assets/portfolio/nail1.png', 'Sculpted Nude Elegance', TRUE),
(2, 'Blush French Fade', 'nude', 'assets/portfolio/nail2.png', 'Blush French Fade', TRUE),
(3, '3D Chrome Accents', 'chrome', 'assets/portfolio/nail3.png', '3D Chrome Accents', TRUE),
(4, 'Glass Top Nude', 'nude', 'assets/portfolio/nail4.png', 'Glass Top Nude', TRUE),
(5, 'Minimalist Gold Line', 'nude', 'assets/portfolio/nail5.png', 'Minimalist Gold Line', TRUE),
(6, 'Bridal Pearl Symphony', 'bridal', 'assets/portfolio/nail6.png', 'Bridal Pearl Symphony', TRUE),
(7, 'Rose Garden Floral', 'bridal', 'assets/portfolio/newnail1.png', 'Rose Garden Floral', TRUE),
(8, 'Velvet Cat-Eye Aura', 'chrome', 'assets/portfolio/newnail2.png', 'Velvet Cat-Eye Aura', TRUE),
(9, 'Imperial Gold Foil', 'bridal', 'assets/portfolio/dv1.jpeg', 'Imperial Gold Foil', TRUE),
(10, 'Liquid Silver Ripple', 'chrome', 'assets/portfolio/dv2.jpeg', 'Liquid Silver Ripple', TRUE),
(11, 'Natural Soft Gel Sculpt', 'nude', 'assets/portfolio/dv3.jpeg', 'Natural Soft Gel Sculpt', TRUE),
(12, 'Glazed Chrome Aura', 'chrome', 'assets/portfolio/dv5.jpeg', 'Glazed Chrome Aura', TRUE),
(13, 'Almond Ombré Fade', 'nude', 'assets/portfolio/dv6.jpeg', 'Almond Ombré Fade', TRUE),
(14, 'Gilded Floral French', 'bridal', 'assets/portfolio/dv8.jpeg', 'Gilded Floral French', TRUE),
(15, 'Molten Silver Tip', 'chrome', 'assets/portfolio/dv9.jpeg', 'Molten Silver Tip', TRUE),
(16, 'Sheer Milky Pink', 'nude', 'assets/portfolio/newnail3.png', 'Sheer Milky Pink', TRUE),
(17, 'Metallic Star Burst', 'chrome', 'assets/portfolio/newnail4.png', 'Metallic Star Burst', TRUE),
(18, 'Blossom Pearl Overlay', 'bridal', 'assets/portfolio/newnail5.png', 'Blossom Pearl Overlay', TRUE),
(19, 'Ultra Gloss Polish', 'nude', 'assets/portfolio/newnail6.png', 'Ultra Gloss Russian Polish', TRUE),
(20, 'Delicate French Curve', 'nude', 'assets/portfolio/newnail8.png', 'Delicate French Curve', TRUE),
(21, 'Sapphire Chrome Aura', 'chrome', 'assets/portfolio/nn9.jpeg', 'Sapphire Chrome Aura', TRUE),
(22, 'Sparkling Diamond Veil', 'bridal', 'assets/portfolio/amn1.png', 'Sparkling Diamond Veil', TRUE),
(23, 'Bridal Crystal Cut', 'bridal', 'assets/portfolio/amn2.png', 'Bridal Crystal Cut', TRUE),
(24, 'Royal Kundan Motif', 'bridal', 'assets/portfolio/amn3.png', 'Royal Kundan Motif', TRUE),
(25, 'Sheer Quartz Overlay', 'nude', 'assets/portfolio/nvm1.png', 'Sheer Quartz Overlay', TRUE),
(26, 'Blush Almond Extensions', 'nude', 'assets/portfolio/nvm3.png', 'Blush Almond Extensions', TRUE),
(27, 'Gilded Lace Tip', 'bridal', 'assets/portfolio/nvm4.png', 'Gilded Lace Tip', TRUE),
(28, 'Velvet Emerald Cat-Eye', 'chrome', 'assets/portfolio/nvm5.png', 'Velvet Emerald Cat-Eye', TRUE),
(29, 'Natural Gel Armor', 'nude', 'assets/portfolio/nvm6.png', 'Clean Natural Gel Armor', TRUE),
(30, 'Intricate Floral Sangeet', 'bridal', 'assets/portfolio/nvm7.png', 'Intricate Floral Sangeet', TRUE),
(31, '3D Liquid Silver Art', 'chrome', 'assets/portfolio/nvm8.png', '3D Liquid Silver Art', TRUE),
-- NOTE: Design #32 references nvm9.png in index.html line 1115, but nvm9.png does not exist on disk.
-- Marked is_active = FALSE pending artist asset confirmation. Do not invent an unverified replacement.
(32, 'Pearlescent Wedding Tip', 'bridal', 'assets/portfolio/nvm9.png', 'Pearlescent Wedding Tip [ASSET CONFIRMATION REQUIRED - nvm9.png missing from disk]', FALSE),
(33, 'Galactic Chrome Shift', 'chrome', 'assets/portfolio/nvm10.png', 'Galactic Chrome Shift', TRUE),
(34, 'Structured Gel Overlay', 'nude', 'assets/portfolio/nvm11.png', 'Structured Gel Overlay', TRUE),
(35, 'Empress Pearl Border', 'bridal', 'assets/portfolio/nvm12.png', 'Empress Pearl Border', TRUE),
(36, 'Sheer Rose Manicure', 'nude', 'assets/portfolio/nvm13.png', 'Sheer Rose Manicure', TRUE),
(37, 'Navy Polka Dot', 'art', 'assets/portfolio/port44.jpeg', 'Navy Polka Dot', TRUE),
(38, 'Elegant French Tips', 'nude', 'assets/portfolio/port46.jpeg', 'Elegant French Tips', TRUE),
(39, 'Blush Glitter Extension', 'nude', 'assets/portfolio/port48.jpeg', 'Blush Glitter Extension', TRUE),
(40, 'Shimmering Rose Quartz', 'nude', 'assets/portfolio/port49.jpeg', 'Shimmering Rose Quartz', TRUE),
(41, 'Sparkling Neutral Nude', 'nude', 'assets/portfolio/port51.jpeg', 'Sparkling Neutral Nude', TRUE),
(42, 'Soft Pink Floral', 'art', 'assets/portfolio/port52.jpeg', 'Soft Pink Floral', TRUE),
(43, 'Lavender Pink Sparkle', 'chrome', 'assets/portfolio/port56.jpeg', 'Lavender Pink Sparkle', TRUE),
(44, 'Monochrome Polka Dot', 'art', 'assets/portfolio/port58.jpeg', 'Monochrome Polka Dot', TRUE),
(45, 'Golden Swirl Abstract', 'chrome', 'assets/portfolio/port59.jpeg', 'Golden Swirl Abstract', TRUE),
(46, 'Pastel Dream Gradient', 'bridal', 'assets/portfolio/port60.jpeg', 'Pastel Dream Gradient', TRUE),
(47, 'Metallic Champagne', 'chrome', 'assets/portfolio/port61.jpeg', 'Metallic Champagne', TRUE),
(48, 'Deep Burgundy Chrome', 'chrome', 'assets/portfolio/port62.jpeg', 'Deep Burgundy Chrome', TRUE),
(49, 'Pearl White Elegance', 'bridal', 'assets/portfolio/port63.jpeg', 'Pearl White Elegance', TRUE),
(50, 'Pastel Buttercup Polka', 'art', 'assets/portfolio/10-n9.jpg', 'Pastel Buttercup Polka', TRUE),
(51, 'Sage Meadow Blossom', 'art', 'assets/portfolio/10-n10.jpg', 'Sage Meadow Blossom', TRUE),
(52, 'Blush Dotted Veil', 'nude', 'assets/portfolio/10-n11.jpg', 'Blush Dotted Veil', TRUE),
(53, 'Midnight Petal Blossom', 'bridal', 'assets/portfolio/10-n12c.jpg', 'Midnight Petal Blossom', TRUE),
(54, 'Navy Diagonal French', 'art', 'assets/portfolio/10-n13.jpg', 'Navy Diagonal French', TRUE),
(55, 'Silken Blush Aura', 'chrome', 'assets/portfolio/10-n20c.jpg', 'Silken Blush Aura', TRUE),
(56, 'Mauve Celestial Starlight', 'chrome', 'assets/portfolio/10-n23c.jpg', 'Mauve Celestial Starlight', TRUE),
(57, 'Festive Fuchsia Shimmer', 'bridal', 'assets/portfolio/10-n27.jpg', 'Festive Fuchsia Shimmer', TRUE),
(58, 'Minimalist Crimson Lotus', 'art', 'assets/portfolio/10-n31c.jpg', 'Minimalist Crimson Lotus', TRUE),
(59, 'Ruby Gold Stardust', 'bridal', 'assets/portfolio/10-n34c.jpg', 'Ruby Gold Stardust', TRUE),
(60, 'Cranberry Velvet Constellation', 'bridal', 'assets/portfolio/10-n103.jpg', 'Cranberry Velvet Constellation', TRUE)
ON CONFLICT (design_number) DO NOTHING;

COMMIT;
