/**
 * ==========================================================================
 * DATABASE ERROR SANITIZER & HANDLER (`src/db/errors.js`)
 * Ensures connection strings, passwords, and internal SQL details never leak.
 * ==========================================================================
 */

/**
 * Strips credentials and URIs from any error message or string.
 * @param {string} text
 * @returns {string} Sanitized string
 */
function sanitizeMessage(text) {
  if (typeof text !== "string") return String(text || "");
  return text
    // Redact URIs with credentials: postgresql://user:password@host:port/db
    .replace(/(postgres(?:ql)?:\/\/)[^/\s?#]+@/gi, "$1***:***@")
    // Redact password parameters: password=XYZ
    .replace(/(password\s*=\s*)(['"]?)[^'"\s;]+(\2)/gi, "$1***")
    // Redact authorization headers or tokens if present
    .replace(/(bearer\s+)[a-zA-Z0-9._-]+/gi, "$1***");
}

/**
 * Standardizes raw database errors into safe client-facing errors and
 * detailed server-side logs.
 *
 * @param {Error} err Raw error from pg or query
 * @param {string} [context] Context description (e.g. "User lookup")
 * @returns {{ clientMessage: string, statusCode: number, code: string, safeDetails: string }}
 */
function formatSafeDbError(err, context = "Database Operation") {
  const sanitizedOriginal = sanitizeMessage(err ? err.message : "Unknown database error");
  const pgCode = err && err.code ? String(err.code) : "UNKNOWN";

  // Default fallback response (opaque, safe)
  let clientMessage = "A database error occurred. Please try again later.";
  let statusCode = 500;
  let code = "DATABASE_ERROR";

  switch (pgCode) {
    case "23505": // unique_violation
      clientMessage = "A record with this information already exists.";
      statusCode = 409;
      code = "CONFLICT";
      break;

    case "23503": // foreign_key_violation
      clientMessage = "Referenced resource does not exist.";
      statusCode = 422;
      code = "INVALID_REFERENCE";
      break;

    case "23502": // not_null_violation
      clientMessage = "A required field was missing or empty.";
      statusCode = 400;
      code = "MISSING_REQUIRED_FIELD";
      break;

    case "22P02": // invalid_text_representation
      clientMessage = "Invalid parameter format provided.";
      statusCode = 400;
      code = "INVALID_DATA_FORMAT";
      break;

    case "28P01": // invalid_password
    case "28000": // invalid_authorization_specification
      clientMessage = "Database authentication failure.";
      statusCode = 503;
      code = "AUTH_FAILURE";
      break;

    case "3D000": // database does not exist
      clientMessage = "Target database unavailable.";
      statusCode = 503;
      code = "DATABASE_UNAVAILABLE";
      break;

    case "ECONNREFUSED":
    case "ETIMEDOUT":
    case "ENOTFOUND":
      clientMessage = "Database service unreachable.";
      statusCode = 503;
      code = "CONNECTION_UNAVAILABLE";
      break;

    case "57014": // query_canceled (e.g. statement timeout)
      clientMessage = "Database operation timed out.";
      statusCode = 504;
      code = "TIMEOUT";
      break;

    default:
      if (sanitizedOriginal.includes("timeout")) {
        clientMessage = "Database operation timed out.";
        statusCode = 504;
        code = "TIMEOUT";
      }
      break;
  }

  return {
    clientMessage,
    statusCode,
    code,
    safeDetails: `[${context}] (${code}/${pgCode}): ${sanitizedOriginal}`,
  };
}

module.exports = {
  sanitizeMessage,
  formatSafeDbError,
};
