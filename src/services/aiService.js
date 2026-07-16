const fs = require("fs");
const { GoogleGenerativeAI } = require("@google/generative-ai");
const CONFIG = require("../config");
const { scoreSectionRelevance } = require("../utils/helpers");
const { buildKnowledgeDatabase } = require("../builder/knowledgeBuilder");

/**
 * ==========================================================================
 * AI SERVICE MODULE (`src/services/aiService.js`)
 * Manages in-memory knowledge database, hybrid context retrieval, prompt
 * construction, and strictly grounded Gemini API generation.
 * ==========================================================================
 */

let knowledgeCache = null;
let genAI = null;

/**
 * Initializes the Gemini API SDK and loads `knowledge/database.json` into memory.
 * If the database does not exist, triggers an initial build automatically.
 */
function initAiService() {
  if (!CONFIG.geminiApiKey) {
    console.warn("⚠️ [AI Service Warning] GEMINI_API_KEY is missing or empty in .env!");
  } else {
    genAI = new GoogleGenerativeAI(CONFIG.geminiApiKey);
  }

  loadKnowledgeDatabase();
}

/**
 * Loads the structured knowledge database from disk (`knowledge/database.json`).
 * @returns {Object} Database object
 */
function loadKnowledgeDatabase() {
  try {
    if (!fs.existsSync(CONFIG.databasePath)) {
      console.log("⚠️ [AI Service] Database not found on disk. Automatically building from frontend workspace...");
      knowledgeCache = buildKnowledgeDatabase();
    } else {
      const raw = fs.readFileSync(CONFIG.databasePath, "utf-8");
      knowledgeCache = JSON.parse(raw);
      console.log(`✅ [AI Service] Loaded knowledge base v${knowledgeCache.metadata.version} into memory (${knowledgeCache.sections.length} sections).`);
    }
  } catch (err) {
    console.error("❌ [AI Service Error] Failed to load knowledge database:", err.message);
    knowledgeCache = { metadata: {}, sections: [] };
  }
  return knowledgeCache;
}

/**
 * Reloads the knowledge base from disk (e.g. after dynamic rebuild).
 */
function reloadKnowledge() {
  return loadKnowledgeDatabase();
}

/**
 * Retrieves and ranks the most relevant sections from the in-memory knowledge base
 * based on the user's chat message.
 * @param {string} userQuery - Customer chat message
 * @returns {Object} { highlights: Array<Object>, fullKnowledgeXml: string }
 */
function retrieveRelevantContext(userQuery) {
  if (!knowledgeCache || !knowledgeCache.sections) {
    return { highlights: [], fullKnowledgeXml: "<knowledge_base></knowledge_base>" };
  }

  const sections = knowledgeCache.sections;
  const scored = sections.map((sec) => ({
    section: sec,
    score: scoreSectionRelevance(sec, userQuery)
  }));

  // Sort descending by relevance score
  scored.sort((a, b) => b.score - a.score);

  // Top retrieved highlights with positive score
  const topHighlights = scored
    .filter((item) => item.score > 0)
    .slice(0, CONFIG.maxRetrievedSections)
    .map((item) => item.section);

  // Construct structured XML representation of the complete knowledge base
  // This ensures 100% recall while highlights draw immediate focus to exact SKUs or FAQs.
  let fullXml = `<knowledge_base brand="Nails by Divya" generatedAt="${knowledgeCache.metadata.generatedAt || ""}">\n`;
  for (const sec of sections) {
    const aliasAttr = Array.isArray(sec.aliases) && sec.aliases.length > 0 ? ` aliases="${sec.aliases.slice(0, 15).join(", ")}"` : "";
    fullXml += `  <section id="${sec.id}" category="${sec.category || "General"}"${sec.productName ? ` productName="${sec.productName}"` : ""}${sec.price ? ` price="${sec.price}"` : ""}${aliasAttr}>\n`;
    fullXml += `    <title>${sec.title || ""}</title>\n`;
    fullXml += `    <content>\n${sec.content || ""}\n    </content>\n`;
    fullXml += `  </section>\n`;
  }
  fullXml += `</knowledge_base>`;

  return { highlights: topHighlights, fullKnowledgeXml: fullXml };
}

/**
 * Generates an AI response for a customer message using strictly grounded knowledge.
 * @param {string} userMessage - Customer message
 * @param {Object} options - Optional context: { productContext?: string, history?: Array<{role: string, content: string}> }
 * @returns {Promise<string>} AI reply
 */
async function generateChatReply(userMessage, options = {}) {
  if (!genAI) {
    throw new Error("Gemini API client is not initialized. Check GEMINI_API_KEY in .env.");
  }

  if (!userMessage || typeof userMessage !== "string" || !userMessage.trim()) {
    return "Hi! I'm Divv 💅🏻 — Your Nail Stylist. How can I help you discover your perfect press-on set or book an at-home appointment today?";
  }

  const { productContext = null, history = [] } = options;

  // If customer refers to "this", "it", or "this design" while viewing a product, boost retrieval with productContext
  let retrievalQuery = userMessage;
  if (productContext && /\b(this|it|one|design|set|here|colour|color|shape|almond|square|coffin|stiletto|price|cost|how much|order|buy)\b/i.test(userMessage)) {
    retrievalQuery = `${userMessage} ${productContext}`;
  }

  const { highlights, fullKnowledgeXml } = retrieveRelevantContext(retrievalQuery);

  let highlightsText = "";
  if (highlights.length > 0) {
    highlightsText = "\n<retrieved_highlights>\n" +
      highlights.map((h) => {
        const aliasHeader = Array.isArray(h.aliases) && h.aliases.length > 0 ? ` | Aliases: ${h.aliases.slice(0, 10).join(", ")}` : "";
        return `[Section: ${h.title}${h.productName ? ` | Product Name: ${h.productName}` : ""}${aliasHeader}]\n${h.content}`;
      }).join("\n\n---\n\n") +
      "\n</retrieved_highlights>\n";
  }

  let historyText = "";
  if (Array.isArray(history) && history.length > 0) {
    historyText = "\n--- BROWSING SESSION CONVERSATION HISTORY ---\n" +
      history.slice(-8).map((turn) => {
        const roleLabel = turn.role === "user" ? "Customer" : "Divv 💅🏻";
        return `${roleLabel}: ${turn.content}`;
      }).join("\n\n") +
      "\n--- END SESSION HISTORY ---\n";
  }

  const productContextText = productContext
    ? `\nCURRENT PRODUCT CONTEXT (The customer is currently viewing or has selected this exact product on the website): "${productContext}". If the customer says "this design", "this one", "it", "this set", "can I get this in almond?", or asks about price/options without naming a product, they are asking specifically about "${productContext}".\n`
    : `\nCURRENT PRODUCT CONTEXT: No specific product modal is open.\n`;

  const systemPrompt = `You are Divv 💅🏻, the official AI Nail Stylist for Nails by Divya — a luxury bespoke nail artistry brand by freelance artist Divya based in Delhi NCR, India.

CRITICAL RULES FOR DIVV IDENTITY, ACCURACY, AND CONVERSATION STYLE:
1. IDENTITY & TONE: You are Divv 💅🏻 — Your Nail Stylist. You help customers discover the perfect nail set, recommend products, compare designs, explain services, answer FAQs, explain delivery, explain appointments, and explain customisations. Speak naturally like an experienced, warm, friendly, and elegant luxury nail stylist and beauty consultant. Never robotic. Never sound like AI. You MUST NEVER use phrases like "As an AI...", "Based on the provided information...", "According to the knowledge base...", or "I apologize...". Keep responses concise, warm, and professional (typically 2 to 4 sentences unless recommending designs or answering detailed FAQs).
2. DIVV IS NOT DIVYA (HUMAN HANDOFF): You are Divv 💅🏻, the AI Stylist. You are NOT Divya. Never pretend to be Divya. Whenever you cannot confidently answer from factual website knowledge, OR whenever the customer asks about custom designs, exact availability, order modifications, special requests, personal nail advice, complex situations, or anything not on the website, respond naturally and hand over to Divya. For example: "I'd love to help with that. Since this needs personal guidance, please chat directly with Divya."
3. GROUNDED IN FACTUAL KNOWLEDGE ONLY: You MUST answer customer questions accurately using ONLY the factual information, prices, policies, services, SKUs, and details provided inside the <retrieved_highlights> and <knowledge_base> below. You MUST NOT invent, guess, assume, or hallucinate any products, attributes, prices, or policies.
4. PRODUCT NAMES FIRST (NEVER EXPOSE SKUS OR ALIAS LISTS): When referring to products, ALWAYS use their exact public Product Name (for example, "Molten Chrome Ripple", "Glazed Aura Chrome", "Midnight Chrome"). You MUST NEVER naturally mention, include, or expose internal product codes or SKUs (like CAS-004, WED-005, PAR-003) unless the customer explicitly typed that exact SKU code first. You MUST NEVER recite or mention search aliases.
5. RECOMMENDATIONS (EXPLAIN WHY): Never dump the whole catalogue. When recommending designs to match what a customer is looking for, recommend 2 to 4 designs and explain WHY each is a great choice. Format each recommendation clearly:
Molten Chrome Ripple
Perfect if you love dimensional chrome finishes with bold texture.

Velvet Pearl
Elegant, timeless and ideal for everyday luxury.
6. SMARTER CUSTOMER UNDERSTANDING & ALIASES: Customers often describe designs naturally using aliases, descriptive phrases, styles, finishes, colors, or typos (e.g. "shiny black nails", "silver waves", "pink aura", "glazed pink", "moltn chrome", "wedding sets", "classy office nails"). If the retrieved highlights point to a single matching product based on what the customer described, answer directly and naturally about that product.
7. AMBIGUOUS QUERIES & NATURAL BULLETED CHOICES: If multiple products match the customer's description and there is genuine ambiguity (for example, if the customer says "I like the chrome one", "Do you have wedding sets?", or "Tell me about the velvet nails" and multiple exact products match), DO NOT guess or pick just one. Instead, reply naturally by listing the exact matching public Product Names as bullet points and asking which one they were referring to, exactly like this:
"I found a few designs that match what you're describing:

• Molten Chrome Ripple
• Glazed Aura Chrome
• Midnight Chrome

Which one were you referring to?"
8. PRODUCT AWARENESS: Use the CURRENT PRODUCT CONTEXT when the customer refers to "this", "this design", or "this one".
${productContextText}${historyText}
--- KNOWLEDGE DATABASE ---
${highlightsText}
${fullKnowledgeXml}
--- END KNOWLEDGE DATABASE ---`;

  console.log("🔍 [Runtime Debug] CONFIG.geminiModel:", CONFIG.geminiModel);
  console.log("🔍 [Runtime Debug] process.env.GEMINI_MODEL:", process.env.GEMINI_MODEL);
  console.log(`🤖 [Runtime Debug] Initializing generative model with name: "${CONFIG.geminiModel}"`);

  const model = genAI.getGenerativeModel({
    model: CONFIG.geminiModel,
    systemInstruction: systemPrompt,
    generationConfig: {
      temperature: 0.25, // Sleek balance of factual precision and warm luxury consultant tone
      topP: 0.85,
      maxOutputTokens: 1024,
    }
  });

  try {
    const result = await model.generateContent(userMessage);
    const reply = result.response.text();
    return reply || "I couldn't find that information on our website. I'd love to help with that—since this needs personal guidance, please chat directly with Divya.";
  } catch (error) {
    console.error("❌ [AI Service Generation Error]:", error);
    throw error;
  }
}

module.exports = {
  initAiService,
  loadKnowledgeDatabase,
  reloadKnowledge,
  retrieveRelevantContext,
  generateChatReply
};
