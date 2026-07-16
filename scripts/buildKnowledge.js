#!/usr/bin/env node

/**
 * ==========================================================================
 * BUILD KNOWLEDGE CLI SCRIPT (`npm run build-knowledge`)
 * Scans the frontend website, extracts customer-facing content, cleans and
 * structures the knowledge, and outputs `knowledge/database.json`.
 * ==========================================================================
 */

const { buildKnowledgeDatabase } = require("../src/builder/knowledgeBuilder");

try {
  buildKnowledgeDatabase();
  process.exit(0);
} catch (error) {
  console.error("❌ [Build Knowledge Error] Failed to generate knowledge database:", error);
  process.exit(1);
}
