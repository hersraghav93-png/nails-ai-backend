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

const isSslRequired =
  process.env.PGSSLMODE === "require" ||
  process.env.DATABASE_SSL === "true" ||
  Boolean(process.env.DATABASE_URL && (process.env.DATABASE_URL.includes("sslmode=require") || process.env.DATABASE_URL.includes("neon.tech")));

const CONFIG = {
  port: parseInt(process.env.PORT || "3000", 10),
  get nodeEnv() {
    return process.env.NODE_ENV || "development";
  },
  set nodeEnv(val) {
    process.env.NODE_ENV = val;
  },
  isProduction() {
    const env = (process.env.NODE_ENV || this.nodeEnv || "").toLowerCase().trim();
    return env === "production" || env === "prod";
  },
  isStaging() {
    const env = (process.env.NODE_ENV || this.nodeEnv || "").toLowerCase().trim();
    return env === "staging" || env === "stage";
  },
  isTest() {
    const env = (process.env.NODE_ENV || this.nodeEnv || "").toLowerCase().trim();
    return env === "test";
  },
  isDevelopment() {
    if (this.isProduction() || this.isStaging() || this.isTest()) return false;
    const env = (process.env.NODE_ENV || this.nodeEnv || "").toLowerCase().trim();
    return env === "development" || env === "dev" || env === "local";
  },
  isLiveEnvironment() {
    return this.isProduction() || this.isStaging();
  },
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
  // Firebase Authentication (Phase 1C)
  firebase: {
    projectId: process.env.FIREBASE_PROJECT_ID || "",
    clientEmail: process.env.FIREBASE_CLIENT_EMAIL || "",
    privateKey: (() => {
      let key = process.env.FIREBASE_PRIVATE_KEY || "";
      if (key.startsWith('"') && key.endsWith('"')) {
        key = key.slice(1, -1);
      }
      return key.replace(/\\n/g, "\n");
    })(),
    serviceAccountPath: process.env.FIREBASE_SERVICE_ACCOUNT_PATH || "",
    isConfigured: Boolean(
      process.env.FIREBASE_PROJECT_ID &&
        ((process.env.FIREBASE_CLIENT_EMAIL && process.env.FIREBASE_PRIVATE_KEY) ||
          process.env.FIREBASE_SERVICE_ACCOUNT_PATH)
    ),
  },
  // Customer Communications & WhatsApp Configuration (Phase 3A & 4A)
  notifications: {
    whatsapp: {
      provider: process.env.WHATSAPP_PROVIDER || "meta",
      apiVersion: process.env.WHATSAPP_GRAPH_API_VERSION || "v26.0",
      apiToken: process.env.WHATSAPP_API_TOKEN || "",
      phoneNumberId: process.env.WHATSAPP_PHONE_NUMBER_ID || "",
      businessAccountId: process.env.WHATSAPP_BUSINESS_ACCOUNT_ID || "",
      appSecret: process.env.WHATSAPP_APP_SECRET || "",
      webhookVerifyToken: process.env.WHATSAPP_WEBHOOK_VERIFY_TOKEN || "",
      testRecipientPhone: process.env.WHATSAPP_TEST_RECIPIENT_PHONE || "",
      isTestRecipientApproved: process.env.WHATSAPP_TEST_RECIPIENT_APPROVED === "true",
      isConfigured: Boolean(process.env.WHATSAPP_API_TOKEN && process.env.WHATSAPP_PHONE_NUMBER_ID),
      studioPhoneNumber: process.env.STUDIO_WHATSAPP_PHONE || "+919811000001",
    },
  },
};

console.log(`⚙️  [Config Verification] Loaded configuration (env: ${CONFIG.nodeEnv}).`);
console.log(`⚙️  [Config Verification] Active Gemini Model: "${CONFIG.geminiModel}" (from process.env.GEMINI_MODEL: "${process.env.GEMINI_MODEL || 'default'}")`);
console.log(`⚙️  [Config Verification] Resolved Frontend Path: "${CONFIG.frontendPath}" (Exists: ${fs.existsSync(CONFIG.frontendPath)})`);
console.log(`⚙️  [Config Verification] Database Target: ${CONFIG.database.host}:${CONFIG.database.port}/${CONFIG.database.database} (SSL: ${Boolean(CONFIG.database.ssl)}, Configured: ${CONFIG.database.isConfigured})`);
console.log(`⚙️  [Config Verification] Firebase Auth Configured: ${CONFIG.firebase.isConfigured} (Project: "${CONFIG.firebase.projectId || 'none'}")`);
console.log(`⚙️  [Config Verification] WhatsApp Cloud API: Configured=${CONFIG.notifications.whatsapp.isConfigured} (Graph API: "${CONFIG.notifications.whatsapp.apiVersion}")`);

module.exports = CONFIG;
