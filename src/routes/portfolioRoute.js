/**
 * ==========================================================================
 * PORTFOLIO ROUTER (`src/routes/portfolioRoute.js`)
 * Nails by Divya Platform — Public Portfolio & Lookbook API
 *
 * Endpoints:
 * - GET /api/portfolio            -> List active portfolio artworks with categories & filters
 * - GET /api/portfolio/categories -> List portfolio categories
 * ==========================================================================
 */

"use strict";

const express = require("express");
const { query } = require("../db/pool");

const router = express.Router();

/**
 * GET /api/portfolio
 * Retrieves active approved lookbook designs.
 */
router.get("/", async (req, res) => {
  try {
    const { category, filter, search, limit = 100, offset = 0 } = req.query;
    const safeLimit = Math.min(Math.max(parseInt(limit, 10) || 100, 1), 200);
    const safeOffset = Math.max(parseInt(offset, 10) || 0, 0);

    const activeCat = category || filter;

    const whereConditions = ["pd.is_active = TRUE"];
    const params = [];
    let paramIdx = 1;

    if (activeCat && typeof activeCat === "string" && activeCat.trim() && activeCat.trim().toLowerCase() !== "all") {
      whereConditions.push(`(pd.category_id = $${paramIdx} OR pc.id = $${paramIdx} OR pc.name ILIKE $${paramIdx})`);
      params.push(activeCat.trim());
      paramIdx++;
    }

    if (search && typeof search === "string" && search.trim()) {
      whereConditions.push(`(pd.name ILIKE $${paramIdx} OR pd.alt_text ILIKE $${paramIdx})`);
      params.push(`%${search.trim()}%`);
      paramIdx++;
    }

    const whereClause = `WHERE ${whereConditions.join(" AND ")}`;

    const countRes = await query(
      `SELECT COUNT(*)::int AS total
       FROM portfolio_designs pd
       JOIN portfolio_categories pc ON pc.id = pd.category_id
       ${whereClause};`,
      params
    );
    const total = countRes.rows[0] ? countRes.rows[0].total : 0;

    const designsRes = await query(
      `SELECT
         pd.id,
         pd.design_number,
         pd.name,
         pd.category_id,
         pc.name AS category_name,
         pd.image_url,
         pd.alt_text,
         pd.is_active,
         pd.created_at
       FROM portfolio_designs pd
       JOIN portfolio_categories pc ON pc.id = pd.category_id
       ${whereClause}
       ORDER BY pd.design_number ASC
       LIMIT $${paramIdx++} OFFSET $${paramIdx++};`,
      [...params, safeLimit, safeOffset]
    );

    const categoriesRes = await query(`SELECT id, name, description FROM portfolio_categories ORDER BY id ASC;`);

    return res.json({
      status: "success",
      total,
      artworks: designsRes.rows,
      categories: categoriesRes.rows,
      limit: safeLimit,
      offset: safeOffset,
    });
  } catch (err) {
    const status = err.statusCode || 500;
    return res.status(status).json({
      error: err.message || "Failed to retrieve portfolio designs.",
      code: err.code || "PORTFOLIO_FETCH_FAILED",
    });
  }
});

/**
 * GET /api/portfolio/categories
 * Returns all portfolio categories.
 */
router.get("/categories", async (req, res) => {
  try {
    const result = await query(`SELECT id, name, description FROM portfolio_categories ORDER BY id ASC;`);
    return res.json({
      status: "success",
      categories: result.rows,
    });
  } catch (err) {
    return res.status(500).json({
      error: "Failed to retrieve portfolio categories.",
      code: "PORTFOLIO_CATEGORIES_FAILED",
    });
  }
});

module.exports = router;
