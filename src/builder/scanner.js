const fs = require("fs");
const path = require("path");

/**
 * ==========================================================================
 * AUTOMATIC WEBSITE SCANNER (`src/builder/scanner.js`)
 * Recursively scans the frontend project directory to automatically discover
 * every HTML page (`*.html`) and script registry (`*.js`) without manual lists.
 * ==========================================================================
 */

/**
 * Recursively walks a directory and returns absolute paths of matching files.
 * @param {string} dirPath - Directory to scan
 * @param {string[]} extensions - Array of extensions to match, e.g. ['.html', '.js']
 * @param {string[]} ignoreDirs - Directories to ignore, e.g. ['node_modules', '.git', 'assets']
 * @returns {string[]} Array of absolute file paths
 */
function scanDirectoryRecursively(dirPath, extensions = [".html", ".js"], ignoreDirs = ["node_modules", ".git", "assets", "dist", "build"]) {
  let results = [];

  if (!dirPath || typeof dirPath !== "string") {
    throw new Error("[Scanner Error] A valid directory path string is required.");
  }

  if (!fs.existsSync(dirPath)) {
    throw new Error(`[Scanner Error] Target directory does not exist: "${dirPath}". Please configure a valid FRONTEND_PATH.`);
  }

  const list = fs.readdirSync(dirPath);

  for (const file of list) {
    const fullPath = path.join(dirPath, file);
    const stat = fs.statSync(fullPath);

    if (stat && stat.isDirectory()) {
      if (!ignoreDirs.includes(file.toLowerCase())) {
        results = results.concat(scanDirectoryRecursively(fullPath, extensions, ignoreDirs));
      }
    } else {
      const ext = path.extname(file).toLowerCase();
      if (extensions.includes(ext)) {
        results.push(fullPath);
      }
    }
  }

  return results;
}

/**
 * Discovers all frontend HTML and JS files in the configured frontend path.
 * Validates that the primary entrypoint `index.html` is present.
 * @param {string} frontendRoot - Absolute path to the frontend root directory
 * @returns {{ htmlFiles: string[], jsFiles: string[] }}
 */
function discoverFrontendFiles(frontendRoot) {
  if (!frontendRoot || typeof frontendRoot !== "string") {
    throw new Error("[Scanner Error] A valid frontendRoot string path is required.");
  }

  if (!fs.existsSync(frontendRoot)) {
    throw new Error(`[Scanner Error] Target frontend directory does not exist: "${frontendRoot}". Please configure a valid FRONTEND_PATH.`);
  }

  const allFiles = scanDirectoryRecursively(frontendRoot, [".html", ".js"]);
  const htmlFiles = allFiles.filter((f) => f.endsWith(".html"));
  const jsFiles = allFiles.filter((f) => f.endsWith(".js"));

  const hasIndexHtml = htmlFiles.some((f) => path.basename(f).toLowerCase() === "index.html");
  if (!hasIndexHtml) {
    throw new Error(`[Scanner Error] Primary entrypoint "index.html" was not found in "${frontendRoot}". Aborting scan.`);
  }

  return { htmlFiles, jsFiles };
}

module.exports = {
  scanDirectoryRecursively,
  discoverFrontendFiles
};
