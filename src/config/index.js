const path = require("path");
const fs = require("fs");

const envPath = path.resolve(__dirname, "../../.env");
const envExists = fs.existsSync(envPath);

try {
  const dotenv = require("dotenv");
  const result = dotenv.config({ path: envPath });
  if (result.error && envExists) {
    console.warn(`⚠️  [Config Warning] Failed to parse .env file at "${envPath}": ${result.error.message}`);
  }
} catch (err) {
  if (envExists) {
    console.warn(`⚠️  [Config Warning] .env file was detected at "${envPath}", but 'dotenv' module could not be required (${err.message}). Configuration from .env will not be applied.`);
  }
}

// Candidate paths evaluated in order of priority; checked with fs.existsSync
const candidateFrontendPaths = [
  process.env.FRONTEND_PATH,
  path.resolve(__dirname, "../../../../nailsbydivya/nailsbydivya-main"), // Local Windows workspace layout
  path.resolve(__dirname, "../../../nailsbydivya"),                     // Direct sibling repository layout
  path.resolve(__dirname, "../../../nails website"),                   // Legacy workspace layout
  path.resolve(process.cwd(), "../nailsbydivya/nailsbydivya-main"),     // Relative from runtime CWD
].filter(Boolean);

const resolvedFrontendPath = candidateFrontendPaths.find((p) => fs.existsSync(p)) || candidateFrontendPaths[0];

const CONFIG = {
  port: process.env.PORT || 3000,
  nodeEnv: process.env.NODE_ENV || "development",
  geminiApiKey: process.env.GEMINI_API_KEY || "",
  geminiModel: process.env.GEMINI_MODEL || "gemini-3.1-flash-lite-preview",
  adminApiKey: process.env.ADMIN_API_KEY || process.env.REBUILD_SECRET || "",
  // Verified absolute path to frontend repository
  frontendPath: resolvedFrontendPath,
  // Path to generated knowledge database
  databasePath: process.env.DATABASE_PATH || path.resolve(__dirname, "../../knowledge/database.json"),
  // Path to knowledge backups directory
  backupDir: path.resolve(__dirname, "../../knowledge/backups"),
  // Max sections to include in retrieved context if knowledge base grows extremely large (> 100 sections)
  maxRetrievedSections: parseInt(process.env.MAX_RETRIEVED_SECTIONS || "25", 10),
};

console.log(`⚙️  [Config Verification] Loaded .env file.`);
console.log(`⚙️  [Config Verification] Active Gemini Model: "${CONFIG.geminiModel}" (from process.env.GEMINI_MODEL: "${process.env.GEMINI_MODEL || 'default'}")`);
console.log(`⚙️  [Config Verification] Resolved Frontend Path: "${CONFIG.frontendPath}" (Exists: ${fs.existsSync(CONFIG.frontendPath)})`);

module.exports = CONFIG;
