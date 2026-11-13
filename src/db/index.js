/**
 * ==========================================================================
 * DATABASE MODULE BARREL (`src/db/index.js`)
 * Unified entrypoint for PostgreSQL pooling, queries, errors, and health.
 * ==========================================================================
 */

const pool = require("./pool");
const errors = require("./errors");

module.exports = {
  ...pool,
  ...errors,
};
