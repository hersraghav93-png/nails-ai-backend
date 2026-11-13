/**
 * ==========================================================================
 * PRODUCT ROUTER (`src/routes/productRoute.js`)
 * Nails by Divya Platform — Storefront Public Catalog API
 *
 * REST API Endpoints for public product catalog:
 * - GET /api/products        -> List all active press-on sets with images & pricing
 * - GET /api/products/:sku   -> Get detailed product by SKU with variants & gallery
 * ==========================================================================
 */

"use strict";

const express = require("express");
const { query } = require("../db/pool");
const { calculateItemPricing } = require("../services/pricingEngine");

const router = express.Router();

/**
 * GET /api/products
 * Retrieves active products with primary images, category, base price, and active promotional pricing.
 */
router.get("/", async (req, res) => {
  try {
    const { category, search, limit = 50, offset = 0 } = req.query;
    const safeLimit = Math.min(Math.max(parseInt(limit, 10) || 50, 1), 100);
    const safeOffset = Math.max(parseInt(offset, 10) || 0, 0);

    const whereConditions = ["p.is_archived = FALSE"];
    const params = [];
    let paramIdx = 1;

    if (category && typeof category === "string" && category.trim()) {
      whereConditions.push(`(p.category_id = $${paramIdx} OR pc.id = $${paramIdx} OR pc.name ILIKE $${paramIdx})`);
      params.push(category.trim());
      paramIdx++;
    }

    if (search && typeof search === "string" && search.trim()) {
      whereConditions.push(`(p.name ILIKE $${paramIdx} OR p.sku ILIKE $${paramIdx} OR p.description ILIKE $${paramIdx})`);
      params.push(`%${search.trim()}%`);
      paramIdx++;
    }

    const whereClause = `WHERE ${whereConditions.join(" AND ")}`;

    const countRes = await query(
      `SELECT COUNT(*)::int AS total 
       FROM products p 
       JOIN product_categories pc ON pc.id = p.category_id 
       ${whereClause};`,
      params
    );
    const total = countRes.rows[0] ? countRes.rows[0].total : 0;

    const productsRes = await query(
      `SELECT
         p.id,
         p.category_id,
         pc.name AS category_name,
         p.sku,
         p.name,
         p.slug,
         p.description,
         p.craftsmanship_details,
         p.base_price,
         p.is_available,
         p.is_made_to_order,
         p.created_at,
         COALESCE(
           (SELECT image_url FROM product_images WHERE product_id = p.id AND is_hero = TRUE LIMIT 1),
           (SELECT image_url FROM product_images WHERE product_id = p.id ORDER BY display_order ASC LIMIT 1)
         ) AS primary_image_url
       FROM products p
       JOIN product_categories pc ON pc.id = p.category_id
       ${whereClause}
       ORDER BY p.created_at ASC
       LIMIT $${paramIdx++} OFFSET $${paramIdx++};`,
      [...params, safeLimit, safeOffset]
    );

    const productIds = productsRes.rows.map((p) => p.id);
    const variantsByProduct = {};

    if (productIds.length > 0) {
      const variantsRes = await query(
        `SELECT product_id, shape, length, sizing_mode, price_adjustment, is_available
         FROM product_variants
         WHERE product_id = ANY($1) AND is_available = TRUE
         ORDER BY shape ASC, length ASC;`,
        [productIds]
      );
      for (const v of variantsRes.rows) {
        if (!variantsByProduct[v.product_id]) {
          variantsByProduct[v.product_id] = [];
        }
        variantsByProduct[v.product_id].push({
          shape: v.shape,
          length: v.length,
          sizingMode: v.sizing_mode,
          priceAdjustment: parseFloat(v.price_adjustment) || 0,
        });
      }
    }

    const products = productsRes.rows.map((p) => {
      const pricing = calculateItemPricing(p, 1);
      return {
        id: p.id,
        sku: p.sku,
        name: p.name,
        slug: p.slug,
        categoryId: p.category_id,
        categoryName: p.category_name,
        description: p.description,
        craftsmanshipDetails: p.craftsmanship_details,
        basePrice: pricing.basePrice,
        effectivePrice: pricing.unitPrice,
        isPromoApplied: pricing.isPromoApplied,
        promoName: pricing.promoName,
        isAvailable: p.is_available,
        isMadeToOrder: p.is_made_to_order,
        primaryImageUrl: p.primary_image_url,
        variants: variantsByProduct[p.id] || [],
      };
    });

    return res.json({
      status: "success",
      count: products.length,
      total,
      products,
    });
  } catch (err) {
    return res.status(500).json({
      error: err.message || "Failed to retrieve products.",
      code: "PRODUCTS_FETCH_FAILED",
    });
  }
});

/**
 * GET /api/products/:sku
 * Retrieves detailed product by SKU or ID with image gallery and available variants.
 */
router.get("/:sku", async (req, res) => {
  try {
    const { sku } = req.params;
    if (!sku || typeof sku !== "string") {
      return res.status(400).json({
        error: "Product SKU or ID is required.",
        code: "SKU_REQUIRED",
      });
    }

    const cleanSku = sku.trim();
    const productRes = await query(
      `SELECT
         p.id,
         p.category_id,
         pc.name AS category_name,
         p.sku,
         p.name,
         p.slug,
         p.description,
         p.craftsmanship_details,
         p.base_price,
         p.is_available,
         p.is_made_to_order,
         p.created_at,
         p.updated_at
       FROM products p
       JOIN product_categories pc ON pc.id = p.category_id
       WHERE (UPPER(p.sku) = UPPER($1) OR p.id::text = $1) AND p.is_archived = FALSE;`,
      [cleanSku]
    );

    if (productRes.rows.length === 0) {
      return res.status(404).json({
        error: `Product '${cleanSku}' was not found.`,
        code: "PRODUCT_NOT_FOUND",
      });
    }

    const product = productRes.rows[0];

    // Images
    const imagesRes = await query(
      `SELECT id, image_url, alt_text, is_hero, display_order
       FROM product_images
       WHERE product_id = $1
       ORDER BY display_order ASC, is_hero DESC;`,
      [product.id]
    );

    // Variants
    const variantsRes = await query(
      `SELECT id, shape, length, sizing_mode, price_adjustment, is_available
       FROM product_variants
       WHERE product_id = $1 AND is_available = TRUE
       ORDER BY shape ASC, length ASC;`,
      [product.id]
    );

    const pricing = calculateItemPricing(product, 1);

    return res.json({
      status: "success",
      product: {
        id: product.id,
        sku: product.sku,
        name: product.name,
        slug: product.slug,
        categoryId: product.category_id,
        categoryName: product.category_name,
        description: product.description,
        craftsmanshipDetails: product.craftsmanship_details,
        basePrice: pricing.basePrice,
        effectivePrice: pricing.unitPrice,
        isPromoApplied: pricing.isPromoApplied,
        promoName: pricing.promoName,
        isAvailable: product.is_available,
        isMadeToOrder: product.is_made_to_order,
        images: imagesRes.rows.map((img) => ({
          id: img.id,
          imageUrl: img.image_url,
          altText: img.alt_text,
          isHero: img.is_hero,
          displayOrder: img.display_order,
        })),
        variants: variantsRes.rows.map((v) => ({
          id: v.id,
          shape: v.shape,
          length: v.length,
          sizingMode: v.sizing_mode,
          priceAdjustment: parseFloat(v.price_adjustment) || 0,
        })),
      },
    });
  } catch (err) {
    return res.status(500).json({
      error: err.message || "Failed to retrieve product details.",
      code: "PRODUCT_FETCH_FAILED",
    });
  }
});

module.exports = router;
