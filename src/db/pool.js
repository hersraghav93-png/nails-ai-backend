/**
 * ==========================================================================
 * POSTGRESQL CONNECTION POOL (`src/db/pool.js`)
 * Resilient, connection-pooled PostgreSQL client with sanitized diagnostics.
 * ==========================================================================
 */

const { Pool } = require("pg");
const CONFIG = require("../config");
const { sanitizeMessage, formatSafeDbError } = require("./errors");

let poolInstance = null;

/**
 * Initializes and returns the shared PostgreSQL Pool singleton.
 * Uses environment configuration from CONFIG.database.
 *
 * @returns {Pool}
 */
function getPool() {
  if (poolInstance) {
    return poolInstance;
  }

  const dbConfig = CONFIG.database;
  const poolConfig = {
    max: dbConfig.poolMax,
    idleTimeoutMillis: dbConfig.poolIdleTimeoutMs,
    connectionTimeoutMillis: dbConfig.connectionTimeoutMs,
  };

  if (dbConfig.url) {
    poolConfig.connectionString = dbConfig.url;
    if (dbConfig.ssl) {
      poolConfig.ssl = dbConfig.ssl;
    }
  } else {
    poolConfig.host = dbConfig.host;
    poolConfig.port = dbConfig.port;
    poolConfig.database = dbConfig.database;
    poolConfig.user = dbConfig.user;
    poolConfig.password = dbConfig.password;
    if (dbConfig.ssl) {
      poolConfig.ssl = dbConfig.ssl;
    }
  }

  poolInstance = new Pool(poolConfig);

  // Catch errors on idle clients in the pool to prevent process termination
  poolInstance.on("error", (err) => {
    console.error("⚠️  [DB Pool Warning] Unexpected idle client error:", sanitizeMessage(err.message));
  });

  return poolInstance;
}

/**
 * Executes a parameterized SQL query with automatic error sanitization.
 *
 * @param {string} text SQL statement
 * @param {Array} [params] Query parameters
 * @returns {Promise<import("pg").QueryResult>}
 */
async function query(text, params) {
  const pool = getPool();
  const start = Date.now();
  try {
    const res = await pool.query(text, params);
    return res;
  } catch (err) {
    const safe = formatSafeDbError(err, "Query Execution");
    console.error(`❌ [DB Error] ${safe.safeDetails}`);

    const sanitizedErr = new Error(safe.clientMessage);
    sanitizedErr.code = safe.code;
    sanitizedErr.statusCode = safe.statusCode;
    sanitizedErr.safeDetails = safe.safeDetails;
    throw sanitizedErr;
  }
}

/**
 * Acquires a raw client from the pool for transactional workflows.
 * The caller MUST call client.release() when finished.
 *
 * @returns {Promise<import("pg").PoolClient>}
 */
async function getClient() {
  const pool = getPool();
  try {
    const client = await pool.connect();
    return client;
  } catch (err) {
    const safe = formatSafeDbError(err, "Pool Connect");
    console.error(`❌ [DB Connection Error] ${safe.safeDetails}`);

    const sanitizedErr = new Error(safe.clientMessage);
    sanitizedErr.code = safe.code;
    sanitizedErr.statusCode = safe.statusCode;
    throw sanitizedErr;
  }
}

/**
 * Executes a callback within a managed transaction (BEGIN / COMMIT / ROLLBACK).
 *
 * @template T
 * @param {(client: import("pg").PoolClient) => Promise<T>} callback
 * @returns {Promise<T>}
 */
async function withTransaction(callback) {
  const client = await getClient();
  try {
    await client.query("BEGIN");
    const result = await callback(client);
    await client.query("COMMIT");
    return result;
  } catch (err) {
    try {
      await client.query("ROLLBACK");
    } catch (rbErr) {
      console.error("❌ [DB Rollback Error]:", sanitizeMessage(rbErr.message));
    }
    throw err;
  } finally {
    client.release();
  }
}

/**
 * Verifies live PostgreSQL connectivity via lightweight query.
 * Safe to call repeatedly by health-check probes.
 *
 * @returns {Promise<{ status: "connected" | "disconnected", latencyMs: number, pool: object, error: string | null }>}
 */
async function checkHealth() {
  const pool = getPool();
  const start = Date.now();

  try {
    await pool.query("SELECT 1 AS alive;");
    const latencyMs = Date.now() - start;
    return {
      status: "connected",
      latencyMs,
      pool: {
        total: pool.totalCount,
        idle: pool.idleCount,
        waiting: pool.waitingCount,
      },
      error: null,
    };
  } catch (err) {
    const latencyMs = Date.now() - start;
    const safe = formatSafeDbError(err, "Health Check");
    return {
      status: "disconnected",
      latencyMs,
      pool: {
        total: pool.totalCount,
        idle: pool.idleCount,
        waiting: pool.waitingCount,
      },
      error: safe.clientMessage,
    };
  }
}

/**
 * Gracefully shuts down the connection pool (used during tests or process exit).
 */
async function closePool() {
  if (poolInstance) {
    const pool = poolInstance;
    poolInstance = null;
    await pool.end();
  }
}

module.exports = {
  getPool,
  query,
  getClient,
  withTransaction,
  checkHealth,
  closePool,
};
