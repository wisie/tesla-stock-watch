const TELEGRAM_CHANNEL = "https://t.me/s/teslaaustralianewinventory";
const DEFAULT_TELEGRAM_USER_AGENT = "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36";
const TELEGRAM_TIMEOUT_MS = 15000;
const TELEGRAM_STALE_MS = Number(process.env.TELEGRAM_STALE_MS || 2 * 60 * 60 * 1000);
const BACKOFF_STEPS_MS = [30000, 120000, 300000];
const MESSAGE_LIMIT = 50;

let cachedHtml = "";
let lastFetchAt = 0;
let lastSuccessAt = 0;
let lastError = null;
let consecutiveFailures = 0;
let nextFetchAllowedAt = 0;
let recentListings = [];
let messageCount = 0;
let myMessageCount = 0;
let lastMessageAt = 0;
let servedFromCache = false;

function decodeHtml(value) {
  return String(value || "")
    .replace(/<br\s*\/?>/gi, " ")
    .replace(/&nbsp;/gi, " ")
    .replace(/&amp;/gi, "&")
    .replace(/&lt;/gi, "<")
    .replace(/&gt;/gi, ">")
    .replace(/&quot;/gi, "\"")
    .replace(/&#39;/gi, "'")
    .replace(/&#(\d+);/g, (_, n) => String.fromCharCode(Number(n)))
    .replace(/&#x([0-9a-f]+);/gi, (_, n) => String.fromCharCode(parseInt(n, 16)))
    .replace(/<[^>]+>/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function extractSlug(link) {
  const match = String(link || "").match(/\/car\/([^/?#\s]+)/);
  return match ? match[1] : "";
}

function parseTrimColours(trimPlusColours) {
  const text = String(trimPlusColours || "").trim();
  const slashIndex = text.indexOf("/");
  if (slashIndex === -1) {
    return { trim: text, paint: "", interior: "" };
  }

  const before = text.slice(0, slashIndex).trim();
  let interior = text.slice(slashIndex + 1).trim();
  interior = interior.replace(/\s+Interior$/i, "").trim();

  const paintNames = [
    "Stealth Grey",
    "Diamond Black",
    "Ultra Red",
    "Quicksilver",
    "Pearl White",
    "Glacier Blue",
    "Midnight Silver",
    "Deep Blue",
    "Solid Black",
  ];
  const paint = paintNames.find((name) => before.toLowerCase().endsWith(name.toLowerCase())) || "";
  if (!paint) return { trim: before, paint: "", interior };

  return {
    trim: before.slice(0, before.length - paint.length).trim(),
    paint,
    interior,
  };
}

function parseMessageText(text, timestamp) {
  const match = String(text || "").match(/^(New(?:\s+Demo)?)\s+(MY)\s+(\d{4})\s+(.+?)\s+(?:(\d+|NA)\s+seats?\s+)?in\s+(.+?)\s+Australia\s+(listed|relisted)\s+at\s+(\d+)\s+(?:Discount\s+(\d+)\s+\([^)]*\)\s+)?AP\s+(https:\/\/ev-inventory\.com\/car\/[^\s]+)/i);
  if (!match) return null;
  const [, condition, model, year, trimPlusColours, seatCount, location, listingStatus, price, discount, link] = match;
  if (model !== "MY") return null;
  const parsedTrim = parseTrimColours(trimPlusColours);
  return {
    id: extractSlug(link) || link,
    condition,
    model,
    year: Number(year),
    trim: parsedTrim.trim,
    paint: parsedTrim.paint,
    interior: parsedTrim.interior,
    seats: seatCount || "",
    location,
    status: listingStatus,
    price: Number(price),
    discount: discount ? Number(discount) : 0,
    link,
    text,
    timestamp: timestamp || 0,
  };
}

function parseTimestamp(block) {
  const datetime = String(block || "").match(/<time\b[^>]*datetime="([^"]+)"/i)?.[1];
  if (datetime) {
    const parsed = Date.parse(datetime);
    if (Number.isFinite(parsed)) return parsed;
  }
  return 0;
}

function parseTelegramMessages(html) {
  const source = String(html || "");
  const blocks = [];
  const wrapRe = /<div class="tgme_widget_message_wrap[\s\S]*?(?=<div class="tgme_widget_message_wrap|\s*<\/section>|\s*<\/body>|$)/gi;
  let wrapMatch;
  while ((wrapMatch = wrapRe.exec(source))) blocks.push(wrapMatch[0]);
  if (!blocks.length) blocks.push(source);

  const messages = [];
  for (const block of blocks) {
    const textMatch = block.match(/<div\b[^>]*class="[^"]*\btgme_widget_message_text\b[^"]*"[^>]*>([\s\S]*?)<\/div>/i);
    if (!textMatch) continue;
    const text = decodeHtml(textMatch[1]);
    const parsed = parseMessageText(text, parseTimestamp(block));
    if (parsed) messages.push(parsed);
  }

  const deduped = [];
  const seen = new Set();
  for (const msg of messages) {
    const key = msg.id || msg.link;
    if (seen.has(key)) continue;
    seen.add(key);
    deduped.push(msg);
  }
  return deduped.sort((a, b) => (b.timestamp || 0) - (a.timestamp || 0));
}

async function fetchTelegramMessages() {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), TELEGRAM_TIMEOUT_MS);
  try {
    const response = await fetch(TELEGRAM_CHANNEL, {
      signal: controller.signal,
      headers: {
        "User-Agent": process.env.TELEGRAM_USER_AGENT || DEFAULT_TELEGRAM_USER_AGENT,
        Accept: "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
        "Accept-Language": "en-AU,en;q=0.9",
      },
    });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    return await response.text();
  } finally {
    clearTimeout(timeout);
  }
}

function applyMessages(messages, html, fromCache = false) {
  cachedHtml = html || cachedHtml;
  const now = Date.now();
  lastFetchAt = now;
  if (!fromCache) lastSuccessAt = now;
  messageCount = messages.length;
  myMessageCount = messages.length;
  recentListings = messages.slice(0, MESSAGE_LIMIT);
  lastMessageAt = recentListings.reduce((max, msg) => Math.max(max, Number(msg.timestamp || 0)), 0);
  servedFromCache = fromCache;
}

async function pollTelegramMessages({ enabled = process.env.TELEGRAM_INVENTORY_ENABLED === "true", force = false } = {}) {
  if (!enabled) return getTelegramStatus({ enabled: false });
  const now = Date.now();
  if (!force && nextFetchAllowedAt && now < nextFetchAllowedAt) {
    return getTelegramStatus({ enabled: true });
  }

  try {
    const html = await fetchTelegramMessages();
    const messages = parseTelegramMessages(html);
    applyMessages(messages, html, false);
    consecutiveFailures = 0;
    nextFetchAllowedAt = 0;
    lastError = null;
  } catch (e) {
    lastError = e.message || String(e);
    const step = BACKOFF_STEPS_MS[Math.min(consecutiveFailures, BACKOFF_STEPS_MS.length - 1)];
    consecutiveFailures += 1;
    nextFetchAllowedAt = Date.now() + step;
    if (cachedHtml) {
      applyMessages(parseTelegramMessages(cachedHtml), cachedHtml, true);
    }
  }
  return getTelegramStatus({ enabled: true });
}

function getTelegramStatus({ enabled = process.env.TELEGRAM_INVENTORY_ENABLED === "true", staleMs = TELEGRAM_STALE_MS } = {}) {
  const now = Date.now();
  const stale = enabled && (!lastMessageAt || now - lastMessageAt > staleMs);
  let status = "disabled";
  if (enabled) status = lastError && !cachedHtml ? "error" : stale ? "stale" : "ok";
  if (enabled && lastError && cachedHtml) status = "degraded";
  return {
    enabled,
    status,
    stale,
    lastFetchAt,
    lastSuccessAt,
    lastMessageAt,
    messageCount,
    myMessageCount,
    lastError,
    consecutiveFailures,
    nextFetchAllowedAt,
    servedFromCache,
    staleMs,
    recentListings,
  };
}

module.exports = {
  fetchTelegramMessages,
  parseTelegramMessages,
  pollTelegramMessages,
  getTelegramStatus,
  TELEGRAM_CHANNEL,
};
