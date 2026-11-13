/**
 * ==========================================================================
 * REVIEW ROUTER (`src/routes/reviewRoute.js`)
 * Nails by Divya Platform — Public Genuine Reviews API
 *
 * Endpoints:
 * - GET  /api/reviews -> List verified approved customer reviews
 * - POST /api/reviews -> Submit customer feedback (saved as unapproved)
 * ==========================================================================
 */

"use strict";

const express = require("express");
const { listPublicReviews, submitCustomerReview } = require("../services/reviewService");

const router = express.Router();

/**
 * GET /api/reviews
 * Returns genuine, approved client reviews.
 */
router.get("/", async (req, res) => {
  try {
    const result = await listPublicReviews({
      limit: req.query.limit,
      offset: req.query.offset,
    });

    return res.json({
      status: "success",
      ...result,
    });
  } catch (err) {
    const status = err.statusCode || 500;
    return res.status(status).json({
      error: err.message || "Failed to retrieve customer reviews.",
      code: err.code || "REVIEWS_FETCH_FAILED",
    });
  }
});

/**
 * POST /api/reviews
 * Allows clients to submit genuine feedback. Saved with is_approved = FALSE.
 */
router.post("/", async (req, res) => {
  try {
    const review = await submitCustomerReview(req.body);

    return res.status(201).json({
      status: "success",
      message: "Thank you for sharing your feedback! Your review has been submitted for verification.",
      review,
    });
  } catch (err) {
    const status = err.statusCode || 400;
    return res.status(status).json({
      error: err.message || "Failed to submit customer review.",
      code: err.code || "REVIEW_SUBMISSION_FAILED",
    });
  }
});

module.exports = router;
