async function scrapeInventoryFromDOM(page, maxPages = 1) {
  const started = Date.now();
  const embeddedData = await page.evaluate(() => {
    const scripts = document.querySelectorAll('script[type="application/json"]');
    for (const s of scripts) {
      try {
        const data = JSON.parse(s.textContent || "");
        if (data?.results || data?.inventory?.results) return data;
      } catch (_) {}
    }
    try {
      // Tesla changes client state names occasionally; keep this deliberately broad.
      const state = window.__INITIAL_STATE__ || window.__REDUX_STATE__;
      if (state) return state;
    } catch (_) {}
    return null;
  });

  if (embeddedData) {
    const results = embeddedData?.results || embeddedData?.inventory?.results || [];
    return {
      results,
      total_matches_found: embeddedData?.total_matches_found || results.length,
      pagesFetched: 1,
      maxPages: Math.max(1, Math.floor(Number(maxPages) || 1)),
      requestCount: 0,
      scrapeDurationMs: Date.now() - started,
      capped: false,
      partial: true,
      partialReason: "DOM scrape embedded data - display only",
      source: "dom-embedded",
      _domFallback: true,
    };
  }

  const vehicles = await page.evaluate(() => {
    const selectors = [
      'article[data-testid*="vehicle"]',
      'div[data-testid*="vehicle"]',
      ".result-item",
      ".inventory-result",
    ];
    let elements = [];
    for (const selector of selectors) {
      elements = Array.from(document.querySelectorAll(selector));
      if (elements.length) break;
    }

    const getText = (el, selector) => {
      const node = el.querySelector(selector);
      return node ? (node.textContent || "").trim() : "";
    };

    return elements.map((el, index) => ({
      VIN: el.getAttribute("data-vin") || "",
      Hash: el.getAttribute("data-hash") || el.getAttribute("data-id") || `dom-${index}`,
      TrimName: getText(el, '[class*="trim"]') || getText(el, '[class*="variant"]') || getText(el, "h3") || "",
      TotalPrice: parseInt((getText(el, '[class*="price"]') || "").replace(/[^0-9]/g, ""), 10) || 0,
      City: getText(el, '[class*="location"]') || "",
      _domSource: true,
    }));
  });

  return {
    results: vehicles,
    total_matches_found: vehicles.length,
    pagesFetched: 1,
    maxPages: Math.max(1, Math.floor(Number(maxPages) || 1)),
    requestCount: 0,
    scrapeDurationMs: Date.now() - started,
    capped: false,
    partial: true,
    partialReason: "DOM scrape limited fields - display only",
    source: "dom-cards",
    _domFallback: true,
  };
}

module.exports = { scrapeInventoryFromDOM };
