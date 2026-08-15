// Tesla Stock Watch - Tesla Shop accessory stock scraper.

const PRODUCTS = [
  { id: "trunk-storage-bins", name: "Trunk Storage Bins", url: "https://shop.tesla.com/en_au/product/model-yl-trunk-storage-bins" },
  { id: "console-tray", name: "Centre Console Tray", url: "https://shop.tesla.com/en_au/product/model-y-_-model-yl-double-layer-centre-console-tray" },
  { id: "interior-liners", name: "All-Weather Interior Liners", url: "https://shop.tesla.com/en_au/product/model-yl-all-weather-interior-liners" },
  { id: "rear-cargo-liner", name: "Rear Cargo Liner", url: "https://shop.tesla.com/en_au/product/model-yl-all-weather-rear-cargo-liner" },
  { id: "rear-trunk-seatback-liner", name: "Rear Trunk & Seatback Liner", url: "https://shop.tesla.com/en_au/product/model-yl-all-weather-rear-trunk-_-seatback-liner" },
];

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function classifyStockText(text) {
  const body = String(text || "");
  if (/access denied|you don't have permission|edgesuite|akamai|request blocked/i.test(body)) {
    return "blocked";
  }
  if (/sold out|out of stock|unavailable|notify me|email me when this item is restocked/i.test(body)) {
    return "out_of_stock";
  }
  if (/add to cart|buy now|checkout|sign in to add to cart/i.test(body)) {
    return "in_stock";
  }
  return "unknown";
}

async function fetchStockStatus(url) {
  const response = await fetch(url, {
    headers: {
      "user-agent": "Mozilla/5.0 AppleWebKit/537.36 Chrome Safari",
      "accept-language": "en-AU,en;q=0.9",
    },
  });
  const html = await response.text();
  return classifyStockText(html);
}

async function scrapeShopProductsByFetch(products = PRODUCTS) {
  const results = [];
  for (const product of products) {
    const status = await fetchStockStatus(product.url).catch(() => "unknown");
    if (status === "unknown") {
      console.warn(`[shop] Unknown stock status via fetch for ${product.name}`);
    } else if (status === "blocked") {
      console.warn(`[shop] Tesla Shop blocked fetch for ${product.name}`);
    }
    results.push({
      id: product.id,
      name: product.name,
      url: product.url,
      status,
      checkedAt: Date.now(),
    });
  }
  return results;
}

async function scrapeShopProducts(page) {
  const results = [];

  for (const product of PRODUCTS) {
    await page.goto(product.url, {
      waitUntil: "domcontentloaded",
      timeout: 60000,
    });
    await sleep(3000);

    let status = await page.evaluate(() => {
      const text = document.body?.innerText || "";
      if (/sold out|out of stock|unavailable|notify me|email me when this item is restocked/i.test(text)) return "out_of_stock";
      if (/add to cart|buy now|checkout|sign in to add to cart/i.test(text)) return "in_stock";
      return "unknown";
    });

    if (status === "unknown") {
      status = await fetchStockStatus(product.url).catch(() => "unknown");
    }

    if (status === "unknown") {
      console.warn(`[shop] Unknown stock status for ${product.name}`);
    } else if (status === "blocked") {
      console.warn(`[shop] Tesla Shop blocked ${product.name}`);
    }

    results.push({
      id: product.id,
      name: product.name,
      url: product.url,
      status,
      checkedAt: Date.now(),
    });
  }

  return results;
}

module.exports = { PRODUCTS, scrapeShopProducts, scrapeShopProductsByFetch, classifyStockText };
