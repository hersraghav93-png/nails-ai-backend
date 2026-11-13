/**
 * ==========================================================================
 * ANALYTICS ROUTE (`src/routes/analyticsRoute.js`)
 * Nails by Divya Platform — Phase 5.2.1
 *
 * Public ingestion endpoint for privacy-safe business events.
 * ==========================================================================
 */

"use strict";

const express = require("express");
const router = express.Router();
const { recordEvent } = require("../services/analyticsService");

/**
 * POST /api/analytics/events
 * Records and daily-aggregates a whitelisted event (zero PII, zero tokens).
 */
router.post("/events", async (req, res) => {
  try {
    const result = await recordEvent(req.body);
    return res.status(200).json(result);
  } catch (err) {
    const status = err.statusCode || 400;
    return res.status(status).json({
      error: err.message || "Failed to record analytics event.",
      code: "ANALYTICS_EVENT_REJECTED",
    });
  }
});

module.exports = router;
