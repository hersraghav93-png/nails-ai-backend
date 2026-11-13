const fs = require("fs");
const path = require("path");
const cheerio = require("cheerio");
const { cleanText, extractKeywords, generateProductAliases } = require("../utils/helpers");

/**
 * ==========================================================================
 * CONTENT EXTRACTOR (`src/builder/extractor.js`)
 * Parses HTML DOM and JS registries to extract high-value customer-facing
 * knowledge while stripping decorative noise, navigation, and boilerplate.
 * ==========================================================================
 */

/**
 * Extracts product pricing dictionary (`PRODUCT_PRICES`) from frontend script files (`*.js`).
 * @param {string[]} jsFiles - Array of JS file paths
 * @returns {Object} Dictionary mapping SKUs to price strings, e.g. { "CAS-004": "₹899" }
 */
function extractPricingRegistry(jsFiles) {
  const prices = {};

  for (const jsPath of jsFiles) {
    try {
      const content = fs.readFileSync(jsPath, "utf-8");
      // Match PRODUCT_PRICES object inside script.js
      const match = content.match(/const\s+PRODUCT_PRICES\s*=\s*\{([\s\S]*?)\};/);
      if (match && match[1]) {
        const body = match[1];
        // Extract key-value pairs like "CAS-004": "₹899"
        const regex = /["']([A-Z0-9-]+)["']\s*:\s*["']([^"']+)["']/g;
        let pair;
        while ((pair = regex.exec(body)) !== null) {
          prices[pair[1].trim()] = pair[2].trim();
        }
      }
    } catch (err) {
      console.warn(`[Extractor Warning] Could not parse pricing from ${jsPath}:`, err.message);
    }
  }

  return prices;
}

/**
 * Parses an HTML file to extract structured customer-facing knowledge sections.
 * @param {string} htmlFilePath - Absolute path to HTML file
 * @param {Object} pricingRegistry - Dictionary of SKU -> Price mappings
 * @returns {Array<Object>} Array of structured knowledge chunks
 */
function extractHtmlKnowledge(htmlFilePath, pricingRegistry = {}) {
  const sections = [];
  const fileName = path.basename(htmlFilePath);

  let htmlContent;
  try {
    htmlContent = fs.readFileSync(htmlFilePath, "utf-8");
  } catch (err) {
    console.error(`[Extractor Error] Could not read ${htmlFilePath}:`, err.message);
    return sections;
  }

  const $ = cheerio.load(htmlContent);

  // 1. Remove noisy elements (`Extract Only Useful Content`)
  $("script, style, noscript, svg, link, meta, header#site-header, footer#site-footer, .nav-menu, .mobile-nav-menu").remove();

  // Remove decorative or hidden elements EXCEPT inside FAQs or modals where answers/content might start hidden by JS
  $("[aria-hidden='true']").each((_, el) => {
    const $el = $(el);
    if (
      !$el.closest(".faq-item").length &&
      !$el.closest(".trust-faq-accordion-wrapper").length &&
      !$el.closest(".modal-overlay").length &&
      !$el.hasClass("trust-faq-accordion-wrapper")
    ) {
      $el.remove();
    }
  });

  // 2. Extract Major Sections (<section>)
  $("section").each((idx, el) => {
    const $sec = $(el);
    const secId = $sec.attr("id") || `section-${idx + 1}`;
    const secClass = $sec.attr("class") || "";

    // Determine category based on class/id
    let category = "General Information";
    if (secId === "home" || secClass.includes("hero")) category = "Brand Overview & Service Pillars";
    else if (secId === "about" || secClass.includes("manifesto")) category = "Brand Philosophy & Craftsmanship";
    else if (secId === "shop" || secClass.includes("shop")) category = "Press-On Nail Collections & Pricing";
    else if (secId === "portfolio" || secClass.includes("portfolio")) category = "Portfolio & Craftsmanship Quality";
    else if (secId === "services" || secClass.includes("services")) category = "Services Architecture (Press-Ons & At-Home Appointments)";
    else if (secId === "trust" || secClass.includes("trust")) category = "Why Choose Us & Customer FAQs";
    else if (secId === "reviews" || secClass.includes("reviews")) category = "Client Reviews & Testimonials";
    else if (secId === "contact" || secClass.includes("contact")) category = "Contact Information & Studio Hours";

    // 1. DIWALI OFFERS SECTION (`#diwali-offers`)
    if (secId === "diwali-offers" || secClass.includes("diwali-offers")) {
      const diwaliHeading = cleanText($sec.find(".section-heading h2").text()) || "Festive offers, made for your plans.";
      const diwaliSubtext = cleanText($sec.find(".section-subtext").text()) || "Choose your way to get festive-ready — at home across Delhi NCR or with handmade press-ons delivered across India.";

      sections.push({
        id: `${fileName}#diwali-offers-overview`,
        page: fileName,
        section: "diwali-promotions",
        title: "The Diwali Nail Edit: Active Festive Offers Overview",
        category: "Promotions & Festive Offers (Diwali Edit)",
        content: `The Diwali Nail Edit — Active Festive Offers Overview:
${diwaliHeading}
${diwaliSubtext}

Confirmed Active Diwali Offers:
1. Home Service from ₹999 (Delhi NCR: Delhi, Gurgaon, Noida)
2. Press-on Nails from ₹599 (Pan-India delivery across India)
3. Buy 2 Press-On Sets, Get 1 Set FREE (3rd set is complimentary ❤️)
4. First Order: 10% OFF (welcome discount for first-time clients)
5. Returning Clients: 15% OFF (festive thank-you for returning clients)
6. Same-Day Delivery available in Delhi NCR (Pan-India delivery for outside Delhi NCR)

Important Terms Note: All 6 offers are confirmed active as displayed on the website. Expiry dates, discount stacking/combination rules, and same-day delivery cut-off times are unspecified on the website. Customers should message Divya on WhatsApp to confirm details or place an order.`,
        keywords: extractKeywords("diwali", "festive", "offers", "promotions", "discounts", "home service", "press-on", "free", "same-day delivery")
      });

      $sec.find(".diwali-offer-card").each((oIdx, cardEl) => {
        const $c = $(cardEl);
        const cardTitle = cleanText($c.find("h3, h4, .diwali-card-title").text());
        const cardSubtext = cleanText($c.find(".diwali-card-subtext, p").not(".diwali-card-tag, h3, h4").text());
        const badge = cleanText($c.find(".badge, .diwali-card-tag, .free-lead, .badge-free").text());
        const href = $c.attr("href") || "";

        let offerSlug = `offer-${oIdx + 1}`;
        let offerType = "General Festive Promotion";
        let regularVsPromo = "";
        let conditions = "Confirmed active Diwali offer on website. Expiry date is unspecified. Stacking with other discounts is unspecified.";

        if (cardTitle.includes("Home Service")) {
          offerSlug = "home-service-999";
          offerType = "Home Service (At-Home Appointments in Delhi NCR)";
          regularVsPromo = "Promotional price starts at ₹999 for at-home appointments in Delhi, Gurgaon, and Noida. Regular pricing varies depending on the specific nail service or extension set selected.";
        } else if (cardTitle.includes("Press-on") && cardTitle.includes("599")) {
          offerSlug = "press-on-from-599";
          offerType = "Handmade Press-On Nails (Pan-India Delivery)";
          regularVsPromo = "Promotional starting rate is ₹599. Regular catalog press-on nail sets range from ₹699 to ₹1399.";
        } else if (cardTitle.includes("Buy 2")) {
          offerSlug = "buy-2-get-1-free";
          offerType = "Multi-Set Inquiry Policy";
          regularVsPromo = "Individual sets receive the flat ₹599 promotional price. Automated bundle discounts are not configured in checkout.";
          conditions = "Manual Confirmation Required. Inquire on WhatsApp for custom bulk or bridal party sets.";
        } else if (cardTitle.includes("First Order")) {
          offerSlug = "first-order-10-off";
          offerType = "Welcome Promotion Policy";
          regularVsPromo = "All 22 press-on designs already receive the verified flat promotional rate of ₹599 (regular catalog prices ₹699–₹1,399). No automated welcome coupon is active in checkout.";
          conditions = "Unverified / Consult Artist. Special welcome discounts must be discussed directly with Divya.";
        } else if (cardTitle.includes("Returning Clients")) {
          offerSlug = "returning-clients-15-off";
          offerType = "Returning Client Policy";
          regularVsPromo = "The loyalty program is currently disabled in backend settings pending business approval. Returning client discounts are not automatically available.";
          conditions = "Inactive / Pending business approval. Clients should consult Divya directly via WhatsApp for personalized bookings.";
        } else if (cardTitle.includes("Same-Day Delivery")) {
          offerSlug = "same-day-delivery-delhi-ncr";
          offerType = "Express Delivery Service";
          regularVsPromo = "Same-day delivery is available strictly in Delhi NCR. Outside Delhi NCR, standard Pan-India delivery applies.";
          conditions += " Delivery cut-off times and specific expedited fees are unspecified on the website; confirm via WhatsApp.";
        }

        const content = `Offer: ${cardTitle}
Offer Type: ${offerType}
Active Status: Confirmed Active (Diwali Promotion)
Website Description: ${cardSubtext}${badge ? ` [Special Badge: ${badge}]` : ""}
Regular vs Promotional Pricing: ${regularVsPromo}
Terms & Eligibility: ${conditions}
Booking / WhatsApp Link: ${href}`;

        sections.push({
          id: `${fileName}#diwali-${offerSlug}`,
          page: fileName,
          section: "diwali-promotions",
          offerTitle: cardTitle,
          offerType: offerType,
          title: `Diwali Offer: ${cardTitle}`,
          category: "Promotions & Festive Offers (Diwali Edit)",
          content,
          keywords: extractKeywords(cardTitle, cardSubtext, badge, offerType, "diwali", "festive", "promotion", "discount", "offer")
        });
      });
      return;
    }

    // 2. PORTFOLIO SECTION (`#portfolio`)
    if (secId === "portfolio" || secClass.includes("portfolio")) {
      const portHeading = cleanText($sec.find("h2").text()) || "Portfolio & Recent Artistry Lookbook";
      const portIntro = cleanText($sec.find(".section-intro, .portfolio-subtitle, p").first().text()) || "Explore 60 bespoke handcrafted nail designs by Divya across 3D chrome, minimalist nude, bridal elegance, and creative nail art.";

      sections.push({
        id: `${fileName}#portfolio-overview`,
        page: fileName,
        section: "portfolio-overview",
        title: portHeading,
        category: "Portfolio Designs & Nail Art Lookbook",
        content: `Nails by Divya Portfolio & Lookbook Overview:\n${portHeading}\n${portIntro}\nBrowse 60 bespoke designs available as custom handmade press-ons delivered across India, or as reference styles for at-home appointments in Delhi NCR. Every design is fully customizable in length, shape, and finish.`,
        keywords: extractKeywords(portHeading, portIntro, "portfolio", "lookbook", "designs", "categories", "nail art")
      });

      $sec.find(".portfolio-card").each((pIdx, cardEl) => {
        const $card = $(cardEl);
        const cat = $card.attr("data-category") || "art";
        const imgEl = $card.find("img");
        const imgAlt = cleanText(imgEl.attr("alt") || "");
        const captionSpan = cleanText($card.find("figcaption span").not(".portfolio-zoom-hint").first().text());
        const title = captionSpan || imgAlt || `Design #${pIdx + 1}`;
        const imgSrc = imgEl.attr("src") || "";
        const designNum = pIdx + 1;

        const categoryLabels = {
          chrome: "3D Chrome & Metallic Accents",
          nude: "Minimalist Nude, Sheer & Natural Overlays",
          bridal: "Bridal, Wedding & Festive Elegance",
          art: "Creative Hand-Painted Nail Art & Patterns"
        };
        const catLabel = categoryLabels[cat] || cat;

        const content = `Design Name: ${title}
Design Number: #${designNum} of 60
Category: ${catLabel} (${cat})
Craftsmanship: Bespoke hand-crafted design by Divya. Available as custom handmade press-on nails delivered across India or as an in-person at-home appointment across Delhi NCR (Delhi, Gurgaon, Noida).
Portfolio Image: ${imgSrc}
Customization & Booking: Each design can be customized in length, shape, finish, and detail. Book via WhatsApp by sharing the design name or reference image.`;

        sections.push({
          id: `${fileName}#portfolio-${designNum}`,
          page: fileName,
          section: "portfolio-design",
          designNumber: designNum,
          designName: title,
          portfolioCategory: cat,
          title: `Portfolio Design #${designNum}: ${title}`,
          category: "Portfolio Designs & Nail Art Lookbook",
          content,
          keywords: extractKeywords(title, cat, catLabel, "portfolio", "lookbook", "design", "reference", "nail art", "inspiration")
        });
      });
      return;
    }

    // 3. SHOP PRODUCTS SECTION (`#shop`)
    if (secId === "shop" || secClass.includes("shop")) {
      const seenSkus = new Set();
      $sec.find(".carousel-card, article[data-product-sku]").each((_, cardEl) => {
        const $card = $(cardEl);
        const sku = $card.attr("data-product-sku") || "";
        const title = cleanText($card.find("h4, h3, .product-title").first().text());
        const desc = cleanText($card.find("p").not(".product-price, .product-meta").last().text());
        const regularPrice = pricingRegistry[sku] || cleanText($card.find(".product-price").first().text()) || "Contact for pricing";

        if (title && sku && !seenSkus.has(sku)) {
          seenSkus.add(sku);
          const aliases = generateProductAliases(title, desc, sku);
          const content = `Product Name: ${title}
Regular Catalog Price: ${regularPrice}
Category: Handmade Press-On Nails
Description: ${desc}
Craftsmanship: Custom hand-crafted with salon-grade soft gel, tailored to your exact nail sizing.
Active Promotional Context: Available at the active promotional price of ₹599 (regular catalog price: ${regularPrice}). Custom sizing and shapes available.
Customization: Length, shape (Almond, Coffin, Square, Oval, Stiletto), and design details can be tailored upon order.
Pan-India Delivery: Shipped across India. Same-day delivery available in Delhi NCR.
Internal SKU: ${sku} (NOTE: For internal lookup only. Never mention SKU "${sku}" to the customer unless they explicitly typed it first.)`;

          sections.push({
            id: `${fileName}#shop-${sku}`,
            page: fileName,
            section: "shop-products",
            title: `${title} - ${regularPrice}`,
            productName: title,
            sku: sku,
            price: regularPrice,
            regularPrice: regularPrice,
            aliases: aliases,
            category: "Products & Press-On Pricing",
            content,
            keywords: extractKeywords(title, desc, regularPrice, sku, "press-on", "regular price", "order", "whatsapp", ...aliases)
          });
        }
      });

      // Shop header overview
      const shopHeading = cleanText($sec.find("h2").text()) || "Handmade Press-On Nail Collections";
      const shopIntro = cleanText($sec.find(".section-intro, .shop-subtitle").text()) || "Explore our casual, party, wedding, and daily wear press-on collections delivered across India.";
      sections.push({
        id: `${fileName}#shop-overview`,
        page: fileName,
        section: "shop-overview",
        title: shopHeading,
        category: "Products & Press-On Pricing",
        content: `Nails by Divya Press-On Collections: ${shopIntro}\nEvery set is custom hand-painted after your order is confirmed using professional soft gel. Regular prices range from ₹699 to ₹1399 across 22 catalog designs. Active Diwali offers include Press-on Nails starting from ₹599 and Buy 2 Get 1 Free. Order directly via WhatsApp.`,
        keywords: extractKeywords(shopHeading, shopIntro, "collection", "pricing", "press-on", "regular price")
      });
      return; // Handled `#shop` via detailed product extraction
    }

    // If this is the Trust/FAQ section (`#trust`), specifically extract each of the 17 FAQ items individually!
    if (secId === "trust" || secClass.includes("trust")) {
      // First extract the 4 Core Trust Pillars
      $sec.find(".trust-card").not(".trust-card-faq").each((cIdx, cardEl) => {
        const $card = $(cardEl);
        const num = cleanText($card.find(".trust-number").text());
        const cardTitle = cleanText($card.find("h3").text());
        const cardBody = cleanText($card.find("p").text());
        if (cardTitle && cardBody) {
          sections.push({
            id: `${fileName}#trust-pillar-${cIdx + 1}`,
            page: fileName,
            section: "trust-reassurance",
            title: `Why Choose Nails by Divya: ${cardTitle} (${num})`,
            category: "Craftsmanship & Quality Standards",
            content: `${cardTitle}: ${cardBody}`,
            keywords: extractKeywords(cardTitle, cardBody, "quality", "handmade", "soft gel", "tailored fit")
          });
        }
      });

      // Next extract every single FAQ item inside the Concierge Accordion (`05 / Questions Before You Order`)
      $sec.find(".faq-item").each((fIdx, faqEl) => {
        const $faq = $(faqEl);
        const qText = cleanText($faq.find(".faq-question-text").text()) || `FAQ #${fIdx + 1}`;
        const aText = cleanText($faq.find(".faq-item-answer").text());
        if (qText && aText) {
          sections.push({
            id: `${fileName}#faq-${fIdx + 1}`,
            page: fileName,
            section: "customer-faq",
            title: qText,
            category: "Customer Frequently Asked Questions (FAQ)",
            content: `Question: ${qText}\nAnswer: ${aText}`,
            keywords: extractKeywords(qText, aText, "faq", "question", "answer")
          });
        }
      });
      return; // Handled `#trust` and `#faq` cleanly
    }

    // If this is Client Reviews (`#reviews`), extract reviews cleanly
    if (secId === "reviews" || secClass.includes("reviews")) {
      const reviewOverviewTitle = cleanText($sec.find("h2").text()) || "Loved by Our Clients — Authentic Google Reviews";
      let allReviewsText = "";
      $sec.find(".review-card").each((_, revEl) => {
        const $rev = $(revEl);
        const quote = cleanText($rev.find(".review-quote").text());
        const author = cleanText($rev.find(".author-name").text());
        const context = cleanText($rev.find(".author-context").text());
        if (quote && author) {
          allReviewsText += `★★★★★ Review by ${author} (${context}): "${quote}"\n\n`;
        }
      });
      if (allReviewsText) {
        sections.push({
          id: `${fileName}#client-reviews`,
          page: fileName,
          section: "client-reviews",
          title: reviewOverviewTitle,
          category: "Client Reviews & Testimonials",
          content: `Real Client Testimonials from Google Reviews for Nails by Divya:\n\n${allReviewsText.trim()}`,
          keywords: extractKeywords(reviewOverviewTitle, allReviewsText, "reviews", "client", "google", "feedback")
        });
      }
      return;
    }

    // Default extraction for general sections (`#home`, `#about`, `#services`, `#contact`, etc.)
    if (fileName === "nail-art.html") category = "Custom Nail Art & Studio Direction";
    else if (fileName === "nail-extensions.html") category = "Nail Extensions & Overlay Services";
    else if (fileName === "press-on-nails-india.html") category = "Handmade Press-On Nails India";

    const heading = cleanText($sec.find("h1, h2, h3").first().text()) || `Section: ${category}`;
    // Clone section, remove inner cards/FAQs/grids that might have been processed or would clutter
    const $clone = $sec.clone();
    $clone.find("button, .faq-list, .carousel-track, .diwali-offer-grid, .portfolio-grid").remove();
    const bodyText = cleanText($clone.text());

    if (bodyText.length > 30) {
      sections.push({
        id: `${fileName}#${secId}`,
        page: fileName,
        section: secId,
        title: heading,
        category,
        content: bodyText,
        keywords: extractKeywords(heading, bodyText, category)
      });
    }
  });

  // 3. Extract Modal Details (#product-modal, #service-modal) for complete guarantee & box contents
  $("#product-modal, #service-modal").each((_, modalEl) => {
    const $m = $(modalEl);
    const mId = $m.attr("id");
    const title = cleanText($m.find("h2, .modal-title").text()) || (mId === "product-modal" ? "Press-On Order Guarantee & What's Included" : "At-Home Studio Service Details & Guarantee");
    const text = cleanText($m.find(".modal-description, .modal-highlights, .modal-guarantee, p").text());
    if (text.length > 20) {
      sections.push({
        id: `${fileName}#${mId}`,
        page: fileName,
        section: mId,
        title,
        category: mId === "product-modal" ? "Press-On Nail Information & Kit Contents" : "At-Home Service & Appointment Protocol",
        content: `${title}\n${text}`,
        keywords: extractKeywords(title, text, "guarantee", "included", "kit", "application", "studio")
      });
    }
  });

  return sections;
}

module.exports = {
  extractPricingRegistry,
  extractHtmlKnowledge
};
