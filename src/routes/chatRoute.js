const express = require("express");
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
 * Body: { message: string }
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
 * Admin/webhook endpoint to dynamically re-scan the website and rebuild
 * the in-memory AI knowledge base without restarting the Node process.
 */
router.post("/rebuild-knowledge", (req, res) => {
  try {
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
    console.error("❌ [Rebuild Route Error]:", err.message || err);
    res.status(500).json({
      success: false,
      error: "Failed to rebuild knowledge database: " + err.message
    });
  }
});

module.exports = router;
