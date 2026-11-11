/**
 * ==========================================================================
 * NAILS BY DIVYA AI KNOWLEDGE SYSTEM — MAIN SERVER ENTRYPOINT (`index.js`)
 * Production-ready modular architecture with automatic knowledge grounding.
 * ==========================================================================
 */

const express = require("express");
const CONFIG = require("./src/config");
const { initAiService } = require("./src/services/aiService");
const chatRouter = require("./src/routes/chatRoute");
const authRouter = require("./src/routes/authRoute");
const customerRouter = require("./src/routes/customerRoute");
const adminRouter = require("./src/routes/adminRoute");
const cartRouter = require("./src/routes/cartRoute");
const orderRouter = require("./src/routes/orderRoute");
const bookingRouter = require("./src/routes/bookingRoute");
const productRouter = require("./src/routes/productRoute");
const webhookRouter = require("./src/routes/webhookRoute");

const { closePool } = require("./src/db/pool");
const { getCorsMiddleware } = require("./src/middleware/corsConfig");
const { adminRateLimiter, authRateLimiter, chatRateLimiter } = require("./src/middleware/rateLimiter");

const app = express();

// 1. Middleware
app.use(getCorsMiddleware());
app.use(
  express.json({
    limit: "2mb",
    verify: (req, res, buf) => {
      req.rawBody = buf;
    },
  })
);

// 2. Initialize AI Service & In-Memory Knowledge Base
initAiService();

// 3. Mount Application Routes
app.use("/chat", chatRateLimiter);
app.use("/", chatRouter);
app.use("/api/auth", authRateLimiter, authRouter);
app.use("/api/customer", customerRouter);
app.use("/api/admin", adminRateLimiter, adminRouter);
app.use("/api/cart", cartRouter);
app.use("/api/orders", orderRouter);
app.use("/api/products", productRouter);
app.use("/api/webhooks", webhookRouter);
app.use("/api", bookingRouter);

// 4. Start Server (if executed directly)
let server;
if (require.main === module) {
  server = app.listen(CONFIG.port, () => {
    console.log(`\n🚀 [Nails by Divya Server] Running on http://localhost:${CONFIG.port}`);
    console.log(`🔗 [API Endpoints]:`);
    console.log(`   • GET  /                  -> Health Check (Root)`);
    console.log(`   • GET  /health            -> Detailed Subsystem Health`);
    console.log(`   • POST /chat              -> Grounded AI Customer Support`);
    console.log(`   • POST /rebuild-knowledge -> Dynamic Website Re-Scan & Re-Index`);
    console.log(`   • GET  /api/auth/me       -> Authenticated Customer Identity`);
    console.log(`   • /api/customer/*         -> Profile & Address Management`);
    console.log(`   • /api/admin/*            -> Protected Admin & Operational Metrics\n`);
  });
}

// Handle graceful shutdown
function gracefulShutdown(signal) {
  console.log(`\n🛑 [Server] ${signal} received. Shutting down gracefully...`);
  if (server) {
    server.close(async () => {
      try {
        await closePool();
        console.log("🔌 [Database] Connection pool closed successfully.");
      } catch (err) {
        console.error("⚠️  [Database Shutdown Error]:", err.message);
      }
      console.log("🏁 [Server] Process terminated.");
    });
  } else {
    closePool().then(() => {
      console.log("🏁 [Server] Process terminated.");
    });
  }
}

process.on("SIGTERM", () => gracefulShutdown("SIGTERM"));
process.on("SIGINT", () => gracefulShutdown("SIGINT"));

module.exports = app;