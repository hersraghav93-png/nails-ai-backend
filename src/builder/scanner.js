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

  if (!fs.existsSync(dirPath)) {
    console.warn(`[Scanner Warning] Target directory not found: ${dirPath}`);
    return results;
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
 * @param {string} frontendRoot - Absolute path to the frontend root directory
 * @returns {{ htmlFiles: string[], jsFiles: string[] }}
 */
function discoverFrontendFiles(frontendRoot) {
  const allFiles = scanDirectoryRecursively(frontendRoot, [".html", ".js"]);
  const htmlFiles = allFiles.filter((f) => f.endsWith(".html"));
  const jsFiles = allFiles.filter((f) => f.endsWith(".js"));

  return { htmlFiles, jsFiles };
}

module.exports = {
  scanDirectoryRecursively,
  discoverFrontendFiles
};
