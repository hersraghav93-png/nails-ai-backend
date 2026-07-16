/**
 * ==========================================================================
 * NAILS BY DIVYA AI KNOWLEDGE SYSTEM — UTILITIES & HELPERS
 * Clean text formatting, keyword generation, and hybrid retrieval scoring.
 * ==========================================================================
 */

/**
 * Cleans raw text extracted from HTML DOM nodes.
 * Strips excess whitespace, collapses multiple line breaks, and normalizes formatting.
 * @param {string} rawText 
 * @returns {string} Cleaned text
 */
function cleanText(rawText) {
  if (!rawText || typeof rawText !== "string") return "";
  
  return rawText
    .replace(/\r\n/g, "\n")
    .replace(/\t/g, " ")
    // Collapse more than two consecutive spaces into one space
    .replace(/ {2,}/g, " ")
    // Remove leading/trailing spaces from each line
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line.length > 0)
    // Collapse more than two blank lines into two blank lines
    .join("\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

/**
 * Generates an array of search keywords/tokens from text for semantic ranking.
 * @param {string} text 
 * @returns {string[]} Array of unique normalized keywords
 */
function extractKeywords(...texts) {
  const combined = texts.filter(Boolean).join(" ").toLowerCase();
  const tokens = combined
    .replace(/[^\w\s-₹]/g, " ")
    .split(/\s+/)
    .map((t) => t.trim())
    .filter((t) => t.length > 2 || t.startsWith("₹") || t.includes("-"));

  // Stop words to filter out during keyword extraction
  const stopWords = new Set([
    "the", "and", "for", "that", "this", "with", "from", "your", "have", "are",
    "will", "can", "our", "you", "not", "but", "all", "any", "when", "after",
    "before", "how", "what", "why", "who", "where", "which", "about", "into"
  ]);

  const uniqueTokens = new Set();
  for (const token of tokens) {
    if (!stopWords.has(token)) {
      uniqueTokens.add(token);
    }
  }
  return Array.from(uniqueTokens);
}

/**
 * Calculates Levenshtein edit distance between two strings for typo tolerance.
 */
function levenshteinDistance(a, b) {
  if (a.length === 0) return b.length;
  if (b.length === 0) return a.length;
  const matrix = [];
  for (let i = 0; i <= b.length; i++) matrix[i] = [i];
  for (let j = 0; j <= a.length; j++) matrix[0][j] = j;
  for (let i = 1; i <= b.length; i++) {
    for (let j = 1; j <= a.length; j++) {
      if (b.charAt(i - 1) === a.charAt(j - 1)) {
        matrix[i - 1][j - 1];
        matrix[i][j] = matrix[i - 1][j - 1];
      } else {
        matrix[i][j] = Math.min(
          matrix[i - 1][j - 1] + 1, // substitution
          matrix[i][j - 1] + 1,     // insertion
          matrix[i - 1][j] + 1      // deletion
        );
      }
    }
  }
  return matrix[b.length][a.length];
}

/**
 * Checks if query word is a close spelling match or typo variation of target word.
 */
function isCloseSpellingMatch(qWord, targetWord) {
  if (!qWord || !targetWord) return false;
  if (qWord === targetWord) return true;
  // Substring or partial match for strings >= 3 characters
  if (qWord.length >= 3 && targetWord.length >= 3 && (qWord.includes(targetWord) || targetWord.includes(qWord))) {
    return true;
  }
  // Levenshtein distance check based on word length
  const dist = levenshteinDistance(qWord, targetWord);
  if (targetWord.length >= 4 && dist <= 1) return true;
  if (targetWord.length >= 7 && dist <= 2) return true;
  return false;
}

/**
 * Automatically derives a rich array of searchable customer aliases from product metadata.
 * @param {string} title - Product public title
 * @param {string} desc - Product description text
 * @param {string} sku - Product SKU code
 * @returns {string[]} Array of unique, normalized search aliases
 */
function generateProductAliases(title, desc, sku = "") {
  if (!title) return [];
  const aliases = new Set();
  const tLower = title.toLowerCase().trim();
  const dLower = (desc || "").toLowerCase().trim();
  const combined = `${tLower} ${dLower}`;

  // Add clean lowercase title and base title words
  aliases.add(tLower);
  aliases.add(`${tLower} nails`);
  aliases.add(`${tLower} set`);

  const tWords = tLower.replace(/[^\w\s-]/g, " ").split(/\s+/).filter(w => w.length >= 2);

  // 1. Extract distinctive colors
  const colorKeywords = ["silver", "gold", "golden", "rosewood", "rose", "rosy", "blush", "pink", "nude", "milky", "white", "ivory", "crimson", "ruby", "wine", "bordeaux", "red", "black", "obsidian", "dark", "violet", "lavender", "emerald", "sapphire", "blue", "mauve", "champagne"];
  const matchedColors = colorKeywords.filter(c => combined.includes(c));

  // 2. Extract finishes, textures, and effects
  const finishKeywords = ["chrome", "glazed", "glaze", "glossy", "glass", "shiny", "shimmer", "pearl", "velvet", "satin", "matte", "cat eye", "cat-eye", "magnetic", "zari", "metallic", "foil", "glitter", "crystal", "diamond", "opal", "marbling", "gemstone", "3d", "ripple", "ripples", "waves", "swirl", "lace", "french", "ombre", "stars", "celestial", "floral", "petal", "petals", "bloom", "blossom", "aura"];
  const matchedFinishes = finishKeywords.filter(f => combined.includes(f));

  // 3. Extract styles & occasions from SKU prefix and description
  const matchedStyles = [];
  if (sku.startsWith("WED") || combined.includes("wedding") || combined.includes("bridal") || combined.includes("sangeet") || combined.includes("reception")) {
    matchedStyles.push("wedding", "bridal", "sangeet", "reception", "festive", "classy", "elegant");
  }
  if (sku.startsWith("PAR") || combined.includes("party") || combined.includes("evening") || combined.includes("celebration")) {
    matchedStyles.push("party", "evening", "bold", "night", "celebration", "statement");
  }
  if (sku.startsWith("WORK") || combined.includes("office") || combined.includes("daily") || combined.includes("professional") || combined.includes("everyday")) {
    matchedStyles.push("office", "work", "daily", "everyday", "minimal", "understated", "professional", "classy", "elegant", "natural");
  }
  if (sku.startsWith("CAS") || combined.includes("statement") || combined.includes("artistry")) {
    matchedStyles.push("casual", "statement", "artistry", "trendy", "3d");
  }

  // 4. Generate combination aliases (Word pairs and triples that customers naturally type)
  for (const w1 of tWords) {
    for (const w2 of tWords) {
      if (w1 !== w2) {
        aliases.add(`${w1} ${w2}`);
        aliases.add(`${w1} ${w2} nails`);
      }
    }
  }

  for (const color of matchedColors) {
    for (const finish of matchedFinishes) {
      aliases.add(`${color} ${finish}`);
      aliases.add(`${finish} ${color}`);
      aliases.add(`${color} ${finish} nails`);
      aliases.add(`${finish} ${color} nails`);
    }
    aliases.add(`${color} nails`);
    aliases.add(`${color} set`);
  }

  for (const finish of matchedFinishes) {
    aliases.add(`${finish} nails`);
    aliases.add(`${finish} set`);
    for (const word of tWords) {
      aliases.add(`${word} ${finish}`);
      aliases.add(`${finish} ${word}`);
      aliases.add(`${word} ${finish} nails`);
      aliases.add(`${finish} ${word} nails`);
    }
  }

  for (const style of matchedStyles) {
    aliases.add(`${style} nails`);
    aliases.add(`${style} set`);
    for (const finish of matchedFinishes) {
      aliases.add(`${style} ${finish} nails`);
    }
  }

  // Specific high-frequency human descriptions derived from exact metadata
  if (tLower.includes("molten") || combined.includes("ripples")) {
    aliases.add("molten chrome"); aliases.add("chrome ripple"); aliases.add("ripple nails"); aliases.add("silver ripple"); aliases.add("liquid chrome"); aliases.add("3d chrome"); aliases.add("silver swirl"); aliases.add("molten nails"); aliases.add("ripple chrome"); aliases.add("chrome silver"); aliases.add("silver waves");
  }
  if (tLower.includes("glazed aura")) {
    aliases.add("aura nails"); aliases.add("aura chrome"); aliases.add("pink aura"); aliases.add("glazed chrome"); aliases.add("pink chrome"); aliases.add("glazed nails"); aliases.add("glossy chrome"); aliases.add("glazed pink");
  }
  if (tLower.includes("midnight chrome")) {
    aliases.add("black chrome"); aliases.add("dark chrome"); aliases.add("mirror black"); aliases.add("obsidian nails"); aliases.add("black metallic"); aliases.add("emerald chrome"); aliases.add("sapphire chrome"); aliases.add("shiny black nails"); aliases.add("black mirror nails");
  }

  return Array.from(aliases).filter(a => a.length > 2);
}

/**
 * Calculates a relevance score for a knowledge section against a user query.
 * Uses exact substring matching, token overlap, and title boosting.
 * @param {Object} section - Knowledge section object
 * @param {string} query - Customer chat query
 * @returns {number} Relevance score (0.0 to 10.0+)
 */
function scoreSectionRelevance(section, query) {
  if (!query || !section) return 0;
  const qNorm = query.toLowerCase().trim();
  const titleNorm = (section.title || "").toLowerCase();
  const contentNorm = (section.content || "").toLowerCase();
  const categoryNorm = (section.category || "").toLowerCase();
  const pNameNorm = (section.productName || "").toLowerCase();
  const skuNorm = (section.sku || "").toLowerCase();
  const aliases = Array.isArray(section.aliases) ? section.aliases : [];

  let score = 0;

  // PRIORITY 5: Internal SKU (ONLY if explicitly typed by customer)
  if (skuNorm && qNorm.includes(skuNorm)) {
    score += 50.0;
  }

  // PRIORITY 1: Exact product name match
  if (pNameNorm && (qNorm.includes(pNameNorm) || pNameNorm === qNorm)) {
    score += 45.0;
  } else if (titleNorm && qNorm.includes(titleNorm)) {
    score += 25.0;
  }

  // PRIORITY 3: Alias match (Exact or fuzzy match against section.aliases)
  if (aliases.length > 0) {
    for (const alias of aliases) {
      if (qNorm === alias) {
        score += 75.0; // Exact full phrase match on an alias outranks single-token overlaps
        break;
      } else if (qNorm.includes(alias) || alias.includes(qNorm)) {
        score += 55.0;
        break;
      }
      // Check multi-word alias fuzzy/typo equivalence or singular/plural
      const qClean = qNorm.replace(/\b(nails|nail|set|one|design|the|about|tell|me|how|much|is|are|for|in|with|like|want)\b/g, "").trim().replace(/\s+/g, " ");
      const aClean = alias.replace(/\b(nails|nail|set|one|design)\b/g, "").trim().replace(/\s+/g, " ");
      if (qClean && aClean && (qClean === aClean || isCloseSpellingMatch(qClean, aClean))) {
        score += 55.0;
        break;
      }
      // Check Levenshtein distance <= 1 or 2 on full phrase
      if (Math.abs(qClean.length - aClean.length) <= 2 && levenshteinDistance(qClean, aClean) <= 2 && qClean.length >= 4) {
        score += 45.0;
        break;
      }
    }
  }

  const stopWords = new Set([
    "the", "and", "for", "that", "this", "with", "from", "your", "have", "are",
    "will", "can", "our", "you", "not", "but", "all", "any", "when", "after",
    "before", "how", "what", "why", "who", "where", "which", "about", "into",
    "like", "tell", "much", "want", "get", "one", "set", "design", "nails",
    "nail", "price", "cost", "please", "almond", "short", "long", "shape", "length"
  ]);

  const rawTokens = qNorm.replace(/[^\w\s-₹]/g, " ").split(/\s+/).filter(t => t.length >= 2);
  const qTokens = rawTokens.filter(t => !stopWords.has(t));

  if (section.section === "shop-products" && pNameNorm) {
    const pTokens = pNameNorm.replace(/[^\w\s-]/g, " ").split(/\s+/).filter(t => t.length >= 2);
    let matchedProductTokens = 0;

    for (const qWord of qTokens) {
      let isMatched = false;
      // Singular/plural normalization of query word
      const qSingular = qWord.endsWith("s") && qWord.length > 3 ? qWord.slice(0, -1) : qWord;

      for (const pToken of pTokens) {
        const pSingular = pToken.endsWith("s") && pToken.length > 3 ? pToken.slice(0, -1) : pToken;
        if (qWord === pToken || qSingular === pSingular) {
          score += 15.0; // Priority 1 / 2 token match
          isMatched = true;
          break;
        } else if (isCloseSpellingMatch(qWord, pToken) || isCloseSpellingMatch(qSingular, pSingular)) {
          score += 12.0; // Priority 2: Typo-corrected product name token
          isMatched = true;
          break;
        }
      }

      if (isMatched) {
        matchedProductTokens++;
      } else {
        // Priority 3 / 4: Check if query word matches any alias token
        let aliasTokenMatched = false;
        for (const alias of aliases) {
          const aliasTokens = alias.split(/\s+/);
          for (const aToken of aliasTokens) {
            const aSingular = aToken.endsWith("s") && aToken.length > 3 ? aToken.slice(0, -1) : aToken;
            if (qWord === aToken || qSingular === aSingular || isCloseSpellingMatch(qSingular, aSingular)) {
              score += 6.0;
              aliasTokenMatched = true;
              break;
            }
          }
          if (aliasTokenMatched) break;
        }

        if (!aliasTokenMatched && contentNorm.includes(qWord)) {
          score += 4.0;
        }
      }
    }

    if (pTokens.length > 0 && matchedProductTokens > 0) {
      score += (matchedProductTokens / pTokens.length) * 15.0;
    }
  } else {
    // General non-product sections
    if (contentNorm.includes(qNorm)) {
      score += 10.0;
    }
    let matchedTokens = 0;
    for (const token of qTokens) {
      let tokenMatched = false;
      if (titleNorm.includes(token) || contentNorm.includes(token)) {
        score += 3.0;
        tokenMatched = true;
      }
      if (section.keywords && section.keywords.includes(token)) {
        score += 2.0;
        tokenMatched = true;
      }
      if (categoryNorm.includes(token)) {
        score += 1.0;
        tokenMatched = true;
      }
      if (tokenMatched) matchedTokens++;
    }
    if (qTokens.length > 0) {
      score += (matchedTokens / qTokens.length) * 5.0;
    }
  }

  // PRIORITY 4: Smarter Customer Understanding & Description/style keywords
  // Check generic customer language across all tokens
  const genericCustomerTerms = ["bridal", "wedding", "sangeet", "reception", "engagement", "party", "evening", "office", "work", "daily", "classy", "elegant", "minimal", "understated", "nude", "natural", "glossy", "shiny", "chrome", "cat eye", "magnetic", "french", "almond", "square", "coffin", "stiletto", "short", "long"];
  for (const rawToken of rawTokens) {
    if (genericCustomerTerms.includes(rawToken)) {
      if (contentNorm.includes(rawToken) || titleNorm.includes(rawToken) || categoryNorm.includes(rawToken) || aliases.some(a => a.includes(rawToken))) {
        score += 8.0; // Priority 4 boost
      }
    }
  }

  return score;
}

module.exports = {
  cleanText,
  extractKeywords,
  generateProductAliases,
  scoreSectionRelevance
};
