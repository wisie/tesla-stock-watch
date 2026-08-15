// Tesla Stock Watch — Server
// Polls Tesla AU inventory via headed Chrome scrapers.
// Persists VIN history, detects new vehicles, fires alerts.
// Serves web UI at http://localhost:3000

const express = require("express");
const path = require("path");
const fs = require("fs");
const os = require("os");
const crypto = require("crypto");
const { spawn } = require("child_process");
const {
  pollTelegramMessages,
  getTelegramStatus,
} = require("./telegram-ingest");

// Load .env if available
try {
  require("dotenv").config();
} catch (_) {}

const app = express();
app.use(express.json());

const PORT = process.env.PORT || 3000;
const POLL_INTERVAL = 60_000;
const SHOP_POLL_INTERVAL = 15 * 60 * 1000;
const DEPLOYMENT_MODE = process.env.DEPLOYMENT_MODE || "local";
const DATA_DIR = process.env.TESLA_DATA_DIR || __dirname;
const STATE_FILE = path.join(DATA_DIR, "vehicle-state.json");
const LOG_DIR = path.join(DATA_DIR, "logs");
const SERVER_LOG_FILE = path.join(LOG_DIR, "server.log");
const POLL_LOG_FILE = path.join(LOG_DIR, "poll-events.jsonl");
const BLOCK_EVENT_LOG_FILE = path.join(LOG_DIR, "block-events.jsonl");
const VEHICLE_EVENT_LOG_FILE = path.join(LOG_DIR, "vehicle-events.jsonl");
const STATE_BACKUP_DIR = path.join(LOG_DIR, "state-backups");
const LOG_MAX_BYTES = Number(process.env.LOG_MAX_BYTES || 5 * 1024 * 1024);
const LOG_BACKUPS = Number(process.env.LOG_BACKUPS || 3);
const STATE_SCHEMA_VERSION = 2;
const STATE_BACKUP_KEEP_DAYS = Number(process.env.STATE_BACKUP_KEEP_DAYS || 14);
const HOURLY_BACKUP_KEEP_HOURS = Number(process.env.HOURLY_BACKUP_KEEP_HOURS || 48);
const WATCHER_STALE_MS = Number(process.env.WATCHER_STALE_MS || 30 * 60 * 1000);
const WATCHER_ALERT_COOLDOWN_MS = Number(process.env.WATCHER_ALERT_COOLDOWN_MS || 30 * 60 * 1000);
const TESLA_BLOCK_COOLDOWN_MS = Number(process.env.TESLA_BLOCK_COOLDOWN_MS || 15 * 60 * 1000);
const TESLA_BLOCK_COOLDOWN_STEPS_MS = String(process.env.TESLA_BLOCK_COOLDOWN_STEPS_MS || `${15 * 60 * 1000},${60 * 60 * 1000},${2 * 60 * 60 * 1000},${4 * 60 * 60 * 1000}`)
  .split(",")
  .map((value) => Number(value.trim()))
  .filter((value) => Number.isFinite(value) && value > 0);
const TESLA_BLOCK_ALERT_COOLDOWN_MS = Number(process.env.TESLA_BLOCK_ALERT_COOLDOWN_MS || 4 * 60 * 60 * 1000);
const STRICT_HEALTH_STALE_MS = Number(process.env.STRICT_HEALTH_STALE_MS || 90 * 60 * 1000);
const KEYWORD_ALERT_COOLDOWN_MS = Number(process.env.KEYWORD_ALERT_COOLDOWN_MS || 4 * 60 * 60 * 1000);
const SHOP_ALERT_COOLDOWN_MS = Number(process.env.SHOP_ALERT_COOLDOWN_MS || 6 * 60 * 60 * 1000);
const POLL_DROP_THRESHOLD = Number(process.env.POLL_DROP_THRESHOLD || 0.5);
const POLL_DROP_MIN_VEHICLES = Number(process.env.POLL_DROP_MIN_VEHICLES || 3);
const MATCH_ALERT_COOLDOWN_MS = Number(process.env.MATCH_ALERT_COOLDOWN_MS || 5 * 60 * 1000);
const RECENT_POLLS_LIMIT = Number(process.env.RECENT_POLLS_LIMIT || 20);
const MEMORY_SAMPLE_LIMIT = Number(process.env.MEMORY_SAMPLE_LIMIT || 20);
const CHROME_MAX_AGE_MS = Number(process.env.CHROME_MAX_AGE_MS || 24 * 60 * 60 * 1000);
const CHROME_MAX_PROCESSES = Number(process.env.CHROME_MAX_PROCESSES || 35);
const CHROME_MAX_PAGES = Number(process.env.CHROME_MAX_PAGES || 6);
const MAX_TRACKED_VEHICLE_AGE_MS = Number(process.env.MAX_TRACKED_VEHICLE_AGE_MS || 60 * 24 * 60 * 60 * 1000);
const TRIP_MODE_POLL_INTERVAL_MS = Number(process.env.TRIP_MODE_POLL_INTERVAL_MS || 5 * 60 * 1000);
const TRIP_MODE_SHOP_POLL_INTERVAL_MS = Number(process.env.TRIP_MODE_SHOP_POLL_INTERVAL_MS || 30 * 60 * 1000);
const BUSINESS_TIMEZONE = process.env.BUSINESS_TIMEZONE || "Australia/Melbourne";
const BUSINESS_HOURS_START = Number(process.env.BUSINESS_HOURS_START || 6);
const BUSINESS_HOURS_END = Number(process.env.BUSINESS_HOURS_END || 22);
const ACTIVE_POLL_INTERVAL_MS = Number(process.env.ACTIVE_POLL_INTERVAL_MS || 15 * 60 * 1000);
const QUIET_POLL_INTERVAL_MS = Number(process.env.QUIET_POLL_INTERVAL_MS || 2 * 60 * 60 * 1000);
const ACTIVE_MAX_PAGES = Number(process.env.ACTIVE_MAX_PAGES || 4);
const QUIET_MAX_PAGES = Number(process.env.QUIET_MAX_PAGES || 2);
const STARTUP_GRACE_MS = Number(process.env.STARTUP_GRACE_MS || 5 * 60 * 1000);
const STARTUP_GRACE_RECENT_SUCCESS_MS = Number(process.env.STARTUP_GRACE_RECENT_SUCCESS_MS || 30 * 60 * 1000);
const POST_BLOCK_CAUTION_MS = Number(process.env.POST_BLOCK_CAUTION_MS || 2 * 60 * 60 * 1000);
const POST_BLOCK_CAUTION_POLL_INTERVAL_MS = Number(process.env.POST_BLOCK_CAUTION_POLL_INTERVAL_MS || 30 * 60 * 1000);
const POST_BLOCK_CAUTION_MAX_PAGES = Number(process.env.POST_BLOCK_CAUTION_MAX_PAGES || 1);
const POST_BLOCK_SHOP_SUPPRESS_MS = Number(process.env.POST_BLOCK_SHOP_SUPPRESS_MS || 30 * 60 * 1000);
const TESLA_REQUEST_DAILY_SOFT_LIMIT = Number(process.env.TESLA_REQUEST_DAILY_SOFT_LIMIT || 120);
const TESLA_REQUEST_HOURLY_SOFT_LIMIT = Number(process.env.TESLA_REQUEST_HOURLY_SOFT_LIMIT || 12);
const TESLA_REQUEST_BUDGET_POLL_INTERVAL_MS = Number(process.env.TESLA_REQUEST_BUDGET_POLL_INTERVAL_MS || 2 * 60 * 60 * 1000);
const BROWSER_BACKOFF_FAILURE_THRESHOLD = Number(process.env.BROWSER_BACKOFF_FAILURE_THRESHOLD || 2);
const BROWSER_BACKOFF_MS = Number(process.env.BROWSER_BACKOFF_MS || 20 * 60 * 1000);
const DIRECT_INVENTORY_ENABLED = process.env.DIRECT_INVENTORY_ENABLED !== "false" && process.env.DISABLE_DIRECT_POLLING !== "true";
const TELEGRAM_INVENTORY_ENABLED = process.env.TELEGRAM_INVENTORY_ENABLED === "true";
const TELEGRAM_POLL_INTERVAL_MS = Number(process.env.TELEGRAM_POLL_INTERVAL_MS || 30 * 60 * 1000);
const BOTH_SOURCES_STALE_MS = Number(process.env.BOTH_SOURCES_STALE_MS || 2 * 60 * 60 * 1000);
const BUSINESS_START_POLL_JITTER_MS = Number(process.env.BUSINESS_START_POLL_JITTER_MS || 5 * 60 * 1000);
const AUTO_DOM_FALLBACK_ENABLED = process.env.AUTO_DOM_FALLBACK_ENABLED !== "false";
const AUTO_DOM_FALLBACK_AFTER_MS = Number(process.env.AUTO_DOM_FALLBACK_AFTER_MS || BOTH_SOURCES_STALE_MS);
const TESLA_PRESSURE_BLOCK_THRESHOLD = Number(process.env.TESLA_PRESSURE_BLOCK_THRESHOLD || 3);
const TESLA_PRESSURE_POLL_INTERVAL_MS = Number(process.env.TESLA_PRESSURE_POLL_INTERVAL_MS || 45 * 60 * 1000);
const TESLA_PRESSURE_MODE_MS = Number(process.env.TESLA_PRESSURE_MODE_MS || 0);
const PROXY_FAILOVER_ENABLED = process.env.PROXY_FAILOVER_ENABLED === "true";
const CHROME_PROXY_SERVER = process.env.CHROME_PROXY_SERVER || "";
const SHOP_SCRAPE_MODE = process.env.SHOP_SCRAPE_MODE || "browser";
const SHOP_FRESH_MS = 24 * 60 * 60 * 1000;
const ALERT_TESTS_ENABLED = process.env.ALERT_TESTS_ENABLED === "true";
const LOCAL_SOUND_AVAILABLE = process.platform === "darwin";
const MONITORED_STATES = parseMonitoredStates(process.env.MONITORED_STATES || process.env.WATCH_STATES || "VIC");
const MONITORED_STATE_SET = new Set(MONITORED_STATES);
const MONITORED_MAX_PAGES = Number(process.env.MONITORED_MAX_PAGES || process.env.WATCH_MAX_PAGES || (MONITORED_STATES.length === 1 && MONITORED_STATES[0] === "VIC" ? 1 : 0));
const BUILD_VERSION = computeBuildVersion();
let realAlertsEnabledValue = process.env.REAL_ALERTS_ENABLED !== "false";
let alertsSnoozedUntil = 0;
let alertsSnoozeTimer = null;

function normalizeStateCode(value) {
  return String(value || "").trim().toUpperCase();
}

function parseMonitoredStates(value) {
  const states = String(value || "")
    .split(",")
    .map(normalizeStateCode)
    .filter((state) => state && state !== "ALL");
  return [...new Set(states)];
}

function isMonitoredState(state) {
  return MONITORED_STATE_SET.size === 0 || MONITORED_STATE_SET.has(normalizeStateCode(state));
}

function filterMonitoredVehicles(items) {
  return MONITORED_STATE_SET.size === 0 ? (items || []) : (items || []).filter((v) => isMonitoredState(v.state));
}

function defaultTargetState() {
  return MONITORED_STATES.length === 1 ? MONITORED_STATES[0] : "all";
}

function normalizeTargetConfig(config) {
  const next = { ...config };
  if (MONITORED_STATES.length === 1) {
    next.state = MONITORED_STATES[0];
  } else if (next.state && next.state !== "all" && !isMonitoredState(next.state)) {
    next.state = "all";
  }
  return next;
}

function realAlertsEnabled() {
  if (alertsSnoozedUntil && Date.now() >= alertsSnoozedUntil) {
    setRealAlertsEnabled(true, { clearSnooze: true, save: true, reason: "snoozeExpired" });
  }
  return realAlertsEnabledValue;
}

function setRealAlertsEnabled(enabled, opts = {}) {
  realAlertsEnabledValue = !!enabled;
  if (opts.clearSnooze !== false) {
    alertsSnoozedUntil = 0;
    if (alertsSnoozeTimer) clearTimeout(alertsSnoozeTimer);
    alertsSnoozeTimer = null;
  }
  if (!state.watcher) state.watcher = {};
  state.watcher.realAlertsEnabled = realAlertsEnabledValue;
  state.watcher.alertsSnoozedUntil = alertsSnoozedUntil;
  if (opts.save) saveState(state);
  if (opts.reason) console.log(`[server] Real alerts ${realAlertsEnabledValue ? "enabled" : "disabled"} (${opts.reason})`);
}

function scheduleAlertsSnooze(durationMs) {
  alertsSnoozedUntil = Date.now() + durationMs;
  realAlertsEnabledValue = false;
  if (alertsSnoozeTimer) clearTimeout(alertsSnoozeTimer);
  alertsSnoozeTimer = setTimeout(() => {
    setRealAlertsEnabled(true, { clearSnooze: true, save: true, reason: "snooze expired" });
  }, durationMs);
  if (!state.watcher) state.watcher = {};
  state.watcher.realAlertsEnabled = false;
  state.watcher.alertsSnoozedUntil = alertsSnoozedUntil;
  saveState(state);
  console.log(`[server] Real alerts snoozed for ${Math.round(durationMs / 60000)}m`);
}

function todayKey() {
  return new Date().toISOString().slice(0, 10);
}

function hourKey() {
  return new Date().toISOString().slice(0, 13).replace(/[-:T]/g, "");
}

function computeBuildVersion() {
  try {
    const files = ["server.js", "telegram-ingest.js", "scraper-dom.js", "scraper-fallback.js", "scraper.js", "scraper-shop.js", "app-min.jsx", "tweaks-panel.jsx", "minimal.css", "data.js", "index.html", "scripts/build-ui.js", "scripts/react-shim.js", "scripts/ui-entry.js"];
    const hash = crypto.createHash("sha1");
    for (const file of files) {
      const full = path.join(__dirname, file);
      if (fs.existsSync(full)) hash.update(file).update(fs.readFileSync(full));
    }
    return hash.digest("hex").slice(0, 12);
  } catch (_) {
    return "unknown";
  }
}

function fileStat(filePath) {
  try {
    const stat = fs.statSync(filePath);
    return { size: stat.size, mtime: stat.mtimeMs };
  } catch (_) {
    return { size: 0, mtime: 0 };
  }
}

function readNumberFile(candidates) {
  for (const file of candidates) {
    try {
      if (!fs.existsSync(file)) continue;
      const raw = fs.readFileSync(file, "utf-8").trim();
      if (raw === "max") return null;
      const value = Number(raw);
      if (Number.isFinite(value)) return value;
    } catch (_) {}
  }
  return null;
}

function containerMemoryStats() {
  return {
    containerMemoryUsageBytes: readNumberFile([
      "/sys/fs/cgroup/memory.current",
      "/sys/fs/cgroup/memory/memory.usage_in_bytes",
    ]),
    containerMemoryLimitBytes: readNumberFile([
      "/sys/fs/cgroup/memory.max",
      "/sys/fs/cgroup/memory/memory.limit_in_bytes",
    ]),
  };
}

let memorySamples = [];
let memoryPeakBytes = 0;

function recordMemorySample(stats = containerMemoryStats(), now = Date.now()) {
  const usage = stats.containerMemoryUsageBytes;
  if (!Number.isFinite(usage) || usage <= 0) return;
  memoryPeakBytes = Math.max(memoryPeakBytes, usage);
  memorySamples.push({ t: now, usage });
  if (memorySamples.length > MEMORY_SAMPLE_LIMIT) {
    memorySamples = memorySamples.slice(-MEMORY_SAMPLE_LIMIT);
  }
}

function memoryTrend() {
  const recentPeak = memorySamples.reduce((max, sample) => Math.max(max, sample.usage), 0);
  const first = memorySamples[0]?.usage || 0;
  const last = memorySamples[memorySamples.length - 1]?.usage || 0;
  return {
    memorySampleCount: memorySamples.length,
    memoryPeakBytes,
    memoryRecentPeakBytes: recentPeak,
    memoryTrendBytes: first && last ? last - first : 0,
  };
}

async function refreshExternalNetworkIdentity(reason = "manual") {
  const now = Date.now();
  if (externalNetworkIdentity && now - externalNetworkIdentityCheckedAt < 6 * 60 * 60 * 1000) {
    return externalNetworkIdentity;
  }
  if (typeof fetch !== "function") return externalNetworkIdentity;
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 5000);
  try {
    const response = await fetch("https://ipinfo.io/json", {
      signal: controller.signal,
      headers: { Accept: "application/json" },
    });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    const data = await response.json();
    externalNetworkIdentity = {
      ip: data.ip || "",
      org: data.org || "",
      city: data.city || "",
      region: data.region || "",
      country: data.country || "",
      timezone: data.timezone || "",
      reason,
    };
    externalNetworkIdentityCheckedAt = Date.now();
    persistWatcherMeta();
    saveState(state);
    console.log(`[server] networkIdentity=${externalNetworkIdentity.ip || "unknown"} ${externalNetworkIdentity.org || ""}`.trim());
  } catch (e) {
    externalNetworkIdentity = externalNetworkIdentity || { error: e.message };
    externalNetworkIdentityCheckedAt = Date.now();
    console.warn(`[server] Network identity lookup failed: ${e.message}`);
  } finally {
    clearTimeout(timeout);
  }
  return externalNetworkIdentity;
}

// ── Scraper imports (lazy) ────────────────────────────────────────────────────
let mainScraper = null;     // plain puppeteer — confirmed working
let stealthScraper = null;  // puppeteer-extra + stealth — redundancy
const { PRODUCTS: SHOP_PRODUCTS, scrapeShopProducts, scrapeShopProductsByFetch } = require("./scraper-shop");

function loadScrapers() {
  try {
    mainScraper = require("./scraper-fallback");
    console.log("[server] Main scraper (puppeteer) loaded");
  } catch (e) {
    console.warn("[server] Main scraper unavailable:", e.message);
  }
  try {
    stealthScraper = require("./scraper");
    console.log("[server] Stealth scraper (puppeteer-extra) loaded");
  } catch (e) {
    console.warn("[server] Stealth scraper unavailable:", e.message);
  }
}

// ── Option code maps (confirmed from live AU API, Jun 2026) ──────────────────
const PAINT_MAP = {
  DIAMOND_BLACK: "Diamond Black",
  STEALTH_GREY: "Stealth Grey",
  WHITE: "Pearl White",
  GLACIER: "Glacier Blue",
  RED: "Ultra Red",
  SILVER: "Quicksilver",
  COSMIC_SILVER: "Cosmic Silver",
};

const INTERIOR_MAP = {
  PREMIUM_BLACK: "Black",
  PREMIUM_WHITE: "White",
  BLACK: "Black",
  WHITE: "White",
};

function lookupPaint(optionCodeData, rawCodes) {
  if (optionCodeData) {
    const entry = optionCodeData.find((o) => o.group === "PAINT");
    if (entry?.name) return entry.name;
  }
  for (const c of rawCodes || []) {
    if (PAINT_MAP[c]) return PAINT_MAP[c];
  }
  return rawCodes?.[0] || "Unknown";
}

function lookupInterior(optionCodeData, rawCodes) {
  if (optionCodeData) {
    const entry = optionCodeData.find((o) => o.group === "INTERIOR");
    if (entry?.name) {
      const n = entry.name.toLowerCase();
      if (n.includes("zen grey")) return "White";
      if (n.includes("cream")) return "White";
      if (n.includes("white")) return "White";
      if (n.includes("black")) return "Black";
      return entry.name;
    }
  }
  for (const c of rawCodes || []) {
    if (INTERIOR_MAP[c]) return INTERIOR_MAP[c];
    if (c.includes("WHITE") || c.includes("CREAM")) return "White";
    if (c.includes("BLACK")) return "Black";
  }
  return rawCodes?.[0] || "Unknown";
}

function lookupWheels(optionCodeData, rawCodes) {
  if (optionCodeData) {
    const entry = optionCodeData.find((o) => o.group === "WHEELS");
    if (entry?.name) return entry.name;
  }
  return rawCodes?.[0] || "—";
}

function normalise(raw) {
  const oc = raw.OptionCodeData || [];
  const paintCodes = raw.PAINT || [];
  const interiorCodes = raw.INTERIOR || [];
  const wheelsCodes = raw.WHEELS || [];
  const cabinCodes = raw.CABIN_CONFIG || [];

  const hash = raw.Hash || raw.VIN || "";
  const vinDisplay = raw.VIN || "";

  return {
    id: hash,
    hash,
    vinDisplay,
    state: raw.StateProvince || "?",
    location: raw.City || "?",
    vrlName: raw.VrlName || "",
    exterior: lookupPaint(oc, paintCodes),
    interior: lookupInterior(oc, interiorCodes),
    wheels: lookupWheels(oc, wheelsCodes),
    price: raw.TotalPrice ?? raw.InventoryPrice ?? 0,
    discount: raw.Discount || 0,
    trimName: raw.TrimName || "",
    cabinConfig: Array.isArray(cabinCodes) ? cabinCodes.join(",") : cabinCodes || "",
    drive: Array.isArray(raw.DRIVE) ? raw.DRIVE.join(",") : raw.DRIVE || "",
    isDemo: raw.IsDemo === true || raw.IsDemo === "true",
    inTransit: raw.InTransit === true || raw.InTransit === "true",
    odometer: raw.Odometer ?? 0,
    year: raw.Year || 0,
    appeared: Date.now(),
  };
}

// ── Target config (which vehicles trigger alerts) ────────────────────────────
const DEFAULT_TARGET = {
  exterior: ["Stealth Grey", "Diamond Black"],
  interior: ["Black", "White"],
  cabinConfig: "SIX",
  trimKeywords: ["Premium All-Wheel Drive"],
  state: defaultTargetState(),
  excludeDemo: true,
};

let targetConfig = normalizeTargetConfig({ ...DEFAULT_TARGET });

function trimTokens(value) {
  return String(value || "").toLowerCase().split(/[^a-z0-9]+/).filter(Boolean);
}

function trimKeywordMatches(trimName, keyword) {
  const trimSet = new Set(trimTokens(trimName));
  const keywordTokens = trimTokens(keyword);
  return keywordTokens.length > 0 && keywordTokens.every((token) => trimSet.has(token));
}

function matchesTarget(v) {
  if (!isMonitoredState(v.state)) return false;
  if (targetConfig.exterior.length && !targetConfig.exterior.includes(v.exterior))
    return false;
  if (targetConfig.interior.length && !targetConfig.interior.includes(v.interior))
    return false;
  if (targetConfig.cabinConfig && !v.cabinConfig.includes(targetConfig.cabinConfig))
    return false;
  const trimKeywords = Array.isArray(targetConfig.trimKeywords) ? targetConfig.trimKeywords : [];
  if (
    trimKeywords.length &&
    !trimKeywords.some((keyword) => trimKeywordMatches(v.trimName, keyword))
  ) return false;
  if (targetConfig.state && targetConfig.state !== "all" && v.state !== targetConfig.state)
    return false;
  if (targetConfig.excludeDemo && v.isDemo) return false;
  return true;
}

function countTrimKeywordMatches(items) {
  const trimKeywords = Array.isArray(targetConfig.trimKeywords) ? targetConfig.trimKeywords : [];
  if (!trimKeywords.length) return 0;
  return filterMonitoredVehicles(items).filter((v) =>
    trimKeywords.some((keyword) => trimKeywordMatches(v.trimName, keyword))
  ).length;
}

function countKeywordHealthCandidates(items) {
  const cabinConfig = String(targetConfig.cabinConfig || "").trim();
  if (!cabinConfig) return 0;
  return filterMonitoredVehicles(items).filter((v) =>
    !v.removed && String(v.cabinConfig || "").includes(cabinConfig)
  ).length;
}

function keywordCandidateSummaries(items, limit = 5) {
  const trimKeywords = Array.isArray(targetConfig.trimKeywords) ? targetConfig.trimKeywords : [];
  if (!trimKeywords.length) return [];
  return filterMonitoredVehicles(items)
    .filter((v) => !v.removed && trimKeywords.some((keyword) => trimKeywordMatches(v.trimName, keyword)))
    .sort((a, b) => {
      const aSix = String(a.cabinConfig || "").includes("SIX") ? 1 : 0;
      const bSix = String(b.cabinConfig || "").includes("SIX") ? 1 : 0;
      if (aSix !== bSix) return bSix - aSix;
      return (b.firstSeen || b.appeared || 0) - (a.firstSeen || a.appeared || 0);
    })
    .slice(0, limit)
    .map((v) => ({
      id: v.id,
      state: v.state,
      location: v.location,
      trimName: v.trimName,
      exterior: v.exterior,
      interior: v.interior,
      cabinConfig: v.cabinConfig,
      price: v.price,
      exactTarget: matchesTarget(v),
    }));
}

function sixSeatCandidateSummaries(items, limit = 10) {
  const trimKeywords = Array.isArray(targetConfig.trimKeywords) ? targetConfig.trimKeywords : [];
  return filterMonitoredVehicles(items)
    .filter((v) => {
      if (v.removed) return false;
      if (!String(v.cabinConfig || "").includes(targetConfig.cabinConfig || "SIX")) return false;
      const trim = String(v.trimName || "").toLowerCase();
      const ylNameMatch = trim.includes("model y l");
      const keywordMatch = trimKeywords.length && trimKeywords.some((keyword) => trimKeywordMatches(v.trimName, keyword));
      return ylNameMatch || keywordMatch;
    })
    .sort((a, b) => (b.firstSeen || b.appeared || 0) - (a.firstSeen || a.appeared || 0))
    .slice(0, limit)
    .map((v) => ({
      id: v.id,
      state: v.state,
      location: v.location,
      trimName: v.trimName,
      exterior: v.exterior,
      interior: v.interior,
      cabinConfig: v.cabinConfig,
      price: v.price,
      inTransit: !!v.inTransit,
      isDemo: !!v.isDemo,
      exactTarget: matchesTarget(v),
    }));
}

function updateKeywordHealth(items, now = Date.now(), opts = {}) {
  keywordMatchCount = countTrimKeywordMatches(items);
  keywordHealthCandidateCount = countKeywordHealthCandidates(items);
  keywordHealthy = keywordMatchCount > 0 || keywordHealthCandidateCount === 0;
  if (keywordHealthy && keywordStaleAlerted) {
    keywordStaleAlerted = false;
    persistWatcherMeta();
    saveState(state);
  }
  if (!opts.suppressAlert && !keywordHealthy && !keywordStaleAlerted && realAlertsEnabled() && now - keywordLastAlertAt > KEYWORD_ALERT_COOLDOWN_MS) {
    keywordStaleAlerted = true;
    keywordLastAlertAt = now;
    persistWatcherMeta();
    saveState(state);
    fireServiceAlert("keywordStale", {
      keywordMatchCount,
      keywordHealthCandidateCount,
      totalVehicles: (items || []).length,
      keywords: Array.isArray(targetConfig.trimKeywords) ? targetConfig.trimKeywords : [],
    });
  }
}

// ── State persistence ────────────────────────────────────────────────────────
let persistedStateExisted = fs.existsSync(STATE_FILE);

function validateStateShape(candidate) {
  const warnings = [];
  const next = candidate && typeof candidate === "object" ? candidate : {};
  if (!next.watcher || typeof next.watcher !== "object") next.watcher = {};
  if (!next.vehicles || typeof next.vehicles !== "object" || Array.isArray(next.vehicles)) {
    warnings.push("vehicles object missing or invalid");
    next.vehicles = {};
  }
  if (!next.shopProducts || typeof next.shopProducts !== "object" || Array.isArray(next.shopProducts)) {
    next.shopProducts = {};
  }

  for (const [hash, vehicle] of Object.entries(next.vehicles)) {
    if (!vehicle || typeof vehicle !== "object") {
      delete next.vehicles[hash];
      warnings.push(`removed invalid vehicle ${hash}`);
      continue;
    }
    if (!Array.isArray(vehicle.priceHistory)) {
      vehicle.priceHistory = vehicle.price ? [{ t: vehicle.lastSeen || Date.now(), p: vehicle.price }] : [];
    }
    if (vehicle.baseline === undefined) vehicle.baseline = true;
  }

  for (const [id, product] of Object.entries(next.shopProducts)) {
    if (!product || typeof product !== "object") {
      delete next.shopProducts[id];
      warnings.push(`removed invalid shop product ${id}`);
      continue;
    }
    product.id = product.id || id;
    product.name = product.name || id;
    product.url = product.url || "";
    product.status = ["in_stock", "out_of_stock", "unknown", "blocked"].includes(product.status) ? product.status : "unknown";
    product.lastInStockAt = Number(product.lastInStockAt || 0);
    product.lastCheckedAt = Number(product.lastCheckedAt || product.checkedAt || 0);
    product.lastAlertAt = Number(product.lastAlertAt || 0);
    product.alertsSent = Number(product.alertsSent || 0);
  }

  next.schemaVersion = STATE_SCHEMA_VERSION;
  next.lastValidated = Date.now();
  next.validation = {
    ok: warnings.length === 0,
    warnings,
    checkedAt: next.lastValidated,
  };
  return next;
}

function loadState() {
  try {
    if (fs.existsSync(STATE_FILE)) {
      const raw = fs.readFileSync(STATE_FILE, "utf-8");
      return validateStateShape(JSON.parse(raw));
    }
  } catch (e) {
    console.error("[server] Corrupt state file, starting fresh:", e.message);
    const broken = STATE_FILE + ".broken." + Date.now();
    try { fs.renameSync(STATE_FILE, broken); } catch (_) {}
    persistedStateExisted = false;
  }
  return validateStateShape({ watcher: { startedAt: Date.now(), alertsSent: 0 }, vehicles: {} });
}

function pruneStateBackups() {
  try {
    if (!fs.existsSync(STATE_BACKUP_DIR)) return;
    const dailyBackups = fs.readdirSync(STATE_BACKUP_DIR)
      .filter((name) => /^vehicle-state-\d{4}-\d{2}-\d{2}\.json$/.test(name))
      .sort()
      .reverse();
    for (const old of dailyBackups.slice(STATE_BACKUP_KEEP_DAYS)) {
      fs.unlinkSync(path.join(STATE_BACKUP_DIR, old));
    }

    const hourlyBackups = fs.readdirSync(STATE_BACKUP_DIR)
      .filter((name) => /^vehicle-state-hour-\d{10}\.json$/.test(name))
      .sort()
      .reverse();
    for (const old of hourlyBackups.slice(HOURLY_BACKUP_KEEP_HOURS)) {
      fs.unlinkSync(path.join(STATE_BACKUP_DIR, old));
    }
  } catch (e) {
    console.warn("[server] Failed to prune state backups:", e.message);
  }
}

function backupStateFile() {
  try {
    if (!fs.existsSync(STATE_FILE)) return;
    fs.mkdirSync(STATE_BACKUP_DIR, { recursive: true });
    const backup = path.join(STATE_BACKUP_DIR, `vehicle-state-${todayKey()}.json`);
    if (!fs.existsSync(backup)) {
      fs.copyFileSync(STATE_FILE, backup);
    }
    const hourly = path.join(STATE_BACKUP_DIR, `vehicle-state-hour-${hourKey()}.json`);
    if (!fs.existsSync(hourly)) {
      fs.copyFileSync(STATE_FILE, hourly);
    }
    pruneStateBackups();
  } catch (e) {
    console.warn("[server] Failed to backup state:", e.message);
  }
}

function backupStats() {
  try {
    if (!fs.existsSync(STATE_BACKUP_DIR)) {
      return { backupCount: 0, latestBackupAt: 0, latestBackupValid: false, latestBackupVehicleCount: 0 };
    }
    const backups = fs.readdirSync(STATE_BACKUP_DIR)
      .filter((name) => /^vehicle-state-(hour-\d{10}|\d{4}-\d{2}-\d{2})\.json$/.test(name))
      .map((name) => {
        const full = path.join(STATE_BACKUP_DIR, name);
        const stat = fs.statSync(full);
        return { name, full, mtime: stat.mtimeMs };
      })
      .sort((a, b) => b.mtime - a.mtime);
    if (!backups.length) {
      return { backupCount: 0, latestBackupAt: 0, latestBackupValid: false, latestBackupVehicleCount: 0 };
    }
    const latest = backups[0];
    try {
      const parsed = JSON.parse(fs.readFileSync(latest.full, "utf-8"));
      const vehicleCount = Object.keys(parsed.vehicles || {}).length;
      return {
        backupCount: backups.length,
        latestBackupAt: latest.mtime,
        latestBackupValid: !!parsed.vehicles && vehicleCount > 0,
        latestBackupVehicleCount: vehicleCount,
      };
    } catch (_) {
      return { backupCount: backups.length, latestBackupAt: latest.mtime, latestBackupValid: false, latestBackupVehicleCount: 0 };
    }
  } catch (e) {
    return { backupCount: 0, latestBackupAt: 0, latestBackupValid: false, latestBackupVehicleCount: 0, backupError: e.message };
  }
}

function rotateFile(filePath, maxBytes = LOG_MAX_BYTES, backups = LOG_BACKUPS) {
  try {
    const stat = fs.statSync(filePath);
    if (stat.size <= maxBytes) return;
    for (let i = backups - 1; i >= 1; i--) {
      const from = `${filePath}.${i}`;
      const to = `${filePath}.${i + 1}`;
      if (fs.existsSync(from)) fs.renameSync(from, to);
    }
    fs.renameSync(filePath, `${filePath}.1`);
  } catch (_) {}
}

function saveState(state) {
  const tmp = STATE_FILE + ".tmp";
  try {
    fs.mkdirSync(path.dirname(STATE_FILE), { recursive: true });
    backupStateFile();
    state.schemaVersion = STATE_SCHEMA_VERSION;
    state.lastValidated = Date.now();
    state.lastSaved = Date.now();
    state.lastPollSuccess = lastSuccessAt || state.watcher?.lastSuccessAt || 0;
    state.vehicleCount = Array.isArray(vehicles)
      ? vehicles.length
      : Object.values(state.vehicles || {}).filter((v) => !v.removedAt).length;
    state.shopProducts = shopProducts || state.shopProducts || {};
    state.targetConfig = targetConfig;
    if (!state.watcher) state.watcher = {};
    persistWatcherMeta();
    state.watcher.lastSaved = state.lastSaved;
    state.watcher.lastPollSuccess = state.lastPollSuccess;
    state.watcher.vehicleCount = state.vehicleCount;
    state.watcher.targetConfig = targetConfig;
    state.watcher.schemaVersion = STATE_SCHEMA_VERSION;
    lastStateSave = state.lastSaved;
    fs.writeFileSync(tmp, JSON.stringify(state, null, 2), "utf-8");
    fs.renameSync(tmp, STATE_FILE);
  } catch (e) {
    console.error("[server] Failed to save state:", e.message);
    try { fs.unlinkSync(tmp); } catch (_) {}
  }
}

function updatePersistedVehicle(target, v, now, firstSeen) {
  target.firstSeen = firstSeen;
  target.lastSeen = now;
  target.removedAt = null;
  target.hash = v.hash;
  target.vinDisplay = v.vinDisplay;
  target.state = v.state;
  target.city = v.location;
  target.vrlName = v.vrlName;
  target.exterior = v.exterior;
  target.interior = v.interior;
  target.wheels = v.wheels;
  target.trimName = v.trimName;
  target.cabinConfig = v.cabinConfig;
  target.drive = v.drive;
  target.isDemo = v.isDemo;
  target.inTransit = v.inTransit;
  target.odometer = v.odometer;
  target.year = v.year;
  target.price = v.price;
  target.discount = v.discount;
  if (target.baseline === undefined) target.baseline = false;
}

function vehicleFromPersisted(hash, pv) {
  const priceHistory = Array.isArray(pv.priceHistory) ? pv.priceHistory : [];
  const lastPrice = priceHistory.length ? priceHistory[priceHistory.length - 1].p : pv.price || 0;
  return {
    id: hash,
    hash: pv.hash || hash,
    vinDisplay: pv.vinDisplay || "",
    state: pv.state || "?",
    location: pv.city || "?",
    vrlName: pv.vrlName || "",
    exterior: pv.exterior || "Unknown",
    interior: pv.interior || "Unknown",
    wheels: pv.wheels || "—",
    price: lastPrice,
    discount: pv.discount || 0,
    trimName: pv.trimName || "",
    cabinConfig: pv.cabinConfig || "",
    drive: pv.drive || "",
    isDemo: pv.isDemo || false,
    inTransit: pv.inTransit || false,
    odometer: pv.odometer || 0,
    year: pv.year || 0,
    baseline: pv.baseline === true,
    firstSeen: pv.firstSeen || Date.now(),
    lastSeen: pv.lastSeen || Date.now(),
    priceHistory,
  };
}

// ── In-memory state (loaded at startup, updated each poll) ───────────────────
let state = loadState();
if (state.targetConfig || state.watcher?.targetConfig) {
  targetConfig = normalizeTargetConfig({ ...targetConfig, ...(state.targetConfig || state.watcher.targetConfig) });
  state.targetConfig = targetConfig;
  if (!state.watcher) state.watcher = {};
  state.watcher.targetConfig = targetConfig;
}
let vehicles = Object.entries(state.vehicles || {})
  .filter(([, pv]) => !pv.removedAt && isMonitoredState(pv.state))
  .map(([hash, pv]) => vehicleFromPersisted(hash, pv)); // current normalised vehicles
let rawInventory = null;          // last raw Tesla payload for local debugging
let domDisplayVehicles = [];
let newHashes = [];              // hashes newly detected this poll
let targetVersion = 0;            // incremented when the UI/test changes target config
let lastPollAt = state.watcher.lastPollAt || 0;
let lastSuccessAt = state.watcher.lastSuccessAt || 0;
let lastSource = state.watcher.lastSource || "";
let totalPolls = state.watcher.totalPolls || 0;
let failedPolls = state.watcher.failedPolls || 0;
let alertsSent = state.watcher.alertsSent || 0;
let stale = !lastSuccessAt || Date.now() - lastSuccessAt > WATCHER_STALE_MS;
let lastStateSave = state.lastSaved || state.watcher.lastSaved || 0;
let consecutiveFailedPolls = state.watcher.consecutiveFailedPolls || 0;
let lastFailureAt = state.watcher.lastFailureAt || 0;
let lastRecoveryAt = state.watcher.lastRecoveryAt || 0;
let lastError = state.watcher.lastError || null;
let teslaBlockCooldownUntil = state.watcher.teslaBlockCooldownUntil || 0;
let consecutiveTeslaBlocks = Number(state.watcher.consecutiveTeslaBlocks || 0);
let lastTeslaBlockAlertAt = Number(state.watcher.lastTeslaBlockAlertAt || 0);
let teslaBlockAlerted = !!state.watcher.teslaBlockAlerted && consecutiveTeslaBlocks > 0;
let lastTeslaBlockCooldownLogAt = 0;
let teslaBlockDay = state.watcher.teslaBlockDay || "";
let teslaBlockDayCount = Number(state.watcher.teslaBlockDayCount || 0);
let teslaPressureModeUntil = Number(state.watcher.teslaPressureModeUntil || 0);
let browserLaunchFailures = Number(state.watcher.browserLaunchFailures || 0);
let lastBrowserLaunchError = state.watcher.lastBrowserLaunchError || null;
let browserBackoffUntil = Number(state.watcher.browserBackoffUntil || 0);
let lastBrowserBackoffLogAt = 0;
let postBlockCautionUntil = Number(state.watcher.postBlockCautionUntil || 0);
let shopSuppressedUntil = Number(state.watcher.shopSuppressedUntil || 0);
let startupGraceUntil = 0;
let teslaRequestStats = state.watcher.teslaRequestStats || {};
let lastBlockEventAt = Number(state.watcher.lastBlockEventAt || 0);
let lastBlockPhase = state.watcher.lastBlockPhase || "";
let lastCookieState = state.watcher.lastCookieState || null;
let externalNetworkIdentity = state.watcher.externalNetworkIdentity || null;
let externalNetworkIdentityCheckedAt = Number(state.watcher.externalNetworkIdentityCheckedAt || 0);
let recoveringFromTeslaBlock = false;
let watcherOutageAlerted = !!state.watcher.watcherOutageAlerted;
let lastWatcherAlertAt = state.watcher.lastWatcherAlertAt || 0;
let lastBothSourcesStaleAlertAt = state.watcher.lastBothSourcesStaleAlertAt || 0;
let bothSourcesStaleAlerted = !!state.watcher.bothSourcesStaleAlerted;
let lastMatchAlertAt = state.watcher.lastMatchAlertAt || 0;
let keywordMatchCount = countTrimKeywordMatches(vehicles);
let keywordHealthCandidateCount = countKeywordHealthCandidates(vehicles);
let keywordHealthy = keywordMatchCount > 0 || keywordHealthCandidateCount === 0;
let keywordStaleAlerted = !!state.watcher.keywordStaleAlerted && !keywordHealthy;
let keywordLastAlertAt = state.watcher.keywordLastAlertAt || state.watcher.lastKeywordAlertAt || 0;
let lastExactMatchTestAt = state.watcher.lastExactMatchTestAt || 0;
let shopProducts = state.shopProducts || {};
let lastShopPollAt = state.watcher.lastShopPollAt || 0;
let lastShopPollError = state.watcher.lastShopPollError || null;
let tripModeEnabled = typeof state.watcher.tripModeEnabled === "boolean"
  ? state.watcher.tripModeEnabled
  : process.env.TRIP_MODE === "true";
if (state.watcher.alertsSnoozedUntil && state.watcher.alertsSnoozedUntil > Date.now()) {
  alertsSnoozedUntil = state.watcher.alertsSnoozedUntil;
  realAlertsEnabledValue = false;
  const remaining = alertsSnoozedUntil - Date.now();
  alertsSnoozeTimer = setTimeout(() => {
    setRealAlertsEnabled(true, { clearSnooze: true, save: true, reason: "snooze expired" });
  }, remaining);
}

function lastSuccessAgeMs(now = Date.now()) {
  return lastSuccessAt ? now - lastSuccessAt : Number.POSITIVE_INFINITY;
}

function isWatcherStale(now = Date.now()) {
  return lastSuccessAgeMs(now) > WATCHER_STALE_MS;
}

function isTeslaBlockError(message) {
  return /HTTP 403|akamai|access denied|blocked/i.test(String(message || ""));
}

function parseTeslaErrorMeta(message) {
  const text = String(message || "");
  const match = text.match(/\{"teslaMeta":.*\}$/);
  if (!match) return {};
  try {
    const parsed = JSON.parse(match[0]);
    return parsed?.teslaMeta && typeof parsed.teslaMeta === "object" ? parsed.teslaMeta : {};
  } catch (_) {
    return {};
  }
}

function stripTeslaErrorMeta(message) {
  return String(message || "").replace(/\s+\{"teslaMeta":.*\}$/, "");
}

function requestDayKey(now = Date.now()) {
  return new Date(now).toISOString().slice(0, 10);
}

function requestHourKey(now = Date.now()) {
  return new Date(now).toISOString().slice(0, 13);
}

function normalizeTeslaRequestStats(now = Date.now()) {
  const day = requestDayKey(now);
  const hour = requestHourKey(now);
  const stats = teslaRequestStats && typeof teslaRequestStats === "object" ? teslaRequestStats : {};
  if (stats.day !== day) {
    stats.day = day;
    stats.dayCount = 0;
  }
  if (stats.hour !== hour) {
    stats.hour = hour;
    stats.hourCount = 0;
  }
  stats.total = Number(stats.total || 0);
  stats.dayCount = Number(stats.dayCount || 0);
  stats.hourCount = Number(stats.hourCount || 0);
  teslaRequestStats = stats;
  return stats;
}

function recordTeslaRequests(count, reason = "inventory") {
  const numeric = Math.max(0, Math.floor(Number(count) || 0));
  if (!numeric) return normalizeTeslaRequestStats();
  const stats = normalizeTeslaRequestStats();
  stats.total += numeric;
  stats.dayCount += numeric;
  stats.hourCount += numeric;
  stats.lastReason = reason;
  stats.lastCount = numeric;
  stats.lastAt = Date.now();
  return stats;
}

function requestBudgetLimited(now = Date.now()) {
  const stats = normalizeTeslaRequestStats(now);
  return stats.dayCount >= TESLA_REQUEST_DAILY_SOFT_LIMIT || stats.hourCount >= TESLA_REQUEST_HOURLY_SOFT_LIMIT;
}

function isBrowserLaunchError(message) {
  return /Failed to launch the browser process|Opening in existing browser session|user data dir|user-data-dir|profile is already owned|SingletonLock|SingletonSocket|SingletonCookie|Browser closed unexpectedly|Target closed|ECONNREFUSED.*devtools/i.test(String(message || ""));
}

function activeTeslaBlockCooldown(now = Date.now()) {
  return !!(teslaBlockCooldownUntil && now < teslaBlockCooldownUntil);
}

function activeBrowserBackoff(now = Date.now()) {
  return !!(browserBackoffUntil && now < browserBackoffUntil);
}

function activePostBlockCaution(now = Date.now()) {
  return !!(postBlockCautionUntil && now < postBlockCautionUntil);
}

function teslaBlockCooldownForCount(count) {
  const steps = TESLA_BLOCK_COOLDOWN_STEPS_MS.length ? TESLA_BLOCK_COOLDOWN_STEPS_MS : [TESLA_BLOCK_COOLDOWN_MS];
  return steps[Math.min(Math.max(0, count - 1), steps.length - 1)];
}

function businessHour(now = Date.now()) {
  try {
    const parts = new Intl.DateTimeFormat("en-AU", {
      timeZone: BUSINESS_TIMEZONE,
      hour: "2-digit",
      hour12: false,
    }).formatToParts(new Date(now));
    const hour = Number(parts.find((part) => part.type === "hour")?.value);
    if (Number.isFinite(hour)) return hour === 24 ? 0 : hour;
  } catch (_) {}
  return new Date(now).getHours();
}

function localDayKey(now = Date.now()) {
  try {
    const parts = new Intl.DateTimeFormat("en-AU", {
      timeZone: BUSINESS_TIMEZONE,
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
    }).formatToParts(new Date(now));
    const get = (type) => parts.find((part) => part.type === type)?.value || "";
    return `${get("year")}-${get("month")}-${get("day")}`;
  } catch (_) {
    return new Date(now).toISOString().slice(0, 10);
  }
}

function msUntilNextLocalDay(now = Date.now()) {
  const current = localDayKey(now);
  const stepMs = 60 * 1000;
  const maxLookaheadMs = 36 * 60 * 60 * 1000;
  for (let elapsed = stepMs; elapsed <= maxLookaheadMs; elapsed += stepMs) {
    if (localDayKey(now + elapsed) !== current) return elapsed;
  }
  return 12 * 60 * 60 * 1000;
}

function normalizeTeslaBlockDay(now = Date.now()) {
  const day = localDayKey(now);
  if (teslaBlockDay !== day) {
    teslaBlockDay = day;
    teslaBlockDayCount = 0;
  }
  return day;
}

function activeTeslaPressureMode(now = Date.now()) {
  normalizeTeslaBlockDay(now);
  return !!(teslaPressureModeUntil && now < teslaPressureModeUntil);
}

function activateTeslaPressureMode(now = Date.now()) {
  const durationMs = TESLA_PRESSURE_MODE_MS > 0 ? TESLA_PRESSURE_MODE_MS : msUntilNextLocalDay(now);
  teslaPressureModeUntil = Math.max(teslaPressureModeUntil || 0, now + durationMs);
  shopSuppressedUntil = Math.max(shopSuppressedUntil || 0, teslaPressureModeUntil);
  console.warn(`[server] Tesla pressure mode active until ${new Date(teslaPressureModeUntil).toISOString()}; inventory max pages=1, shop suppressed`);
}

function recordTeslaBlockForPressureMode(now = Date.now()) {
  normalizeTeslaBlockDay(now);
  teslaBlockDayCount++;
  if (TESLA_PRESSURE_BLOCK_THRESHOLD > 0 && teslaBlockDayCount >= TESLA_PRESSURE_BLOCK_THRESHOLD) {
    activateTeslaPressureMode(now);
  }
}

function autoDomFallbackActive(now = Date.now()) {
  return AUTO_DOM_FALLBACK_ENABLED &&
    process.env.DOM_SCRAPE_FALLBACK !== "true" &&
    lastSuccessAgeMs(now) > AUTO_DOM_FALLBACK_AFTER_MS;
}

function effectiveDomFallbackEnabled(now = Date.now()) {
  return process.env.DOM_SCRAPE_FALLBACK === "true" || autoDomFallbackActive(now);
}

function businessHoursActive(now = Date.now()) {
  const hour = businessHour(now);
  const start = Math.max(0, Math.min(23, Math.floor(BUSINESS_HOURS_START)));
  const end = Math.max(0, Math.min(24, Math.floor(BUSINESS_HOURS_END)));
  if (start === end) return true;
  if (start < end) return hour >= start && hour < end;
  return hour >= start || hour < end;
}

function msUntilBusinessHoursStart(now = Date.now()) {
  if (businessHoursActive(now)) return Number.POSITIVE_INFINITY;
  const maxLookaheadMs = 36 * 60 * 60 * 1000;
  const stepMs = 60 * 1000;
  for (let elapsed = stepMs; elapsed <= maxLookaheadMs; elapsed += stepMs) {
    if (businessHoursActive(now + elapsed)) return elapsed;
  }
  return Number.POSITIVE_INFINITY;
}

function effectivePollIntervalMs() {
  const base = businessHoursActive() ? ACTIVE_POLL_INTERVAL_MS : QUIET_POLL_INTERVAL_MS;
  let interval = tripModeEnabled ? Math.max(base, TRIP_MODE_POLL_INTERVAL_MS) : base;
  if (activePostBlockCaution()) interval = Math.max(interval, POST_BLOCK_CAUTION_POLL_INTERVAL_MS);
  if (activeTeslaPressureMode()) interval = Math.max(interval, TESLA_PRESSURE_POLL_INTERVAL_MS);
  if (requestBudgetLimited()) interval = Math.max(interval, TESLA_REQUEST_BUDGET_POLL_INTERVAL_MS);
  return interval;
}

function maxPollPages() {
  const pages = businessHoursActive() ? ACTIVE_MAX_PAGES : QUIET_MAX_PAGES;
  let maxPages = Math.max(1, Math.floor(Number(pages) || 1));
  if (MONITORED_MAX_PAGES > 0) {
    maxPages = Math.max(1, Math.min(maxPages, Math.floor(MONITORED_MAX_PAGES)));
  }
  if (activePostBlockCaution()) {
    maxPages = Math.max(1, Math.min(maxPages, Math.floor(Number(POST_BLOCK_CAUTION_MAX_PAGES) || 1)));
  }
  if (activeTeslaPressureMode()) maxPages = 1;
  if (requestBudgetLimited()) maxPages = 1;
  return maxPages;
}

function pollJitterMs(base) {
  return Math.max(1000, Math.round(base * (0.8 + Math.random() * 0.4)));
}

function nextInventoryPollDelayMs() {
  if (!DIRECT_INVENTORY_ENABLED) return Number.POSITIVE_INFINITY;
  let delay = pollJitterMs(effectivePollIntervalMs());
  if (!businessHoursActive()) {
    const untilBusiness = msUntilBusinessHoursStart();
    if (Number.isFinite(untilBusiness)) {
      delay = Math.min(delay, untilBusiness + Math.floor(Math.random() * BUSINESS_START_POLL_JITTER_MS));
    }
  }
  return delay;
}

function teslaDirectSourceHealth(now = Date.now()) {
  const scraperStatus = getActiveScraperStatus();
  const ageMs = lastSuccessAt ? now - lastSuccessAt : null;
  const directStale = !lastSuccessAt || now - lastSuccessAt > BOTH_SOURCES_STALE_MS;
  const status = !DIRECT_INVENTORY_ENABLED
    ? "disabled"
    : activeTeslaBlockCooldown(now) ? "cooldown" : directStale ? "stale" : "ok";
  return {
    enabled: DIRECT_INVENTORY_ENABLED,
    lastSuccess: lastSuccessAt,
    lastPoll: lastPollAt,
    lastSource,
    stale: directStale,
    staleAgeMs: ageMs,
    staleMs: BOTH_SOURCES_STALE_MS,
    status,
    consecutiveFailures: consecutiveFailedPolls,
    consecutiveTeslaBlocks,
    pressureModeActive: activeTeslaPressureMode(now),
    teslaBlockDay,
    teslaBlockDayCount,
    teslaPressureModeUntil,
    cooldownActive: activeTeslaBlockCooldown(now),
    teslaBlockCooldownUntil,
    browserConnected: !!scraperStatus.browserConnected,
    cookieState: lastCookieState,
  };
}

function telegramSourceHealth(now = Date.now()) {
  return getTelegramStatus({
    enabled: TELEGRAM_INVENTORY_ENABLED,
    staleMs: BOTH_SOURCES_STALE_MS,
  });
}

function sourceHealth(now = Date.now()) {
  return {
    teslaDirect: teslaDirectSourceHealth(now),
    telegram: telegramSourceHealth(now),
    timestamp: now,
  };
}

function maybeFireBothSourcesStaleAlert(now = Date.now()) {
  if (!TELEGRAM_INVENTORY_ENABLED) return false;
  const sources = sourceHealth(now);
  const bothStale = sources.teslaDirect.enabled && sources.telegram.enabled && sources.teslaDirect.stale && sources.telegram.stale;
  if (!bothStale) {
    if (bothSourcesStaleAlerted) {
      bothSourcesStaleAlerted = false;
      persistWatcherMeta();
      saveState(state);
    }
    return false;
  }
  if (!realAlertsEnabled() || watcherOutageAlerted || bothSourcesStaleAlerted) return false;
  bothSourcesStaleAlerted = true;
  lastBothSourcesStaleAlertAt = now;
  persistWatcherMeta();
  saveState(state);
  fireServiceAlert("bothSourcesStale", {
    teslaLastSuccess: lastSuccessAt,
    telegramLastMessageAt: sources.telegram.lastMessageAt,
    staleMs: BOTH_SOURCES_STALE_MS,
  });
  return true;
}

function strictHealthStatus(now = Date.now()) {
  const readiness = getAlertReadiness();
  const alertBlocking = realAlertsEnabled() && !readiness.alertReady;
  const staleAgeMs = lastSuccessAgeMs(now);
  const blockCooldownActive = activeTeslaBlockCooldown(now);
  const stalePastStrictThreshold = staleAgeMs > STRICT_HEALTH_STALE_MS;
  const unhealthy = alertBlocking || (DIRECT_INVENTORY_ENABLED && stalePastStrictThreshold && !blockCooldownActive);
  const reasons = [];
  if (alertBlocking) reasons.push(`missing alert config: ${readiness.missing.join(", ")}`);
  if (DIRECT_INVENTORY_ENABLED && stalePastStrictThreshold && !blockCooldownActive) {
    reasons.push(`last successful Tesla fetch ${Math.round(staleAgeMs / 60000)}m ago`);
  }
  return {
    ok: !unhealthy,
    status: unhealthy ? "unhealthy" : "ok",
    reasons,
    directInventoryEnabled: DIRECT_INVENTORY_ENABLED,
    staleAgeMs: Number.isFinite(staleAgeMs) ? staleAgeMs : null,
    strictHealthStaleMs: STRICT_HEALTH_STALE_MS,
    blockCooldownActive,
    teslaBlockCooldownUntil,
    teslaBlockCooldownRemainingMs: Math.max(0, teslaBlockCooldownUntil - now),
    browserBackoffActive: activeBrowserBackoff(now),
    browserBackoffUntil,
    browserBackoffRemainingMs: Math.max(0, browserBackoffUntil - now),
  };
}

function currentHealthStatus(now = Date.now()) {
  const readiness = getAlertReadiness();
  const alertBlocking = realAlertsEnabled() && !readiness.alertReady;
  const watcherStale = DIRECT_INVENTORY_ENABLED && isWatcherStale(now);
  return {
    readiness,
    alertBlocking,
    watcherStale,
    status: watcherStale || alertBlocking ? "degraded" : "ok",
  };
}

function persistWatcherMeta() {
  if (!state.watcher) state.watcher = {};
  state.watcher.lastSuccessAt = lastSuccessAt;
  state.watcher.lastSource = lastSource;
  state.watcher.totalPolls = totalPolls;
  state.watcher.failedPolls = failedPolls;
  state.watcher.alertsSent = alertsSent;
  state.watcher.consecutiveFailedPolls = consecutiveFailedPolls;
  state.watcher.lastFailureAt = lastFailureAt;
  state.watcher.lastRecoveryAt = lastRecoveryAt;
  state.watcher.lastError = lastError;
  state.watcher.teslaBlockCooldownUntil = teslaBlockCooldownUntil;
  state.watcher.consecutiveTeslaBlocks = consecutiveTeslaBlocks;
  state.watcher.lastTeslaBlockAlertAt = lastTeslaBlockAlertAt;
  state.watcher.teslaBlockAlerted = teslaBlockAlerted;
  state.watcher.teslaBlockDay = teslaBlockDay;
  state.watcher.teslaBlockDayCount = teslaBlockDayCount;
  state.watcher.teslaPressureModeUntil = teslaPressureModeUntil;
  state.watcher.browserLaunchFailures = browserLaunchFailures;
  state.watcher.lastBrowserLaunchError = lastBrowserLaunchError;
  state.watcher.browserBackoffUntil = browserBackoffUntil;
  state.watcher.postBlockCautionUntil = postBlockCautionUntil;
  state.watcher.shopSuppressedUntil = shopSuppressedUntil;
  state.watcher.teslaRequestStats = normalizeTeslaRequestStats();
  state.watcher.lastBlockEventAt = lastBlockEventAt;
  state.watcher.lastBlockPhase = lastBlockPhase;
  state.watcher.lastCookieState = lastCookieState;
  state.watcher.externalNetworkIdentity = externalNetworkIdentity;
  state.watcher.externalNetworkIdentityCheckedAt = externalNetworkIdentityCheckedAt;
  state.watcher.watcherOutageAlerted = watcherOutageAlerted;
  state.watcher.lastWatcherAlertAt = lastWatcherAlertAt;
  state.watcher.lastBothSourcesStaleAlertAt = lastBothSourcesStaleAlertAt;
  state.watcher.bothSourcesStaleAlerted = bothSourcesStaleAlerted;
  state.watcher.lastMatchAlertAt = lastMatchAlertAt;
  state.watcher.keywordMatchCount = keywordMatchCount;
  state.watcher.keywordHealthCandidateCount = keywordHealthCandidateCount;
  state.watcher.keywordHealthy = keywordHealthy;
  state.watcher.keywordStaleAlerted = keywordStaleAlerted;
  state.watcher.keywordLastAlertAt = keywordLastAlertAt;
  state.watcher.lastKeywordAlertAt = keywordLastAlertAt;
  state.watcher.lastExactMatchTestAt = lastExactMatchTestAt;
  state.watcher.lastShopPollAt = lastShopPollAt;
  state.watcher.lastShopPollError = lastShopPollError;
  state.watcher.alertsSnoozedUntil = alertsSnoozedUntil;
  state.watcher.realAlertsEnabled = realAlertsEnabledValue;
  state.watcher.tripModeEnabled = tripModeEnabled;
}

// ── Logging helpers ──────────────────────────────────────────────────────────
function appendPollEvent(event) {
  try {
    fs.mkdirSync(LOG_DIR, { recursive: true });
    rotateFile(POLL_LOG_FILE);
    fs.appendFileSync(POLL_LOG_FILE, JSON.stringify({
      timestamp: new Date().toISOString(),
      ...event,
    }) + "\n");
  } catch (e) {
    console.error("[server] Failed to append poll event:", e.message);
  }
}

function appendBlockEvent(event) {
  try {
    fs.mkdirSync(LOG_DIR, { recursive: true });
    rotateFile(BLOCK_EVENT_LOG_FILE);
    const entry = {
      timestamp: new Date().toISOString(),
      buildVersion: BUILD_VERSION,
      deploymentMode: DEPLOYMENT_MODE,
      hostName: os.hostname(),
      ...event,
    };
    fs.appendFileSync(BLOCK_EVENT_LOG_FILE, JSON.stringify(entry) + "\n");
    lastBlockEventAt = Date.now();
    lastBlockPhase = event.phase || event.source || "";
  } catch (e) {
    console.error("[server] Failed to append block event:", e.message);
  }
}

function appendVehicleEvent(type, vehicle, extra = {}) {
  try {
    fs.mkdirSync(LOG_DIR, { recursive: true });
    rotateFile(VEHICLE_EVENT_LOG_FILE);
    fs.appendFileSync(VEHICLE_EVENT_LOG_FILE, JSON.stringify({
      timestamp: new Date().toISOString(),
      type,
      id: vehicle?.id || vehicle?.hash || "",
      state: vehicle?.state || "",
      location: vehicle?.location || vehicle?.city || "",
      trimName: vehicle?.trimName || "",
      exterior: vehicle?.exterior || "",
      interior: vehicle?.interior || "",
      cabinConfig: vehicle?.cabinConfig || "",
      price: vehicle?.price ?? null,
      ...extra,
    }) + "\n");
  } catch (e) {
    console.error("[server] Failed to append vehicle event:", e.message);
  }
}

function logPoll(method, vehicleCount, error, extra = {}) {
  const ts = new Date().toISOString();
  const entry = `[${ts}] ${method}: ${vehicleCount} vehicles` +
    (error ? ` ERROR: ${error}` : "");
  console.log(entry);
  try {
    fs.mkdirSync(LOG_DIR, { recursive: true });
    rotateFile(SERVER_LOG_FILE);
    fs.appendFileSync(SERVER_LOG_FILE, entry + "\n");
  } catch (_) {}
  appendPollEvent({
    source: method,
    vehicleCount,
    success: !error,
    stale,
    error: error || null,
    totalPolls,
    failedPolls,
    ...extra,
  });
}

function rotateLogs() {
  rotateFile(SERVER_LOG_FILE);
  rotateFile(POLL_LOG_FILE);
  rotateFile(BLOCK_EVENT_LOG_FILE);
  rotateFile(VEHICLE_EVENT_LOG_FILE);
}

function readRecentPollEvents(limit = RECENT_POLLS_LIMIT) {
  try {
    if (!fs.existsSync(POLL_LOG_FILE)) return [];
    const lines = fs.readFileSync(POLL_LOG_FILE, "utf-8")
      .trim()
      .split("\n")
      .filter(Boolean)
      .slice(-limit);
    return lines.map((line) => {
      try { return JSON.parse(line); } catch (_) { return null; }
    }).filter(Boolean);
  } catch (e) {
    console.error("[server] Failed to read poll events:", e.message);
    return [];
  }
}

function readRecentBlockEvents(limit = RECENT_POLLS_LIMIT) {
  return readRecentJsonl(BLOCK_EVENT_LOG_FILE, limit);
}

function readRecentJsonl(filePath, limit = RECENT_POLLS_LIMIT) {
  try {
    if (!fs.existsSync(filePath)) return [];
    const lines = fs.readFileSync(filePath, "utf-8")
      .trim()
      .split("\n")
      .filter(Boolean)
      .slice(-limit);
    return lines.map((line) => {
      try { return JSON.parse(line); } catch (_) { return null; }
    }).filter(Boolean);
  } catch (e) {
    console.error(`[server] Failed to read ${path.basename(filePath)}:`, e.message);
    return [];
  }
}

function hydrateTeslaBlockDayFromLog(now = Date.now()) {
  const day = localDayKey(now);
  if (teslaBlockDay === day && teslaBlockDayCount > 0) return;
  const sameDayBlocks = readRecentJsonl(BLOCK_EVENT_LOG_FILE, 500)
    .filter((event) => {
      if (event?.type !== "tesla_block" || !event.timestamp) return false;
      const parsed = Date.parse(event.timestamp);
      return Number.isFinite(parsed) && localDayKey(parsed) === day;
    })
    .length;
  teslaBlockDay = day;
  teslaBlockDayCount = Math.max(teslaBlockDayCount, sameDayBlocks);
  if (sameDayBlocks) {
    console.log(`[server] Hydrated ${sameDayBlocks} Tesla block event(s) for ${day}`);
  }
  if (TESLA_PRESSURE_BLOCK_THRESHOLD > 0 && teslaBlockDayCount >= TESLA_PRESSURE_BLOCK_THRESHOLD) {
    activateTeslaPressureMode(now);
  }
}

function pollLogSummary(limit = RECENT_POLLS_LIMIT) {
  const events = readRecentPollEvents(limit);
  const successes = events.filter((e) => e.success).length;
  const last = events.length ? events[events.length - 1] : null;
  return {
    recentPollWindow: events.length,
    recentPollSuccesses: successes,
    recentSuccessRate: events.length ? successes / events.length : null,
    lastPollEventAt: last?.timestamp ? Date.parse(last.timestamp) : 0,
  };
}

// ── Alerting ─────────────────────────────────────────────────────────────────
function getAlertReadiness() {
  const pushoverConfigured = !!(process.env.PUSHOVER_USER && process.env.PUSHOVER_TOKEN);
  const emailConfigured = !!(
    process.env.SMTP_HOST &&
    process.env.SMTP_USER &&
    process.env.SMTP_PASS &&
    process.env.ALERT_EMAIL
  );
  const missing = [];
  if (!pushoverConfigured) missing.push("pushover");
  if (!emailConfigured) missing.push("email");
  return {
    pushoverConfigured,
    emailConfigured,
    alertReady: pushoverConfigured && emailConfigured,
    missing,
  };
}

function playLocalSound() {
  return new Promise((resolve, reject) => {
    if (!LOCAL_SOUND_AVAILABLE) {
      resolve(false);
      return;
    }

    const child = spawn("afplay", ["/System/Library/Sounds/Hero.aiff"]);
    child.on("error", reject);
    child.on("exit", (code) => {
      if (code === 0) {
        console.log("[alert] Local sound: afplay /System/Library/Sounds/Hero.aiff");
        resolve(true);
      } else {
        reject(new Error(`afplay exited ${code}`));
      }
    });
  });
}

async function sendPushoverAlert(v) {
  const user = process.env.PUSHOVER_USER;
  const token = process.env.PUSHOVER_TOKEN;
  if (!user || !token) throw new Error("Missing PUSHOVER_USER or PUSHOVER_TOKEN");

  const msg = `${v.exterior} / ${v.interior} · ${v.wheels} · $${v.price.toLocaleString()}`;
  const response = await fetch("https://api.pushover.net/1/messages.json", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      token,
      user,
      title: `Tesla Stock Watch Alert — ${v.state}`,
      message: msg,
      url: "https://www.tesla.com/en_AU/inventory/new/my",
      url_title: "Open Tesla Inventory",
      priority: 1,
      sound: "persistent",
    }),
  });
  if (!response.ok) {
    const body = await response.text().catch(() => "");
    throw new Error(`Pushover HTTP ${response.status}${body ? `: ${body}` : ""}`);
  }
  console.log(`[alert] Pushover sent for ${v.id}`);
  return true;
}

async function sendEmailAlert(v) {
  const host = process.env.SMTP_HOST;
  const user = process.env.SMTP_USER;
  const pass = process.env.SMTP_PASS;
  const to = process.env.ALERT_EMAIL;
  if (!host || !user || !pass || !to) throw new Error("Missing SMTP_HOST, SMTP_USER, SMTP_PASS, or ALERT_EMAIL");

  const nodemailer = require("nodemailer");
  const transporter = nodemailer.createTransport({
    host,
    port: parseInt(process.env.SMTP_PORT || "587"),
    secure: false,
    auth: { user, pass },
  });
  await transporter.sendMail({
    from: user,
    to,
    subject: `Tesla Alert — ${v.exterior} / ${v.interior} in ${v.state} ($${v.price.toLocaleString()})`,
    html: [
      `<h2>New Model Y Match Detected</h2>`,
      `<p><strong>${v.exterior}</strong> · ${v.interior} interior · ${v.wheels}</p>`,
      `<p>${v.vrlName || v.location}, ${v.state} — $${v.price.toLocaleString()}</p>`,
      `<p>${v.trimName} · ${v.cabinConfig}-seat</p>`,
      v.inTransit ? '<p style="color:orange">In Transit</p>' : "",
      v.isDemo ? '<p style="color:red">Demo Vehicle</p>' : "",
      `<p><a href="https://www.tesla.com/en_AU/inventory/new/my">View Tesla Inventory →</a></p>`,
      `<hr><small>Stock Watch · ${new Date().toISOString()}</small>`,
    ].join("\n"),
  });
  console.log(`[alert] Email sent for ${v.id}`);
  return true;
}

async function sendShopPushoverAlert(product) {
  const user = process.env.PUSHOVER_USER;
  const token = process.env.PUSHOVER_TOKEN;
  if (!user || !token) throw new Error("Missing PUSHOVER_USER or PUSHOVER_TOKEN");

  const response = await fetch("https://api.pushover.net/1/messages.json", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      token,
      user,
      title: `Tesla Shop - ${product.name} IN STOCK`,
      message: `${product.name} is available.`,
      url: product.url,
      url_title: "Open Tesla Shop",
      priority: 1,
      sound: "persistent",
    }),
  });
  if (!response.ok) {
    const body = await response.text().catch(() => "");
    throw new Error(`Pushover HTTP ${response.status}${body ? `: ${body}` : ""}`);
  }
  console.log(`[alert] Shop Pushover sent for ${product.id}`);
  return true;
}

async function sendShopEmailAlert(product) {
  const host = process.env.SMTP_HOST;
  const user = process.env.SMTP_USER;
  const pass = process.env.SMTP_PASS;
  const to = process.env.ALERT_EMAIL;
  if (!host || !user || !pass || !to) throw new Error("Missing SMTP_HOST, SMTP_USER, SMTP_PASS, or ALERT_EMAIL");

  const nodemailer = require("nodemailer");
  const transporter = nodemailer.createTransport({
    host,
    port: parseInt(process.env.SMTP_PORT || "587"),
    secure: false,
    auth: { user, pass },
  });
  await transporter.sendMail({
    from: user,
    to,
    subject: `Tesla Shop - ${product.name} IN STOCK`,
    html: [
      `<h2>Tesla Shop Accessory Available</h2>`,
      `<p><strong>${product.name}</strong> is available.</p>`,
      `<p><strong>Status:</strong> ${product.status}</p>`,
      `<p><strong>Checked:</strong> ${new Date(product.lastCheckedAt || Date.now()).toISOString()}</p>`,
      `<p><a href="${product.url}">Open Tesla Shop</a></p>`,
      `<hr><small>Stock Watch · ${new Date().toISOString()}</small>`,
    ].join("\n"),
  });
  console.log(`[alert] Shop email sent for ${product.id}`);
  return true;
}

function fireShopAlert(product) {
  const readiness = getAlertReadiness();

  if (!realAlertsEnabled()) {
    console.log(`[alert] Real alerts disabled; suppressed shop alert for ${product.id}`);
    appendVehicleEvent("shopAlertSuppressed", { id: product.id, location: "Tesla Shop" }, {
      productName: product.name,
      productUrl: product.url,
      status: product.status,
      reason: "realAlertsDisabled",
    });
    return;
  }

  playLocalSound().catch((e) => console.error("[alert] Local sound failed:", e.message));
  if (readiness.pushoverConfigured) {
    sendShopPushoverAlert(product).catch((e) => console.error("[alert] Shop Pushover failed:", e.message));
  }
  if (readiness.emailConfigured) {
    sendShopEmailAlert(product).catch((e) => console.error("[alert] Shop email failed:", e.message));
  }
  if (readiness.pushoverConfigured || readiness.emailConfigured) alertsSent++;
  appendVehicleEvent("shopAlertSent", { id: product.id, location: "Tesla Shop" }, {
    productName: product.name,
    productUrl: product.url,
    status: product.status,
    pushoverConfigured: readiness.pushoverConfigured,
    emailConfigured: readiness.emailConfigured,
  });
}

async function sendServicePushoverAlert(title, message, priority = 1) {
  const user = process.env.PUSHOVER_USER;
  const token = process.env.PUSHOVER_TOKEN;
  if (!user || !token) throw new Error("Missing PUSHOVER_USER or PUSHOVER_TOKEN");

  const response = await fetch("https://api.pushover.net/1/messages.json", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      token,
      user,
      title,
      message,
      url: `http://${process.env.PUBLIC_HOST || "localhost"}:${PORT}/`,
      url_title: "Open Tesla Stock Watch",
      priority,
      sound: priority > 0 ? "persistent" : "pushover",
    }),
  });
  if (!response.ok) {
    const body = await response.text().catch(() => "");
    throw new Error(`Pushover HTTP ${response.status}${body ? `: ${body}` : ""}`);
  }
  console.log(`[alert] Service Pushover sent: ${title}`);
  return true;
}

async function sendServiceEmailAlert(subject, html) {
  const host = process.env.SMTP_HOST;
  const user = process.env.SMTP_USER;
  const pass = process.env.SMTP_PASS;
  const to = process.env.ALERT_EMAIL;
  if (!host || !user || !pass || !to) throw new Error("Missing SMTP_HOST, SMTP_USER, SMTP_PASS, or ALERT_EMAIL");

  const nodemailer = require("nodemailer");
  const transporter = nodemailer.createTransport({
    host,
    port: parseInt(process.env.SMTP_PORT || "587"),
    secure: false,
    auth: { user, pass },
  });
  await transporter.sendMail({
    from: user,
    to,
    subject,
    html,
  });
  console.log(`[alert] Service email sent: ${subject}`);
  return true;
}

function serviceAlertHtml(title, body) {
  return [
    `<h2>${title}</h2>`,
    `<p>${body}</p>`,
    `<p><strong>Host:</strong> ${os.hostname()} · <strong>Mode:</strong> ${DEPLOYMENT_MODE}</p>`,
    `<p><strong>Total polls:</strong> ${totalPolls} · <strong>Failed polls:</strong> ${failedPolls} · <strong>Consecutive failures:</strong> ${consecutiveFailedPolls}</p>`,
    `<p><strong>Last success:</strong> ${lastSuccessAt ? new Date(lastSuccessAt).toISOString() : "never"}</p>`,
    lastError ? `<p><strong>Last error:</strong> ${String(lastError).slice(0, 500)}</p>` : "",
    `<p><a href="http://${process.env.PUBLIC_HOST || "localhost"}:${PORT}/">Open Tesla Stock Watch</a></p>`,
    `<hr><small>Stock Watch · ${new Date().toISOString()}</small>`,
  ].join("\n");
}

function fireServiceAlert(kind, extra = {}) {
  const readiness = getAlertReadiness();
  if (!realAlertsEnabled()) {
    console.log(`[alert] Real alerts disabled; suppressed service ${kind} alert`);
    return;
  }
  if (!readiness.alertReady) {
    console.warn(`[alert] Service ${kind} alert skipped: missing ${readiness.missing.join(", ")}`);
    return;
  }

  const staleMinutes = Math.round(lastSuccessAgeMs() / 60000);
  const isRecovery = kind === "recovery";
  let title = isRecovery ? "Tesla Stock Watch recovered" : "Tesla Stock Watch needs attention";
  let body = isRecovery
    ? `Polling recovered on ${os.hostname()}. Current inventory count is ${vehicles.length}.`
    : `Polling has been stale for about ${staleMinutes} minutes. The watcher will keep retrying automatically.`;
  let priority = isRecovery ? 0 : 1;

  if (kind === "keywordStale") {
    const keywords = Array.isArray(extra.keywords) ? extra.keywords : (Array.isArray(targetConfig.trimKeywords) ? targetConfig.trimKeywords : []);
    title = "Tesla Stock Watch — keyword may be stale";
    body = `None of the ${extra.keywordHealthCandidateCount ?? keywordHealthCandidateCount} relevant vehicles match the trim keywords: ${keywords.join(", ") || "none"}. Tesla may have changed the API naming. Keyword match count is ${extra.keywordMatchCount ?? keywordMatchCount}.`;
    priority = 1;
  }

  if (kind === "teslaBlocked") {
    const retryAt = extra.cooldownUntil ? new Date(extra.cooldownUntil).toISOString() : "unknown";
    title = "Tesla Stock Watch — Tesla is blocking fetches";
    body = `Tesla/Akamai is blocking inventory fetches on ${os.hostname()}. The watcher is serving the last known ${vehicles.length} vehicles and backing off until ${retryAt}. Consecutive Tesla block count is ${extra.consecutiveTeslaBlocks ?? consecutiveTeslaBlocks}.`;
    priority = 1;
  }

  if (kind === "bothSourcesStale") {
    const thresholdMinutes = Math.round((extra.staleMs || BOTH_SOURCES_STALE_MS) / 60000);
    const teslaLast = extra.teslaLastSuccess ? new Date(extra.teslaLastSuccess).toISOString() : "never";
    const telegramLast = extra.telegramLastMessageAt ? new Date(extra.telegramLastMessageAt).toISOString() : "never";
    title = "Tesla Stock Watch — both inventory sources are stale";
    body = `Tesla direct polling and Telegram inventory monitoring have both been stale for more than ${thresholdMinutes} minutes on ${os.hostname()}. Last Tesla success: ${teslaLast}. Last Telegram MY message: ${telegramLast}.`;
    priority = 1;
  }

  sendServicePushoverAlert(title, body, priority)
    .catch((e) => console.error(`[alert] Service Pushover failed: ${e.message}`));
  sendServiceEmailAlert(title, serviceAlertHtml(title, body))
    .catch((e) => console.error(`[alert] Service email failed: ${e.message}`));
}

function testAlertVehicle() {
  return {
    id: "test-alert",
    hash: "test-alert",
    state: "TEST",
    location: "Tesla Stock Watch",
    vrlName: "Alert test",
    exterior: "Diamond Black",
    interior: "White",
    wheels: "20’’ Helix 2.0 Wheels",
    price: 0,
    trimName: "Model Y L Premium All-Wheel Drive",
    cabinConfig: "SIX",
    isDemo: false,
    inTransit: false,
  };
}

function fireAlerts(vehicle) {
  const readiness = getAlertReadiness();
  const now = Date.now();

  if (!realAlertsEnabled()) {
    console.log(`[alert] Real alerts disabled; suppressed match alert for ${vehicle.id}`);
    return;
  }
  if (lastMatchAlertAt && now - lastMatchAlertAt < MATCH_ALERT_COOLDOWN_MS) {
    const remaining = Math.ceil((MATCH_ALERT_COOLDOWN_MS - (now - lastMatchAlertAt)) / 1000);
    console.log(`[alert] Match alert cooldown active; suppressed ${vehicle.id} for ${remaining}s`);
    appendVehicleEvent("alertSuppressed", vehicle, {
      reason: "matchCooldown",
      cooldownMs: MATCH_ALERT_COOLDOWN_MS,
      lastMatchAlertAt,
    });
    return;
  }

  lastMatchAlertAt = now;
  persistWatcherMeta();
  playLocalSound().catch((e) => console.error("[alert] Local sound failed:", e.message));
  if (readiness.pushoverConfigured) {
    sendPushoverAlert(vehicle).catch((e) => console.error("[alert] Pushover failed:", e.message));
  }
  if (readiness.emailConfigured) {
    sendEmailAlert(vehicle).catch((e) => console.error("[alert] Email failed:", e.message));
  }

  if (readiness.pushoverConfigured || readiness.emailConfigured) alertsSent++;
  appendVehicleEvent("alertSent", vehicle, {
    pushoverConfigured: readiness.pushoverConfigured,
    emailConfigured: readiness.emailConfigured,
  });
}

function appendTeslaBlockIncident(errorMessage, context = {}) {
  const meta = parseTeslaErrorMeta(errorMessage);
  const scraperStatus = getActiveScraperStatus();
  const requestStats = normalizeTeslaRequestStats();
  const phase = context.phase || meta.phase || context.source || "unknown";
  appendBlockEvent({
    type: "tesla_block",
    source: context.source || "",
    scraper: context.scraper || "",
    phase,
    error: stripTeslaErrorMeta(errorMessage),
    status: meta.status || null,
    urlKind: meta.urlKind || "",
    contentType: meta.contentType || "",
    bodyLength: meta.bodyLength ?? null,
    bodyHash: meta.bodyHash || "",
    pageTitle: meta.pageTitle || "",
    pageUrl: meta.pageUrl || "",
    requestCount: Number(context.requestCount || meta.requestCount || 0),
    pagesFetched: Number(context.pagesFetched || meta.pagesFetched || 0),
    maxPages: maxPollPages(),
    cookieState: context.cookieState || lastCookieState || null,
    effectivePollIntervalMs: effectivePollIntervalMs(),
    consecutiveTeslaBlocks,
    teslaBlockDay,
    teslaBlockDayCount,
    teslaPressureModeUntil,
    teslaPressureModeRemainingMs: Math.max(0, teslaPressureModeUntil - Date.now()),
    teslaBlockCooldownUntil,
    teslaBlockCooldownRemainingMs: Math.max(0, teslaBlockCooldownUntil - Date.now()),
    postBlockCautionUntil,
    requestStats,
    externalNetworkIdentity,
    browser: {
      connected: scraperStatus.browserConnected,
      ageMs: scraperStatus.browserAgeMs,
      pageCount: scraperStatus.browserPageCount,
      chromeProcessCount: scraperStatus.chromeProcessCount,
      lastScrapeDurationMs: scraperStatus.lastScrapeDurationMs,
    },
  });
  refreshExternalNetworkIdentity("tesla_block").catch(() => {});
}

function recordPollFailure(errorMessage, context = {}) {
  recordMemorySample();
  failedPolls++;
  consecutiveFailedPolls++;
  lastFailureAt = Date.now();
  lastError = errorMessage || "Unknown poll failure";
  if (isTeslaBlockError(lastError)) {
    const now = Date.now();
    const meta = parseTeslaErrorMeta(lastError);
    recordTeslaRequests(context.requestCount || meta.requestCount || 1, context.source || meta.phase || "tesla_block");
    consecutiveTeslaBlocks++;
    recordTeslaBlockForPressureMode(now);
    const cooldownMs = teslaBlockCooldownForCount(consecutiveTeslaBlocks);
    teslaBlockCooldownUntil = Math.max(teslaBlockCooldownUntil || 0, now + cooldownMs);
    console.warn(`[server] Tesla block detected (${consecutiveTeslaBlocks} consecutive); backing off inventory fetches until ${new Date(teslaBlockCooldownUntil).toISOString()}`);
    appendTeslaBlockIncident(lastError, context);
    if (!teslaBlockAlerted) {
      teslaBlockAlerted = true;
      if (!lastTeslaBlockAlertAt || now - lastTeslaBlockAlertAt > TESLA_BLOCK_ALERT_COOLDOWN_MS) {
        lastTeslaBlockAlertAt = now;
        fireServiceAlert("teslaBlocked", {
          cooldownUntil: teslaBlockCooldownUntil,
          cooldownMs,
          consecutiveTeslaBlocks,
        });
      } else {
        console.log("[alert] Tesla block alert suppressed: a recent incident was already reported");
      }
    }
  }
  stale = true;
  persistWatcherMeta();
  saveState(state);

  const now = Date.now();
  const shouldAlert = isWatcherStale(now) && !watcherOutageAlerted;
  if (shouldAlert) {
    watcherOutageAlerted = true;
    lastWatcherAlertAt = now;
    persistWatcherMeta();
    saveState(state);
    fireServiceAlert("failure");
  }
  maybeFireBothSourcesStaleAlert(now);
}

function resetBrowserHealth() {
  browserLaunchFailures = 0;
  lastBrowserLaunchError = null;
  browserBackoffUntil = 0;
}

function recordBrowserLaunchFailure(errorMessage) {
  recordMemorySample();
  const now = Date.now();
  browserLaunchFailures++;
  lastBrowserLaunchError = errorMessage || "Unknown browser launch failure";
  lastError = lastBrowserLaunchError;

  if (browserLaunchFailures >= BROWSER_BACKOFF_FAILURE_THRESHOLD) {
    browserBackoffUntil = now + BROWSER_BACKOFF_MS;
    console.warn(`[server] Browser launch/profile failure (${browserLaunchFailures} consecutive); backing off inventory fetches until ${new Date(browserBackoffUntil).toISOString()}`);
  } else {
    console.warn(`[server] Browser launch/profile failure (${browserLaunchFailures}/${BROWSER_BACKOFF_FAILURE_THRESHOLD}): ${lastBrowserLaunchError}`);
  }

  stale = isWatcherStale(now);
  persistWatcherMeta();
  saveState(state);
  return activeBrowserBackoff(now);
}

async function recycleScraperBrowsers(reason) {
  for (const scraper of [mainScraper, stealthScraper].filter(Boolean)) {
    if (typeof scraper.destroyBrowser !== "function") continue;
    try {
      await scraper.destroyBrowser();
    } catch (e) {
      console.warn(`[server] Browser recycle failed after ${reason}: ${e.message}`);
    }
  }
}

function recordPollSuccess(source) {
  recordMemorySample();
  const hadAlertedOutage = watcherOutageAlerted;
  const recoveredFromTeslaBlock = recoveringFromTeslaBlock || consecutiveTeslaBlocks > 0 || !!teslaBlockCooldownUntil;
  consecutiveFailedPolls = 0;
  lastError = null;
  stale = false;
  lastSuccessAt = Date.now();
  if (recoveredFromTeslaBlock && POST_BLOCK_CAUTION_MS > 0) {
    postBlockCautionUntil = Math.max(postBlockCautionUntil || 0, lastSuccessAt + POST_BLOCK_CAUTION_MS);
    shopSuppressedUntil = Math.max(shopSuppressedUntil || 0, lastSuccessAt + POST_BLOCK_SHOP_SUPPRESS_MS);
    console.log(`[server] Post-block caution active until ${new Date(postBlockCautionUntil).toISOString()}; shop suppressed until ${new Date(shopSuppressedUntil).toISOString()}`);
  }
  teslaBlockCooldownUntil = 0;
  consecutiveTeslaBlocks = 0;
  teslaBlockAlerted = false;
  resetBrowserHealth();
  lastRecoveryAt = hadAlertedOutage ? lastSuccessAt : lastRecoveryAt;
  lastSource = source;
  watcherOutageAlerted = false;
  bothSourcesStaleAlerted = false;
  recoveringFromTeslaBlock = false;
  persistWatcherMeta();
  if (hadAlertedOutage) {
    fireServiceAlert("recovery");
  }
}

function pruneOldRemovedVehicles(now = Date.now()) {
  if (!Number.isFinite(MAX_TRACKED_VEHICLE_AGE_MS) || MAX_TRACKED_VEHICLE_AGE_MS <= 0) return 0;
  const cutoff = now - MAX_TRACKED_VEHICLE_AGE_MS;
  let pruned = 0;
  for (const [hash, pv] of Object.entries(state.vehicles || {})) {
    if (pv?.removedAt && pv.removedAt < cutoff) {
      delete state.vehicles[hash];
      pruned++;
    }
  }
  if (pruned) console.log(`[server] Pruned ${pruned} removed vehicles older than ${Math.round(MAX_TRACKED_VEHICLE_AGE_MS / 86400000)}d`);
  return pruned;
}

function monitoredActiveVehicleCount(persistedVehicles = state.vehicles || {}) {
  return Object.values(persistedVehicles).filter((pv) => !pv.removedAt && isMonitoredState(pv.state)).length;
}

function retireOutOfScopeVehicles(persistedVehicles, now = Date.now()) {
  if (MONITORED_STATE_SET.size === 0) return 0;
  let retired = 0;
  for (const [hash, pv] of Object.entries(persistedVehicles || {})) {
    if (!pv?.removedAt && !isMonitoredState(pv.state)) {
      pv.removedAt = now;
      appendVehicleEvent("outOfScope", { ...vehicleFromPersisted(hash, pv), id: hash }, {
        reason: "outsideMonitoredStates",
        monitoredStates: MONITORED_STATES,
      });
      retired++;
    }
  }
  if (retired) console.log(`[server] Retired ${retired} active vehicle(s) outside monitored states: ${MONITORED_STATES.join(",")}`);
  return retired;
}

// ── Poll cycle ───────────────────────────────────────────────────────────────
function pollSleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function runRecoveryProbe() {
  let lastError = null;
  const scrapers = [
    { name: "main_probe", scraper: mainScraper },
    { name: "stealth_probe", scraper: stealthScraper },
  ].filter((entry) => entry.scraper);

  for (const { name, scraper } of scrapers) {
    try {
      const data = await scraper.scrapeInventory(1);
      if (data?._domFallback) {
        return { ok: true, source: name, data };
      }
      if (data?.partial) {
        lastError = new Error(data.partialReason || "Recovery probe returned partial data");
        continue;
      }
      return { ok: true, source: name, data };
    } catch (e) {
      lastError = e;
      console.warn(`[server] Recovery probe ${name} failed: ${e.message}`);
      if (isTeslaBlockError(e.message)) break;
    }
  }

  return { ok: false, error: lastError || new Error("No scraper available for recovery probe") };
}

async function doPoll() {
  if (!DIRECT_INVENTORY_ENABLED) {
    stale = false;
    lastError = null;
    consecutiveFailedPolls = 0;
    watcherOutageAlerted = false;
    bothSourcesStaleAlerted = false;
    persistWatcherMeta();
    saveState(state);
    return;
  }

  const pollStartedAt = Date.now();
  let recoveryProbeData = null;
  let recoveryProbeSource = "";
  if (browserBackoffUntil && pollStartedAt < browserBackoffUntil) {
    if (!lastBrowserBackoffLogAt || pollStartedAt - lastBrowserBackoffLogAt > 5 * 60 * 1000) {
      lastBrowserBackoffLogAt = pollStartedAt;
      console.warn(`[server] Browser backoff active; next inventory fetch after ${new Date(browserBackoffUntil).toISOString()}`);
    }
    _nextPollDelayOverrideMs = Math.max(1000, browserBackoffUntil - pollStartedAt);
    persistWatcherMeta();
    saveState(state);
    return;
  }
  if (browserBackoffUntil && pollStartedAt >= browserBackoffUntil) {
    console.warn("[server] Browser backoff expired; resuming inventory polling");
    browserBackoffUntil = 0;
    persistWatcherMeta();
    saveState(state);
  }

  if (teslaBlockCooldownUntil && pollStartedAt < teslaBlockCooldownUntil) {
    if (!lastTeslaBlockCooldownLogAt || pollStartedAt - lastTeslaBlockCooldownLogAt > 5 * 60 * 1000) {
      lastTeslaBlockCooldownLogAt = pollStartedAt;
      console.warn(`[server] Tesla block cooldown active; next inventory fetch after ${new Date(teslaBlockCooldownUntil).toISOString()}`);
    }
    _nextPollDelayOverrideMs = Math.max(1000, teslaBlockCooldownUntil - pollStartedAt);
    persistWatcherMeta();
    saveState(state);
    return;
  }
  if (teslaBlockCooldownUntil && pollStartedAt >= teslaBlockCooldownUntil) {
    console.warn("[server] Tesla block cooldown expired; running one-page recovery probe before full poll");
    const activateDomFallback = autoDomFallbackActive(pollStartedAt);
    process.env.DOM_SCRAPE_FALLBACK_ACTIVE = activateDomFallback ? "true" : "false";
    if (activateDomFallback) {
      console.warn(`[server] Auto DOM fallback active after ${Math.round(lastSuccessAgeMs(pollStartedAt) / 60000)}m without direct Tesla success`);
    }
    const probe = await runRecoveryProbe();
    if (!probe.ok) {
      const reason = `Tesla recovery probe failed: ${probe.error?.message || "unknown error"}`;
      const meta = parseTeslaErrorMeta(probe.error?.message || reason);
      recordPollFailure(reason, { source: "recovery_probe", scraper: "main_probe", ...meta });
      logPoll("recovery_probe", 0, stripTeslaErrorMeta(reason), meta);
      return;
    }
    console.log(`[server] Tesla recovery probe succeeded via ${probe.source}; using probe data for this poll`);
    recoveringFromTeslaBlock = true;
    recoveryProbeData = probe.data;
    recoveryProbeSource = probe.source === "stealth_probe" ? "stealth_recovery_probe" : "main_recovery_probe";
    teslaBlockCooldownUntil = 0;
    consecutiveTeslaBlocks = 0;
    lastError = null;
    persistWatcherMeta();
    saveState(state);
  }

  const pollIntervalMs = effectivePollIntervalMs();
  if (lastPollAt && pollStartedAt - lastPollAt < pollIntervalMs) {
    _nextPollDelayOverrideMs = Math.max(1000, pollIntervalMs - (pollStartedAt - lastPollAt));
    return;
  }

  totalPolls++;
  lastPollAt = Date.now();
  state.watcher.lastPollAt = lastPollAt;
  let data = recoveryProbeData;
  let source = recoveryProbeSource;
  let mainError = null;
  let stealthError = null;
  const currentMaxPages = maxPollPages();
  const activateDomFallback = autoDomFallbackActive(pollStartedAt);
  process.env.DOM_SCRAPE_FALLBACK_ACTIVE = activateDomFallback ? "true" : "false";
  if (activateDomFallback) {
    console.warn(`[server] Auto DOM fallback active after ${Math.round(lastSuccessAgeMs(pollStartedAt) / 60000)}m without direct Tesla success`);
  }

  if (process.env.FORCE_POLL_FAILURE === "true") {
    recordPollFailure("Forced poll failure via FORCE_POLL_FAILURE=true");
    logPoll("forced", 0, "Forced poll failure via FORCE_POLL_FAILURE=true");
    return;
  }

  if (process.env.FORCE_TESLA_BLOCK_FAILURE === "true") {
    const meta = {
      phase: "api_page_1",
      status: 403,
      urlKind: "inventory_api",
      contentType: "text/html",
      bodyLength: 0,
      bodyHash: "forced",
      requestCount: 1,
    };
    const reason = `Tesla block detected; forced: HTTP 403 ${JSON.stringify({ teslaMeta: meta })}`;
    recordPollFailure(reason, { source: "blocked", scraper: "forced", ...meta });
    logPoll("blocked", 0, stripTeslaErrorMeta(reason), meta);
    return;
  }

  if (process.env.FORCE_BROWSER_LAUNCH_FAILURE === "true") {
    const reason = "Browser launch/profile failure: forced via FORCE_BROWSER_LAUNCH_FAILURE=true";
    const backedOff = recordBrowserLaunchFailure(reason);
    if (backedOff) await recycleScraperBrowsers("forced browser backoff");
    logPoll(backedOff ? "browser_backoff" : "browser_error", vehicles.length, reason);
    return;
  }

  // Try main scraper first (plain puppeteer — consistently works)
  if (!data && mainScraper) {
    try {
      data = await mainScraper.scrapeInventory(currentMaxPages);
      source = "main";
    } catch (e) {
      mainError = e;
      if (e.cookieState) lastCookieState = e.cookieState;
      console.warn(`[server] Main scraper failed: ${e.message}`);
    }
  }

  if (!data && mainError && isTeslaBlockError(mainError.message)) {
    const reason = `Tesla block detected; main: ${mainError.message}`;
    const meta = parseTeslaErrorMeta(mainError.message);
    recordPollFailure(reason, { source: "blocked", scraper: "main", cookieState: mainError.cookieState || lastCookieState, ...meta });
    logPoll("blocked", 0, stripTeslaErrorMeta(reason), meta);
    return;
  }

  // If the main headed Chrome session is unhealthy for a non-block reason,
  // restart it once before falling back.
  if (!data && mainScraper?.destroyBrowser) {
    try {
      console.warn("[server] Restarting main Chrome before scraper fallback");
      await mainScraper.destroyBrowser();
      await pollSleep(3000);
      data = await mainScraper.scrapeInventory(currentMaxPages);
      source = "main_restarted";
      mainError = null;
    } catch (e) {
      mainError = e;
      if (e.cookieState) lastCookieState = e.cookieState;
      console.warn(`[server] Main scraper restart failed: ${e.message}`);
      try { await mainScraper.destroyBrowser(); } catch (_) {}
      await pollSleep(1000);
      if (isTeslaBlockError(e.message)) {
        const reason = `Tesla block detected after main restart; main: ${e.message}`;
        const meta = parseTeslaErrorMeta(e.message);
        recordPollFailure(reason, { source: "blocked", scraper: "main_restarted", cookieState: e.cookieState || lastCookieState, ...meta });
        logPoll("blocked", 0, stripTeslaErrorMeta(reason), meta);
        return;
      }
      if (isBrowserLaunchError(e.message)) {
        const reason = `Browser launch/profile failure after main restart: ${e.message}`;
        const backedOff = recordBrowserLaunchFailure(reason);
        if (backedOff) await recycleScraperBrowsers("browser backoff");
        logPoll(backedOff ? "browser_backoff" : "browser_error", vehicles.length, reason);
        return;
      }
    }
  }

  // Try stealth scraper (puppeteer-extra — redundancy)
  if (!data && stealthScraper) {
    try {
      data = await stealthScraper.scrapeInventory(currentMaxPages);
      source = "stealth";
    } catch (e) {
      stealthError = e;
      if (e.cookieState) lastCookieState = e.cookieState;
      console.warn(`[server] Stealth scraper failed: ${e.message}`);
    }
  }

  if (source === "stealth" && stealthScraper?.destroyBrowser) {
    try {
      await stealthScraper.destroyBrowser();
    } catch (_) {}
  }

  if (!data) {
    const browserError = [mainError, stealthError].find((e) => e && isBrowserLaunchError(e.message));
    if (browserError) {
      const reason = `Browser launch/profile failure: ${browserError.message}`;
      const backedOff = recordBrowserLaunchFailure(reason);
      if (backedOff) await recycleScraperBrowsers("browser backoff");
      logPoll(backedOff ? "browser_backoff" : "browser_error", vehicles.length, reason);
      return;
    }
    const reason = mainError?.message ? `Both scrapers failed; main: ${mainError.message}` : "Both scrapers failed";
    const meta = parseTeslaErrorMeta(reason);
    recordPollFailure(reason, { source: "none", cookieState: mainError?.cookieState || stealthError?.cookieState || lastCookieState, ...meta });
    logPoll("none", 0, stripTeslaErrorMeta(reason), meta);
    return;
  }

  if (data.cookieState) lastCookieState = data.cookieState;

  if (data._domFallback) {
    const incoming = filterMonitoredVehicles((data.results || []).map(normalise)).map((v) => ({
      ...v,
      source: "dom",
      domSource: true,
    }));
    domDisplayVehicles = incoming;
    if (incoming.length) vehicles = incoming;
    rawInventory = data;
    stale = true;
    lastSource = "main_dom_fallback";
    recordTeslaRequests(data.requestCount || 1, "main_dom_fallback");
    appendPollEvent({
      source: "main_dom_fallback",
      vehicleCount: incoming.length,
      success: false,
      stale,
      error: data.partialReason || "DOM fallback display-only data",
      totalPolls,
      failedPolls,
      pagesFetched: data.pagesFetched || 1,
      maxPages: data.maxPages || currentMaxPages,
      requestCount: data.requestCount || 0,
      scrapeDurationMs: data.scrapeDurationMs || 0,
      partial: true,
      domFallback: true,
      cookieState: data.cookieState || null,
    });
    persistWatcherMeta();
    saveState(state);
    maybeFireBothSourcesStaleAlert();
    return;
  }

  if (data.partial) {
    const msg = `Scraper returned partial data after ${data.pagesFetched || 0} page(s): ${data.partialReason || "unknown reason"}. Skipping state mutation.`;
    console.warn(`[server] ${msg}`);
    if (isTeslaBlockError(data.partialReason)) {
      recordTeslaRequests(data.requestCount || data.pagesFetched || 1, `${source}_partial`);
      appendTeslaBlockIncident(data.partialReason, {
        source: `${source || "unknown"}_partial`,
        scraper: source,
        pagesFetched: data.pagesFetched || 0,
        requestCount: data.requestCount || 0,
        cookieState: data.cookieState || lastCookieState,
      });
    }
    appendPollEvent({
      source: `${source || "unknown"}_partial`,
      vehicleCount: (data.results || []).length,
      success: false,
      stale,
      error: msg,
      totalPolls,
      failedPolls,
      pagesFetched: data.pagesFetched || 0,
      maxPages: data.maxPages || currentMaxPages,
      requestCount: data.requestCount || 0,
      scrapeDurationMs: data.scrapeDurationMs || 0,
      partial: true,
      cookieState: data.cookieState || null,
    });
    maybeFireBothSourcesStaleAlert();
    return;
  }

  const cappedPoll = data.capped === true;
  const allIncoming = (data.results || []).map(normalise);
  const incoming = filterMonitoredVehicles(allIncoming);

  const newTotal = incoming.length;
  const previousActive = monitoredActiveVehicleCount();
  const dropRatio = previousActive > 0 ? newTotal / previousActive : 1;
  if (!cappedPoll && previousActive > POLL_DROP_MIN_VEHICLES && dropRatio < POLL_DROP_THRESHOLD) {
    const msg = `API returned ${newTotal} monitored vehicles, down ${Math.round((1 - dropRatio) * 100)}% from ${previousActive} active. Treating as partial response; skipping this poll.`;
    console.warn(`[server] ${msg}`);
    try {
      fs.mkdirSync(LOG_DIR, { recursive: true });
      rotateFile(SERVER_LOG_FILE);
      fs.appendFileSync(SERVER_LOG_FILE, `[${new Date().toISOString()}] ${source}_partial: ${msg}\n`);
    } catch (_) {}
    appendPollEvent({
      source: `${source || "unknown"}_partial`,
      vehicleCount: newTotal,
      success: false,
      stale,
      error: msg,
      totalPolls,
      failedPolls,
      dropRatio,
      previousActive,
      rawVehicleCount: allIncoming.length,
      monitoredStates: MONITORED_STATES,
      cookieState: data.cookieState || null,
    });
    maybeFireBothSourcesStaleAlert();
    return;
  }

  rawInventory = data;
  domDisplayVehicles = [];
  recordTeslaRequests(data.requestCount || data.pagesFetched || 0, source || "success");

  updateKeywordHealth(incoming, Date.now(), { suppressAlert: cappedPoll });

  // Diff against persisted state
  const persistedVehicles = state.vehicles || {};
  const now = Date.now();
  retireOutOfScopeVehicles(persistedVehicles, now);
  const silentBaseline = !persistedStateExisted && Object.keys(persistedVehicles).length === 0;
  newHashes = [];
  const seenHashes = new Set();

  for (const v of incoming) {
    if (!v.id) continue; // skip vehicles with no identifier
    seenHashes.add(v.id);
    const existing = persistedVehicles[v.id];

    if (!existing) {
      // Genuinely new vehicle
      v.firstSeen = now;
      v.lastSeen = now;
      v.baseline = silentBaseline;
      v.priceHistory = [{ t: now, p: v.price }];
      newHashes.push(v.id);

      persistedVehicles[v.id] = { priceHistory: [{ t: now, p: v.price }], baseline: silentBaseline };
      updatePersistedVehicle(persistedVehicles[v.id], v, now, now);

      appendVehicleEvent("appeared", v, { baseline: silentBaseline });

      if (!silentBaseline && matchesTarget(v)) {
        console.log(`[server] NEW MATCH: ${v.exterior} / ${v.interior} in ${v.state}`);
        appendVehicleEvent("matchDetected", v, { reason: "newVehicle" });
        fireAlerts(v);
        persistedVehicles[v.id].lastAlertTargetVersion = targetVersion;
      } else if (!silentBaseline) {
        console.log(`[server] New vehicle (no match): ${v.exterior} / ${v.interior} in ${v.state}`);
      }
    } else {
      // Update existing
      const wasRemoved = !!existing.removedAt;
      const firstSeen = wasRemoved ? now : existing.firstSeen;
      if (wasRemoved) newHashes.push(v.id);

      v.firstSeen = firstSeen;
      v.lastSeen = now;
      v.baseline = existing.baseline === true;
      v.priceHistory = existing.priceHistory || [];

      if (!Array.isArray(existing.priceHistory) || existing.priceHistory.length === 0) {
        existing.priceHistory = [{ t: now, p: v.price }];
      } else {
        const lastPrice = existing.priceHistory[existing.priceHistory.length - 1].p;
        if (v.price !== lastPrice) {
          existing.priceHistory.push({ t: now, p: v.price });
          appendVehicleEvent("priceChanged", v, { previousPrice: lastPrice, newPrice: v.price });
        }
      }

      updatePersistedVehicle(existing, v, now, firstSeen);
      v.priceHistory = existing.priceHistory;

      if (wasRemoved) {
        appendVehicleEvent("appeared", v, { relisted: true, baseline: existing.baseline === true });
      }

      if (wasRemoved && matchesTarget(v)) {
        console.log(`[server] NEW MATCH: ${v.exterior} / ${v.interior} in ${v.state} (relisted)`);
        appendVehicleEvent("matchDetected", v, { reason: "relisted" });
        fireAlerts(v);
        existing.lastAlertTargetVersion = targetVersion;
      } else if (
        targetVersion > 0 &&
        existing.lastAlertTargetVersion !== targetVersion &&
        matchesTarget(v)
      ) {
        console.log(`[server] NEW MATCH: ${v.exterior} / ${v.interior} in ${v.state} (target update)`);
        appendVehicleEvent("matchDetected", v, { reason: "targetUpdate" });
        fireAlerts(v);
        existing.lastAlertTargetVersion = targetVersion;
      }
    }
  }

  // Mark disappeared vehicles only when the poll was complete. Capped polls are
  // intentional slices and must not make unseen inventory look removed.
  if (!cappedPoll) {
    for (const [hash, pv] of Object.entries(persistedVehicles)) {
      if (!isMonitoredState(pv.state)) continue;
      if (!seenHashes.has(hash) && !pv.removedAt) {
        pv.removedAt = now;
        appendVehicleEvent("removed", { ...vehicleFromPersisted(hash, pv), id: hash }, { removedAt: now });
      }
    }
  } else {
    console.warn(`[server] Poll capped at ${data.maxPages || currentMaxPages} page(s); preserving unseen active vehicles`);
  }
  pruneOldRemovedVehicles(now);

  // Update state tracking
  recordPollSuccess(source);
  state.vehicles = persistedVehicles;

  // Attach firstSeen/lastSeen/priceHistory to vehicle objects for UI
  for (const v of incoming) {
    const pv = persistedVehicles[v.id];
    if (pv) {
      v.firstSeen = pv.firstSeen;
      v.lastSeen = pv.lastSeen;
      v.priceHistory = pv.priceHistory;
    }
  }

  let nextVehicles = incoming;
  if (cappedPoll) {
    const merged = new Map(incoming.map((v) => [v.id, v]));
    for (const [hash, pv] of Object.entries(persistedVehicles)) {
      if (!pv.removedAt && isMonitoredState(pv.state) && !merged.has(hash)) {
        merged.set(hash, vehicleFromPersisted(hash, pv));
      }
    }
    nextVehicles = Array.from(merged.values());
  }

  vehicles = nextVehicles;
  saveState(state);
  persistedStateExisted = true;
  logPoll(cappedPoll ? `${source}_capped` : source, incoming.length, null, {
    pagesFetched: data.pagesFetched || 0,
    maxPages: data.maxPages || currentMaxPages,
    requestCount: data.requestCount || 0,
    scrapeDurationMs: data.scrapeDurationMs || 0,
    capped: cappedPoll,
    totalMatchesFound: data.total_matches_found ?? allIncoming.length,
    rawVehicleCount: allIncoming.length,
    monitoredVehicleCount: incoming.length,
    monitoredStates: MONITORED_STATES,
    postBlockCautionActive: activePostBlockCaution(),
    requestBudgetLimited: requestBudgetLimited(),
    cookieState: data.cookieState || null,
  });
}

let _polling = false;
let _pollTimer = null;
let _nextPollDueAt = 0;
let _nextPollDelayOverrideMs = null;
let _telegramTimer = null;
let _nextTelegramPollDueAt = 0;

function scheduleNextPoll(delayMs = null) {
  if (_pollTimer) clearTimeout(_pollTimer);
  const nextDelay = Number.isFinite(delayMs) && delayMs >= 0
    ? delayMs
    : nextInventoryPollDelayMs();
  _nextPollDueAt = Date.now() + nextDelay;
  _pollTimer = setTimeout(pollLoop, nextDelay);
}

function nextTelegramPollDelayMs() {
  if (!TELEGRAM_INVENTORY_ENABLED) return TELEGRAM_POLL_INTERVAL_MS;
  if (!businessHoursActive()) {
    const untilBusiness = msUntilBusinessHoursStart();
    if (Number.isFinite(untilBusiness)) {
      return Math.max(1000, untilBusiness + Math.floor(Math.random() * BUSINESS_START_POLL_JITTER_MS));
    }
  }
  return Math.max(60 * 1000, Math.round(TELEGRAM_POLL_INTERVAL_MS * (0.85 + Math.random() * 0.3)));
}

function scheduleNextTelegramPoll(delayMs = null) {
  if (_telegramTimer) clearTimeout(_telegramTimer);
  const nextDelay = Number.isFinite(delayMs) && delayMs >= 0 ? delayMs : nextTelegramPollDelayMs();
  _nextTelegramPollDueAt = Date.now() + nextDelay;
  _telegramTimer = setTimeout(telegramPollLoop, nextDelay);
}

async function telegramPollLoop() {
  try {
    if (TELEGRAM_INVENTORY_ENABLED && businessHoursActive()) {
      const status = await pollTelegramMessages({ enabled: true });
      console.log(`[telegram] ${status.status}: ${status.myMessageCount} MY messages, last ${status.lastMessageAt ? new Date(status.lastMessageAt).toISOString() : "never"}`);
      maybeFireBothSourcesStaleAlert();
    }
  } catch (e) {
    console.warn(`[telegram] Poll failed: ${e.message}`);
  } finally {
    scheduleNextTelegramPoll();
  }
}

async function pollLoop() {
  if (_polling) return;
  _polling = true;
  try {
    await doPoll();
  } catch (e) {
    console.error("[server] Poll error:", e.message);
    recordPollFailure(e.message, { source: "pollLoop", ...parseTeslaErrorMeta(e.message) });
    appendPollEvent({
      source: "pollLoop",
      vehicleCount: vehicles.length,
      success: false,
      stale,
      error: stripTeslaErrorMeta(e.message),
      totalPolls,
      failedPolls,
      ...parseTeslaErrorMeta(e.message),
    });
  } finally {
    _polling = false;
    const delayOverride = _nextPollDelayOverrideMs;
    _nextPollDelayOverrideMs = null;
    scheduleNextPoll(delayOverride);
    maybeFireBothSourcesStaleAlert();
  }
}

async function runShopScrapeWithExistingBrowser() {
  if (SHOP_SCRAPE_MODE !== "browser") {
    try {
      const fetchResults = await scrapeShopProductsByFetch();
      if (fetchResults.length && !fetchResults.some((product) => product.status === "unknown")) {
        return fetchResults;
      }
      console.warn("[shop] Fetch-first scrape returned unknown status; falling back to shared browser");
    } catch (e) {
      console.warn(`[shop] Fetch-first scrape failed; falling back to shared browser: ${e.message}`);
    }
  }

  const scrapers = [mainScraper, stealthScraper].filter(Boolean);
  let lastError = null;

  for (const scraper of scrapers) {
    if (typeof scraper.withScraperPage !== "function") continue;
    try {
      return await scraper.withScraperPage((page) => scrapeShopProducts(page));
    } catch (e) {
      lastError = e;
      console.warn(`[shop] Scrape failed via shared browser: ${e.message}`);
    }
  }

  throw lastError || new Error("No scraper with shared page helper available");
}

async function doShopPoll() {
  const results = await runShopScrapeWithExistingBrowser();
  const existingProducts = state.shopProducts || {};
  const nextProducts = {};
  const firstShopPoll = !lastShopPollAt && Object.keys(existingProducts).length === 0;

  for (const product of results) {
    const existing = existingProducts[product.id] || {};
    const becameAvailable = !firstShopPoll && existing.status === "out_of_stock" && product.status === "in_stock";
    const lastAlertAt = Number(existing.lastAlertAt || 0);
    const alertCooldownActive = lastAlertAt && product.checkedAt - lastAlertAt < SHOP_ALERT_COOLDOWN_MS;
    const shouldAlert = becameAvailable && !alertCooldownActive;
    const entry = {
      id: product.id,
      name: product.name,
      url: product.url,
      status: product.status,
      lastInStockAt: becameAvailable ? product.checkedAt : Number(existing.lastInStockAt || 0),
      lastCheckedAt: product.checkedAt,
      lastAlertAt,
      alertsSent: Number(existing.alertsSent || 0),
    };

    if (shouldAlert) {
      entry.lastAlertAt = product.checkedAt;
      entry.alertsSent += 1;
      appendVehicleEvent("shopInStock", { id: product.id, location: "Tesla Shop" }, {
        productName: product.name,
        productUrl: product.url,
        previousStatus: existing.status || "unknown",
        status: product.status,
      });
      fireShopAlert(entry);
    } else if (becameAvailable && alertCooldownActive) {
      appendVehicleEvent("shopAlertSuppressed", { id: product.id, location: "Tesla Shop" }, {
        productName: product.name,
        productUrl: product.url,
        status: product.status,
        reason: "shopCooldown",
        cooldownMs: SHOP_ALERT_COOLDOWN_MS,
        lastAlertAt,
      });
      console.log(`[alert] Shop alert cooldown active; suppressed ${product.id}`);
    }

    nextProducts[product.id] = entry;
  }

  for (const product of SHOP_PRODUCTS) {
    if (!nextProducts[product.id] && existingProducts[product.id]) {
      nextProducts[product.id] = existingProducts[product.id];
    }
  }

  shopProducts = nextProducts;
  state.shopProducts = shopProducts;
  lastShopPollAt = Date.now();
  lastShopPollError = null;
  persistWatcherMeta();
  saveState(state);
  const productValues = Object.values(shopProducts);
  const inStockCount = productValues.filter((p) => p.status === "in_stock").length;
  const blockedCount = productValues.filter((p) => p.status === "blocked").length;
  console.log(`[shop] Poll complete: ${inStockCount}/${SHOP_PRODUCTS.length} in stock${blockedCount ? `, ${blockedCount} blocked` : ""}`);
}

let _shopPolling = false;
let _shopPollTimer = null;

async function shopPollLoop() {
  if (_shopPolling) return;
  if (DIRECT_INVENTORY_ENABLED && _polling) {
    console.warn("[shop] Inventory poll active; delaying shop poll");
    setTimeout(shopPollLoop, 120000);
    return;
  }
  if (DIRECT_INVENTORY_ENABLED && teslaBlockCooldownUntil && Date.now() < teslaBlockCooldownUntil) {
    console.warn("[shop] Tesla block cooldown active; delaying shop poll");
    setTimeout(shopPollLoop, 5 * 60 * 1000);
    return;
  }
  if (browserBackoffUntil && Date.now() < browserBackoffUntil) {
    console.warn("[shop] Browser backoff active; delaying shop poll");
    setTimeout(shopPollLoop, 5 * 60 * 1000);
    return;
  }
  if (DIRECT_INVENTORY_ENABLED && activeTeslaPressureMode()) {
    console.warn(`[shop] Tesla pressure mode active until ${new Date(teslaPressureModeUntil).toISOString()}; delaying shop poll`);
    setTimeout(shopPollLoop, Math.min(15 * 60 * 1000, Math.max(1000, teslaPressureModeUntil - Date.now())));
    return;
  }
  if (DIRECT_INVENTORY_ENABLED && shopSuppressedUntil && Date.now() < shopSuppressedUntil) {
    console.warn(`[shop] Post-block shop suppression active until ${new Date(shopSuppressedUntil).toISOString()}`);
    setTimeout(shopPollLoop, Math.min(5 * 60 * 1000, Math.max(1000, shopSuppressedUntil - Date.now())));
    return;
  }
  if (lastShopPollAt && Date.now() - lastShopPollAt < effectiveShopPollIntervalMs()) {
    return;
  }
  _shopPolling = true;
  try {
    await doShopPoll();
  } catch (e) {
    lastShopPollError = e.message;
    persistWatcherMeta();
    saveState(state);
    console.error("[shop] Poll error:", e.message);
  } finally {
    _shopPolling = false;
  }
}

function effectiveShopPollIntervalMs() {
  return tripModeEnabled ? TRIP_MODE_SHOP_POLL_INTERVAL_MS : SHOP_POLL_INTERVAL;
}

function getActiveScraperStatus() {
  const mainStatus = mainScraper?.getStatus ? mainScraper.getStatus() : null;
  const stealthStatus = stealthScraper?.getStatus ? stealthScraper.getStatus() : null;
  const active = lastSource === "stealth" ? stealthStatus : mainStatus;
  const fallback = mainStatus || stealthStatus || {};
  return {
    activeScraper: lastSource || (mainStatus ? "main" : stealthStatus ? "stealth" : "none"),
    chromeBackgroundMode: active?.chromeBackgroundMode || fallback.chromeBackgroundMode || process.env.CHROME_BACKGROUND_MODE || "minimize",
    chromePath: active?.chromePath || fallback.chromePath || process.env.CHROME_PATH || "",
    chromePathSource: active?.chromePathSource || fallback.chromePathSource || (process.env.CHROME_PATH ? "env" : ""),
    chromeUserDataDir: active?.chromeUserDataDir || fallback.chromeUserDataDir || process.env.CHROME_USER_DATA_DIR || "",
    browserLanguage: active?.browserLanguage || fallback.browserLanguage || process.env.BROWSER_LANGUAGE || "en-AU,en;q=0.9",
    browserChromeLang: active?.browserChromeLang || fallback.browserChromeLang || process.env.BROWSER_CHROME_LANG || "en-AU",
    browserTimezone: active?.browserTimezone || fallback.browserTimezone || process.env.BROWSER_TIMEZONE || "Australia/Melbourne",
    browserViewport: active?.browserViewport || fallback.browserViewport || {
      width: Number(process.env.BROWSER_VIEWPORT_WIDTH || 900),
      height: Number(process.env.BROWSER_VIEWPORT_HEIGHT || 700),
      deviceScaleFactor: 1,
    },
    proxyFailoverEnabled: active?.proxyFailoverEnabled ?? fallback.proxyFailoverEnabled ?? PROXY_FAILOVER_ENABLED,
    proxyConfigured: active?.proxyConfigured ?? fallback.proxyConfigured ?? !!CHROME_PROXY_SERVER,
    browserConnected: !!(active?.browserConnected ?? fallback.browserConnected),
    browserAgeMs: active?.browserAgeMs ?? fallback.browserAgeMs ?? null,
    browserPageCount: active?.browserPageCount ?? fallback.browserPageCount ?? null,
    chromeProcessCount: active?.chromeProcessCount ?? fallback.chromeProcessCount ?? null,
    lastScrapeDurationMs: active?.lastScrapeDurationMs ?? fallback.lastScrapeDurationMs ?? 0,
    lastScrapeError: active?.lastScrapeError ?? fallback.lastScrapeError ?? null,
  };
}

// ── Routes ────────────────────────────────────────────────────────────────────

// Normalised inventory for the web UI
app.get("/api/inventory", (_req, res) => {
  const now = Date.now();
  const vehiclesWithMeta = filterMonitoredVehicles(vehicles).map((v) => ({
    ...v,
    fresh: newHashes.includes(v.id),
    removed: null,
  }));

  // Include removed vehicles from persisted state
  const persistedVehicles = state.vehicles || {};
  for (const [hash, pv] of Object.entries(persistedVehicles)) {
    if (pv.removedAt && isMonitoredState(pv.state) && !vehiclesWithMeta.find((v) => v.id === hash)) {
      vehiclesWithMeta.push({
        ...vehicleFromPersisted(hash, pv),
        fresh: false,
        removed: pv.removedAt,
      });
    }
  }

  res.json({
    vehicles: vehiclesWithMeta,
    newHashes,
    source: lastSource === "main_dom_fallback" ? "main_dom_fallback" : stale ? "stale" : lastSource,
    stale,
    lastSuccess: lastSuccessAt,
    timestamp: now,
    total: vehicles.length,
    monitoredStates: MONITORED_STATES,
    alertsSent,
    keywordMatchCount,
    keywordHealthCandidateCount,
    keywordHealthy,
    keywordLastAlertAt,
  });
});

function shopProductsForApi(now = Date.now()) {
  const order = new Map(SHOP_PRODUCTS.map((product, index) => [product.id, index]));
  return Object.values(shopProducts || {})
    .sort((a, b) => (order.get(a.id) ?? 999) - (order.get(b.id) ?? 999))
    .map((product) => ({
      ...product,
      fresh: !!(
        product.lastInStockAt &&
        product.status === "in_stock" &&
        now - product.lastInStockAt < SHOP_FRESH_MS
      ),
    }));
}

app.get("/api/shop-products", (_req, res) => {
  const now = Date.now();
  res.json({
    products: shopProductsForApi(now),
    lastChecked: lastShopPollAt || 0,
    pollIntervalMs: effectiveShopPollIntervalMs(),
    stale: !lastShopPollAt || (now - lastShopPollAt > effectiveShopPollIntervalMs() * 2),
  });
});

app.get("/api/sources", (_req, res) => {
  res.json(sourceHealth());
});

// Health check
app.get("/api/health", (_req, res) => {
  const health = currentHealthStatus();
  const readiness = health.readiness;
  const scraperStatus = getActiveScraperStatus();
  const pollSummary = pollLogSummary();
  const stateStat = fileStat(STATE_FILE);
  const pollLogStat = fileStat(POLL_LOG_FILE);
  const blockLogStat = fileStat(BLOCK_EVENT_LOG_FILE);
  const serverLogStat = fileStat(SERVER_LOG_FILE);
  const vehicleEventLogStat = fileStat(VEHICLE_EVENT_LOG_FILE);
  const backups = backupStats();
  const memoryStats = containerMemoryStats();
  recordMemorySample(memoryStats);
  const memoryTrendStats = memoryTrend();
  const sources = sourceHealth();
  res.json({
    status: health.status,
    buildVersion: BUILD_VERSION,
    schemaVersion: state.schemaVersion || STATE_SCHEMA_VERSION,
    deploymentMode: DEPLOYMENT_MODE,
    hostName: os.hostname(),
    monitoredStates: MONITORED_STATES,
    monitoredMaxPages: MONITORED_MAX_PAGES > 0 ? Math.floor(MONITORED_MAX_PAGES) : null,
    directInventoryEnabled: DIRECT_INVENTORY_ENABLED,
    realAlertsEnabled: realAlertsEnabled(),
    display: process.env.DISPLAY || "",
    processLang: process.env.LANG || "",
    processLcAll: process.env.LC_ALL || "",
    processTimezone: process.env.TZ || "",
    chromeUserDataDir: scraperStatus.chromeUserDataDir || process.env.CHROME_USER_DATA_DIR || "",
    uptime: Math.floor((Date.now() - state.watcher.startedAt) / 1000),
    lastPoll: lastPollAt,
    lastSuccess: lastSuccessAt,
    lastSource,
    pollingActive: _polling,
    totalPolls,
    failedPolls,
    consecutiveFailedPolls,
    lastFailureAt,
    lastRecoveryAt,
    lastError,
    teslaBlockCooldownUntil,
    teslaBlockCooldownRemainingMs: Math.max(0, teslaBlockCooldownUntil - Date.now()),
    consecutiveTeslaBlocks,
    teslaBlockDay,
    teslaBlockDayCount,
    teslaPressureModeActive: activeTeslaPressureMode(),
    teslaPressureModeUntil,
    teslaPressureModeRemainingMs: Math.max(0, teslaPressureModeUntil - Date.now()),
    teslaPressureBlockThreshold: TESLA_PRESSURE_BLOCK_THRESHOLD,
    teslaPressurePollIntervalMs: TESLA_PRESSURE_POLL_INTERVAL_MS,
    lastTeslaBlockAlertAt,
    watcherStale: health.watcherStale,
    watcherStaleThresholdMs: WATCHER_STALE_MS,
    watcherAlertCooldownMs: WATCHER_ALERT_COOLDOWN_MS,
    teslaBlockCooldownMs: TESLA_BLOCK_COOLDOWN_MS,
    teslaBlockCooldownStepsMs: TESLA_BLOCK_COOLDOWN_STEPS_MS,
    teslaBlockAlertCooldownMs: TESLA_BLOCK_ALERT_COOLDOWN_MS,
    browserLaunchFailures,
    lastBrowserLaunchError,
    browserBackoffUntil,
    browserBackoffRemainingMs: Math.max(0, browserBackoffUntil - Date.now()),
    browserBackoffMs: BROWSER_BACKOFF_MS,
    browserBackoffFailureThreshold: BROWSER_BACKOFF_FAILURE_THRESHOLD,
    postBlockCautionUntil,
    postBlockCautionRemainingMs: Math.max(0, postBlockCautionUntil - Date.now()),
    postBlockCautionMs: POST_BLOCK_CAUTION_MS,
    postBlockCautionPollIntervalMs: POST_BLOCK_CAUTION_POLL_INTERVAL_MS,
    postBlockCautionMaxPages: POST_BLOCK_CAUTION_MAX_PAGES,
    shopSuppressedUntil,
    shopSuppressedRemainingMs: Math.max(0, shopSuppressedUntil - Date.now()),
    startupGraceUntil,
    startupGraceRemainingMs: Math.max(0, startupGraceUntil - Date.now()),
    teslaRequestStats: normalizeTeslaRequestStats(),
    teslaRequestDailySoftLimit: TESLA_REQUEST_DAILY_SOFT_LIMIT,
    teslaRequestHourlySoftLimit: TESLA_REQUEST_HOURLY_SOFT_LIMIT,
    requestBudgetLimited: requestBudgetLimited(),
    cookieState: lastCookieState,
    domFallbackEnabled: effectiveDomFallbackEnabled(),
    domFallbackConfigured: process.env.DOM_SCRAPE_FALLBACK === "true",
    autoDomFallbackEnabled: AUTO_DOM_FALLBACK_ENABLED,
    autoDomFallbackActive: autoDomFallbackActive(),
    autoDomFallbackAfterMs: AUTO_DOM_FALLBACK_AFTER_MS,
    domDisplayVehicleCount: domDisplayVehicles.length,
    browserInteractionMode: process.env.BROWSER_INTERACTION_MODE || "normal",
    browserReferrerChain: process.env.BROWSER_REFERRER_CHAIN !== "false",
    telegramInventoryEnabled: TELEGRAM_INVENTORY_ENABLED,
    telegramPollIntervalMs: TELEGRAM_POLL_INTERVAL_MS,
    bothSourcesStaleMs: BOTH_SOURCES_STALE_MS,
    lastBothSourcesStaleAlertAt,
    bothSourcesStaleAlerted,
    sources,
    lastBlockEventAt,
    lastBlockPhase,
    externalNetworkIdentity,
    externalNetworkIdentityCheckedAt,
    strictHealth: strictHealthStatus(),
    tripModeEnabled,
    effectivePollIntervalMs: effectivePollIntervalMs(),
    tripModePollIntervalMs: TRIP_MODE_POLL_INTERVAL_MS,
    tripModeShopPollIntervalMs: TRIP_MODE_SHOP_POLL_INTERVAL_MS,
    effectiveShopPollIntervalMs: effectiveShopPollIntervalMs(),
    businessTimezone: BUSINESS_TIMEZONE,
    businessHour: businessHour(),
    businessHoursStart: BUSINESS_HOURS_START,
    businessHoursEnd: BUSINESS_HOURS_END,
    businessHoursActive: businessHoursActive(),
    activePollIntervalMs: ACTIVE_POLL_INTERVAL_MS,
    quietPollIntervalMs: QUIET_POLL_INTERVAL_MS,
    activeMaxPages: ACTIVE_MAX_PAGES,
    quietMaxPages: QUIET_MAX_PAGES,
    maxPollPages: maxPollPages(),
    nextScheduledPollAt: DIRECT_INVENTORY_ENABLED ? _nextPollDueAt : 0,
    nextTelegramPollAt: _nextTelegramPollDueAt,
    keywordAlertCooldownMs: KEYWORD_ALERT_COOLDOWN_MS,
    keywordMatchCount,
    keywordHealthCandidateCount,
    keywordHealthy,
    keywordStaleAlerted,
    keywordLastAlertAt,
    lastKeywordAlertAt: keywordLastAlertAt,
    keywordCandidates: keywordCandidateSummaries(vehicles),
    sixSeatCandidateCount: sixSeatCandidateSummaries(vehicles, Number.MAX_SAFE_INTEGER).length,
    sixSeatCandidates: sixSeatCandidateSummaries(vehicles),
    lastExactMatchTestAt,
    shopProductCount: Object.keys(shopProducts || {}).length,
    shopScrapeMode: SHOP_SCRAPE_MODE,
    shopAlertCooldownMs: SHOP_ALERT_COOLDOWN_MS,
    shopProductsInStock: Object.values(shopProducts || {}).filter((product) => product.status === "in_stock").length,
    lastShopPollAt: lastShopPollAt,
    pollDropThreshold: POLL_DROP_THRESHOLD,
    pollDropMinVehicles: POLL_DROP_MIN_VEHICLES,
    matchAlertCooldownMs: MATCH_ALERT_COOLDOWN_MS,
    lastMatchAlertAt,
    alertsSnoozedUntil,
    alertsSnoozeRemainingMs: alertsSnoozedUntil ? Math.max(0, alertsSnoozedUntil - Date.now()) : 0,
    localSoundAvailable: LOCAL_SOUND_AVAILABLE,
    maxTrackedVehicleAgeMs: MAX_TRACKED_VEHICLE_AGE_MS,
    chromeMaxAgeMs: CHROME_MAX_AGE_MS,
    chromeMaxProcesses: CHROME_MAX_PROCESSES,
    chromeMaxPages: CHROME_MAX_PAGES,
    watcherOutageAlerted,
    lastWatcherAlertAt,
    vehicleCount: vehicles.length,
    monitoredVehicleCount: filterMonitoredVehicles(vehicles).length,
    alertsSent,
    stale,
    alertReady: readiness.alertReady,
    alertTestsEnabled: ALERT_TESTS_ENABLED,
    pushoverConfigured: readiness.pushoverConfigured,
    emailConfigured: readiness.emailConfigured,
    alertMissing: readiness.missing,
    stateFile: STATE_FILE,
    stateBackupDir: STATE_BACKUP_DIR,
    serverLog: SERVER_LOG_FILE,
    pollLog: POLL_LOG_FILE,
    blockEventLog: BLOCK_EVENT_LOG_FILE,
    vehicleEventLog: VEHICLE_EVENT_LOG_FILE,
    stateFileSize: stateStat.size,
    pollLogSize: pollLogStat.size,
    blockEventLogSize: blockLogStat.size,
    serverLogSize: serverLogStat.size,
    vehicleEventLogSize: vehicleEventLogStat.size,
    lastPollEventAt: pollSummary.lastPollEventAt,
    recentPollWindow: pollSummary.recentPollWindow,
    recentPollSuccesses: pollSummary.recentPollSuccesses,
    recentSuccessRate: pollSummary.recentSuccessRate,
    nextPollDueAt: DIRECT_INVENTORY_ENABLED ? Math.max(_nextPollDueAt || 0, teslaBlockCooldownUntil || 0) : 0,
    backupCount: backups.backupCount,
    latestBackupAt: backups.latestBackupAt,
    latestBackupValid: backups.latestBackupValid,
    latestBackupVehicleCount: backups.latestBackupVehicleCount,
    backupError: backups.backupError || null,
    stateValidation: state.validation || null,
    lastValidated: state.lastValidated || 0,
    lastStateSave,
    ...memoryStats,
    ...memoryTrendStats,
    ...scraperStatus,
  });
});

app.get("/api/health/strict", (_req, res) => {
  const strict = strictHealthStatus();
  res.status(strict.ok ? 200 : 503).json({
    ...strict,
    buildVersion: BUILD_VERSION,
    lastPoll: lastPollAt,
    lastSuccess: lastSuccessAt,
    lastError,
    tripModeEnabled,
  });
});

app.get("/api/poll-events", (req, res) => {
  const limit = Math.min(Math.max(parseInt(req.query.limit || `${RECENT_POLLS_LIMIT}`, 10) || RECENT_POLLS_LIMIT, 1), 100);
  res.json({
    events: readRecentPollEvents(limit),
    pollLog: POLL_LOG_FILE,
    timestamp: Date.now(),
  });
});

app.get("/api/block-events", (req, res) => {
  const limit = Math.min(Math.max(parseInt(req.query.limit || `${RECENT_POLLS_LIMIT}`, 10) || RECENT_POLLS_LIMIT, 1), 100);
  res.json({
    events: readRecentBlockEvents(limit),
    blockEventLog: BLOCK_EVENT_LOG_FILE,
    timestamp: Date.now(),
  });
});

app.get("/api/vehicle-events", (req, res) => {
  const limit = Math.min(Math.max(parseInt(req.query.limit || `${RECENT_POLLS_LIMIT}`, 10) || RECENT_POLLS_LIMIT, 1), 100);
  res.json({
    events: readRecentJsonl(VEHICLE_EVENT_LOG_FILE, limit),
    vehicleEventLog: VEHICLE_EVENT_LOG_FILE,
    timestamp: Date.now(),
  });
});

app.get("/api/exact-match-test", (_req, res) => {
  res.json({
    ok: true,
    lastExactMatchTestAt,
  });
});

app.post("/api/exact-match-test", (req, res) => {
  lastExactMatchTestAt = Date.now();
  if (!state.watcher) state.watcher = {};
  state.watcher.lastExactMatchTestAt = lastExactMatchTestAt;
  saveState(state);
  appendVehicleEvent("exactMatchTest", testAlertVehicle(), {
    source: req.body?.source || "ui",
    previewOnly: true,
  });
  res.json({
    ok: true,
    lastExactMatchTestAt,
  });
});

// Last raw Tesla payload for local debugging.
app.get("/api/raw-inventory", (_req, res) => {
  res.json({
    source: lastSource === "main_dom_fallback" ? "main_dom_fallback" : stale ? "stale" : lastSource,
    stale,
    lastSuccess: lastSuccessAt,
    timestamp: Date.now(),
    raw: rawInventory,
  });
});

// Target config — get
app.get("/api/target", (_req, res) => {
  res.json(targetConfig);
});

// Target config — update
app.post("/api/target", (req, res) => {
  if (req.body && typeof req.body === "object") {
    targetConfig = normalizeTargetConfig({ ...targetConfig, ...req.body });
    targetVersion++;
    state.targetConfig = targetConfig;
    if (!state.watcher) state.watcher = {};
    state.watcher.targetConfig = targetConfig;
    saveState(state);
    console.log("[server] Target config updated:", JSON.stringify(targetConfig));
  }
  res.json({ ok: true, target: targetConfig });
});

// Runtime automatic-alert toggle. Initial value still comes from REAL_ALERTS_ENABLED.
app.post("/api/alerts/toggle", (req, res) => {
  const durationMs = Number(req.body?.durationMs) || 0;
  if (durationMs > 0) {
    scheduleAlertsSnooze(durationMs);
  } else if (req.body && Object.prototype.hasOwnProperty.call(req.body, "enabled")) {
    setRealAlertsEnabled(req.body.enabled !== false, { clearSnooze: true, save: true, reason: "API toggle" });
  } else {
    setRealAlertsEnabled(!realAlertsEnabled(), { clearSnooze: true, save: true, reason: "API toggle" });
  }
  res.json({
    ok: true,
    realAlertsEnabled: realAlertsEnabled(),
    alertsEnabled: realAlertsEnabled(),
    snoozedUntil: alertsSnoozedUntil || 0,
    remainingMs: alertsSnoozedUntil ? Math.max(0, alertsSnoozedUntil - Date.now()) : 0,
    durationMs,
  });
});

app.get("/api/alerts/snooze", (_req, res) => {
  res.json({
    enabled: realAlertsEnabled(),
    realAlertsEnabled: realAlertsEnabled(),
    snoozedUntil: alertsSnoozedUntil || 0,
    remainingMs: alertsSnoozedUntil ? Math.max(0, alertsSnoozedUntil - Date.now()) : 0,
  });
});

app.get("/api/trip-mode", (_req, res) => {
  res.json({
    ok: true,
    tripModeEnabled,
    effectivePollIntervalMs: effectivePollIntervalMs(),
    tripModePollIntervalMs: TRIP_MODE_POLL_INTERVAL_MS,
    tripModeShopPollIntervalMs: TRIP_MODE_SHOP_POLL_INTERVAL_MS,
  });
});

app.post("/api/trip-mode", (req, res) => {
  const enabled = req.body?.enabled !== false;
  tripModeEnabled = enabled;
  persistWatcherMeta();
  saveState(state);
  console.log(`[server] Trip mode ${tripModeEnabled ? "enabled" : "disabled"} via API`);
  res.json({
    ok: true,
    tripModeEnabled,
    effectivePollIntervalMs: effectivePollIntervalMs(),
    tripModePollIntervalMs: TRIP_MODE_POLL_INTERVAL_MS,
    tripModeShopPollIntervalMs: TRIP_MODE_SHOP_POLL_INTERVAL_MS,
  });
});

// Alert channel test — uses the same senders as real matches.
app.post("/api/test-alert", async (_req, res) => {
  if (!ALERT_TESTS_ENABLED) {
    return res.status(403).json({ ok: false, error: "Live alert tests are disabled" });
  }
  const readiness = getAlertReadiness();
  if (!readiness.alertReady) {
    return res.status(400).json({
      ok: false,
      error: "Missing required alert configuration",
      missing: readiness.missing,
      pushoverConfigured: readiness.pushoverConfigured,
      emailConfigured: readiness.emailConfigured,
    });
  }

  const vehicle = testAlertVehicle();
  try {
    await sendPushoverAlert(vehicle);
  } catch (e) {
    return res.status(502).json({ ok: false, channel: "pushover", error: e.message });
  }
  try {
    await sendEmailAlert(vehicle);
  } catch (e) {
    return res.status(502).json({ ok: false, channel: "email", error: e.message });
  }
  try {
    const localSound = await playLocalSound();
    return res.json({ ok: true, pushover: true, email: true, localSound });
  } catch (e) {
    return res.status(502).json({ ok: false, channel: "localSound", error: e.message });
  }
});

app.post("/api/test-shop-alert", async (_req, res) => {
  if (!ALERT_TESTS_ENABLED) {
    return res.status(403).json({ ok: false, error: "Live alert tests are disabled" });
  }
  const readiness = getAlertReadiness();
  if (!readiness.alertReady) {
    return res.status(400).json({
      ok: false,
      error: "Missing required alert configuration",
      missing: readiness.missing,
      pushoverConfigured: readiness.pushoverConfigured,
      emailConfigured: readiness.emailConfigured,
    });
  }

  const base = SHOP_PRODUCTS[0] || {};
  const product = {
    id: "test-shop-alert",
    name: base.name || "Tesla Shop Accessory",
    url: base.url || "https://shop.tesla.com/en_au/",
    status: "in_stock",
    lastCheckedAt: Date.now(),
  };

  try {
    await sendShopPushoverAlert(product);
  } catch (e) {
    return res.status(502).json({ ok: false, channel: "pushover", error: e.message });
  }
  try {
    await sendShopEmailAlert(product);
  } catch (e) {
    return res.status(502).json({ ok: false, channel: "email", error: e.message });
  }
  try {
    const localSound = await playLocalSound();
    appendVehicleEvent("shopAlertTest", { id: product.id, location: "Tesla Shop" }, {
      productName: product.name,
      productUrl: product.url,
      status: product.status,
      pushover: true,
      email: true,
      localSound,
    });
    return res.json({ ok: true, pushover: true, email: true, localSound, product: product.name });
  } catch (e) {
    return res.status(502).json({ ok: false, channel: "localSound", error: e.message });
  }
});

// ── Static files (after API routes to avoid shadowing) ─────────────────────────
app.use(express.static(path.join(__dirname), {
  setHeaders(res, filePath) {
    if (/\.(html|css|jsx|js)$/.test(filePath)) {
      res.setHeader("Cache-Control", "no-store");
    }
  },
}));

// ── Startup ───────────────────────────────────────────────────────────────────
fs.mkdirSync(LOG_DIR, { recursive: true });
rotateLogs();
for (const logFile of [POLL_LOG_FILE, BLOCK_EVENT_LOG_FILE, VEHICLE_EVENT_LOG_FILE, SERVER_LOG_FILE]) {
  if (!fs.existsSync(logFile)) fs.closeSync(fs.openSync(logFile, "a"));
}
hydrateTeslaBlockDayFromLog();
retireOutOfScopeVehicles(state.vehicles || {}, Date.now());
persistWatcherMeta();
saveState(state);
loadScrapers();
refreshExternalNetworkIdentity("startup").catch(() => {});

if (!mainScraper && !stealthScraper) {
  console.error("[server] No scrapers available — server will serve stale data only");
}

app.listen(PORT, () => {
  const readiness = getAlertReadiness();
  const managedByLaunchd = !!process.env.XPC_SERVICE_NAME;
  console.log(`Tesla Stock Watch → http://localhost:${PORT}`);
  console.log(`Health       → http://localhost:${PORT}/api/health`);
  console.log(`[server] launchd=${managedByLaunchd ? process.env.XPC_SERVICE_NAME : "no"} pid=${process.pid}`);
  console.log(`[server] deployment=${DEPLOYMENT_MODE} realAlerts=${realAlertsEnabled()} display=${process.env.DISPLAY || "none"}`);
  console.log(`[server] localSound=${LOCAL_SOUND_AVAILABLE ? "available" : "unavailable"} matchAlertCooldownMs=${MATCH_ALERT_COOLDOWN_MS}`);
  console.log(`[server] dataDir=${DATA_DIR}`);
  console.log(`[server] state=${STATE_FILE}`);
  console.log(`[server] stateBackups=${STATE_BACKUP_DIR}`);
  console.log(`[server] serverLog=${SERVER_LOG_FILE}`);
  console.log(`[server] pollLog=${POLL_LOG_FILE}`);
  console.log(`[server] blockEventLog=${BLOCK_EVENT_LOG_FILE}`);
  console.log(`[server] vehicleEventLog=${VEHICLE_EVENT_LOG_FILE}`);
  console.log(`[server] target=${JSON.stringify(targetConfig)}`);
  console.log(`[server] monitoredStates=${MONITORED_STATES.length ? MONITORED_STATES.join(",") : "all"} monitoredMaxPages=${MONITORED_MAX_PAGES > 0 ? Math.floor(MONITORED_MAX_PAGES) : "none"}`);
  console.log(`[server] directInventory=${DIRECT_INVENTORY_ENABLED ? "enabled" : "disabled"}`);
  console.log(`[server] telegramInventory=${TELEGRAM_INVENTORY_ENABLED ? "enabled" : "disabled"} intervalMs=${TELEGRAM_POLL_INTERVAL_MS}`);
  console.log(`[server] alerts=${readiness.alertReady ? "ready" : `missing ${readiness.missing.join(", ")}`}`);
});

// First poll waits after deploy/recreate if persisted data is still fresh. This
// avoids adding Chrome/session churn to Tesla immediately after a restart.
const startupDelayMs = lastSuccessAt && Date.now() - lastSuccessAt < STARTUP_GRACE_RECENT_SUCCESS_MS
  ? Math.max(5000, STARTUP_GRACE_MS)
  : 5000;
startupGraceUntil = Date.now() + startupDelayMs;
if (DIRECT_INVENTORY_ENABLED) {
  scheduleNextPoll(startupDelayMs);
} else {
  _nextPollDueAt = 0;
  stale = false;
}
if (TELEGRAM_INVENTORY_ENABLED) {
  scheduleNextTelegramPoll(businessHoursActive() ? 5000 : null);
}

// First shop poll after 30s (let Chrome launch settle), then every 15m.
setTimeout(shopPollLoop, 30000);
_shopPollTimer = setInterval(shopPollLoop, SHOP_POLL_INTERVAL);

// ── Graceful shutdown ─────────────────────────────────────────────────────────
async function shutdown(signal) {
  console.log(`[server] ${signal} — shutting down…`);
  if (_pollTimer) clearTimeout(_pollTimer);
  if (_telegramTimer) clearTimeout(_telegramTimer);
  if (_shopPollTimer) clearInterval(_shopPollTimer);

  state.watcher.lastSource = lastSource;
  state.watcher.lastSuccessAt = lastSuccessAt;
  state.watcher.totalPolls = totalPolls;
  state.watcher.failedPolls = failedPolls;
  state.watcher.alertsSent = alertsSent;
  state.watcher.lastShopPollAt = lastShopPollAt;
  state.watcher.lastShopPollError = lastShopPollError;
  state.shopProducts = shopProducts;
  saveState(state);

  if (mainScraper) await mainScraper.destroyBrowser().catch(() => {});
  if (stealthScraper) await stealthScraper.destroyBrowser().catch(() => {});

  process.exit(0);
}

process.on("SIGTERM", () => shutdown("SIGTERM"));
process.on("SIGINT", () => shutdown("SIGINT"));
