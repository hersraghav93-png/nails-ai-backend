const express = require("express");
const CONFIG = require("../config");
const { generateChatReply, reloadKnowledge } = require("../services/aiService");
const { buildKnowledgeDatabase } = require("../builder/knowledgeBuilder");

/**
 * ==========================================================================
 * EXPRESS ROUTER (`src/routes/chatRoute.js`)
 * Manages API endpoints for chat interactions and dynamic knowledge rebuilds.
 * ==========================================================================
 */

const router = express.Router();

/**
 * GET /
 * Health check endpoint verifying server and AI readiness.
 */
router.get("/", (req, res) => {
  res.json({
    status: "healthy",
    service: "Nails by Divya AI Knowledge Backend 🚀",
    timestamp: new Date().toISOString()
  });
});

/**
 * POST /chat
 * Main customer support chat endpoint grounded in website knowledge.
 * Body: { message: string, productContext?: string, history?: Array }
 */
router.post("/chat", async (req, res) => {
  try {
    const { message, productContext, history } = req.body;

    if (!message || typeof message !== "string") {
      return res.status(400).json({
        error: "Invalid request payload. 'message' string is required."
      });
    }

    const reply = await generateChatReply(message, {
      productContext: productContext || null,
      history: Array.isArray(history) ? history : []
    });

    res.json({ reply });
  } catch (err) {
    console.error("❌ [Chat Route Error]:", err.message || err);
    res.status(500).json({
      error: "Something went wrong processing your request. Please try again or click Chat with the Artist directly."
    });
  }
});

/**
 * POST /rebuild-knowledge
 * Protected administrative endpoint to dynamically re-scan the website and rebuild
 * the in-memory AI knowledge base without restarting the Node process.
 * Requires ADMIN_API_KEY (or REBUILD_SECRET) header:
 * - Header: `x-admin-key: <token>` OR `Authorization: Bearer <token>`
 */
router.post("/rebuild-knowledge", (req, res) => {
  try {
    const configuredKey = CONFIG.adminApiKey;

    // Fail-Closed Security: The administrative rebuild endpoint is ALWAYS disabled
    // across all environments unless ADMIN_API_KEY (or REBUILD_SECRET) is explicitly set.
    // This prevents accidental exposure in development, staging, or misconfigured deployments.
    if (!configuredKey || typeof configuredKey !== "string" || !configuredKey.trim()) {
      return res.status(503).json({
        success: false,
        error: "Admin rebuild endpoint is disabled. Set ADMIN_API_KEY (or REBUILD_SECRET) in environment variables to enable."
      });
    }

    // Verify incoming administrative credentials
    const authHeader = req.headers["authorization"] || "";
    const customHeader = req.headers["x-admin-key"] || "";
    const bearerToken = authHeader.startsWith("Bearer ") ? authHeader.slice(7).trim() : "";
    const providedKey = customHeader.trim() || bearerToken;

    if (!providedKey || providedKey !== configuredKey) {
      return res.status(401).json({
        success: false,
        error: "Unauthorized: Invalid or missing administrative key."
      });
    }

    console.log("⚡ [API Trigger] Dynamic knowledge rebuild requested...");
    const newDb = buildKnowledgeDatabase();
    reloadKnowledge();

    res.json({
      success: true,
      message: `Knowledge base rebuilt and loaded into memory successfully.`,
      sectionsCount: newDb.sections.length,
      timestamp: newDb.metadata.generatedAt
    });
  } catch (err) {
    if (err.code === "LOCKED") {
      return res.status(409).json({
        success: false,
        error: err.message
      });
    }
    if (err.name === "ValidationError") {
      return res.status(422).json({
        success: false,
        error: "Knowledge validation failed: " + err.message,
        details: err.details || []
      });
    }
    console.error("❌ [Rebuild Route Error]:", err.message || err);
    res.status(500).json({
      success: false,
      error: "Failed to rebuild knowledge database: " + err.message
    });
  }
});

module.exports = router;
