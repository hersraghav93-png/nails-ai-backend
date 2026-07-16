/**
 * ==========================================================================
 * NAILS BY DIVYA AI KNOWLEDGE SYSTEM — MAIN SERVER ENTRYPOINT (`index.js`)
 * Production-ready modular architecture with automatic knowledge grounding.
 * ==========================================================================
 */

const express = require("express");
const cors = require("cors");
const CONFIG = require("./src/config");
const { initAiService } = require("./src/services/aiService");
const chatRouter = require("./src/routes/chatRoute");

const app = express();

// 1. Middleware
app.use(cors());
app.use(express.json({ limit: "2mb" }));

// 2. Initialize AI Service & In-Memory Knowledge Base
initAiService();

// 3. Mount Application Routes
app.use("/", chatRouter);

// 4. Start Server
const server = app.listen(CONFIG.port, () => {
  console.log(`\n🚀 [Nails by Divya AI Server] Running on http://localhost:${CONFIG.port}`);
  console.log(`🔗 [API Endpoints]:`);
  console.log(`   • GET  /                 -> Health Check`);
  console.log(`   • POST /chat             -> Grounded AI Customer Support`);
  console.log(`   • POST /rebuild-knowledge-> Dynamic Website Re-Scan & Re-Index\n`);
});

// Handle graceful shutdown
process.on("SIGTERM", () => {
  console.log("🛑 [Server] SIGTERM received. Shutting down gracefully...");
  server.close(() => {
    console.log("🏁 [Server] Process terminated.");
  });
});

module.exports = app;