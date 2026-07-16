const path = require("path");

require("dotenv").config({ path: path.resolve(__dirname, "../../.env") });

const CONFIG = {
  port: process.env.PORT || 3000,
  geminiApiKey: process.env.GEMINI_API_KEY || "",
  geminiModel: process.env.GEMINI_MODEL || "gemini-3.1-flash-lite-preview",
  // Path to frontend directory (relative to backend root, defaults to '../nails website')
  frontendPath: process.env.FRONTEND_PATH || path.resolve(__dirname, "../../../nails website"),
  // Path to generated knowledge database
  databasePath: path.resolve(__dirname, "../../knowledge/database.json"),
  // Max sections to include in retrieved context if knowledge base grows extremely large (> 100 sections)
  maxRetrievedSections: parseInt(process.env.MAX_RETRIEVED_SECTIONS || "25", 10),
};

console.log(`⚙️  [Config Verification] Loaded .env file.`);
console.log(`⚙️  [Config Verification] Active Gemini Model: "${CONFIG.geminiModel}" (from process.env.GEMINI_MODEL: "${process.env.GEMINI_MODEL || 'default'}")`);

module.exports = CONFIG;
