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

const isSslRequired = process.env.PGSSLMODE === "require" || process.env.DATABASE_SSL === "true";

const CONFIG = {
  port: parseInt(process.env.PORT || "3000", 10),
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
  // PostgreSQL Database Configuration (Phase 1B)
  database: {
    url: process.env.DATABASE_URL || "",
    host: process.env.PGHOST || "localhost",
    port: parseInt(process.env.PGPORT || "5432", 10),
    database: process.env.PGDATABASE || "nailsbydivya_staging",
    user: process.env.PGUSER || "postgres",
    password: process.env.PGPASSWORD || "",
    ssl: isSslRequired
      ? { rejectUnauthorized: process.env.NODE_ENV === "production" }
      : false,
    poolMax: parseInt(process.env.DB_POOL_MAX || "10", 10),
    poolIdleTimeoutMs: parseInt(process.env.DB_POOL_IDLE_TIMEOUT_MS || "30000", 10),
    connectionTimeoutMs: parseInt(process.env.DB_CONNECTION_TIMEOUT_MS || "5000", 10),
    isConfigured: Boolean(process.env.DATABASE_URL || process.env.PGPASSWORD || process.env.PGUSER),
  },
};

console.log(`⚙️  [Config Verification] Loaded configuration (env: ${CONFIG.nodeEnv}).`);
console.log(`⚙️  [Config Verification] Active Gemini Model: "${CONFIG.geminiModel}" (from process.env.GEMINI_MODEL: "${process.env.GEMINI_MODEL || 'default'}")`);
console.log(`⚙️  [Config Verification] Resolved Frontend Path: "${CONFIG.frontendPath}" (Exists: ${fs.existsSync(CONFIG.frontendPath)})`);
console.log(`⚙️  [Config Verification] Database Target: ${CONFIG.database.host}:${CONFIG.database.port}/${CONFIG.database.database} (SSL: ${Boolean(CONFIG.database.ssl)}, Configured: ${CONFIG.database.isConfigured})`);

module.exports = CONFIG;
