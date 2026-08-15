// Tesla Stock Watch — Fallback scraper (plain puppeteer, no stealth plugin)
// Used when the primary scraper (stealth plugin) fails or is incompatible.
// Same headed-Chrome approach but without puppeteer-extra dependency.

const puppeteer = require("puppeteer-core");
const fs = require("fs");
const os = require("os");
const { scrapeInventoryFromDOM } = require("./scraper-dom");

function resolveChromePath() {
  const candidates = [
    { source: "env", path: process.env.CHROME_PATH },
    { source: "linux-stable", path: "/usr/bin/google-chrome-stable" },
    { source: "linux-chromium", path: "/usr/bin/chromium" },
    { source: "chrome-for-testing", path: "/Applications/Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing" },
    { source: "dedicated-copy", path: "/Applications/Tesla Stock Watch Chrome.app/Contents/MacOS/Google Chrome" },
    { source: "system", path: "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome" },
  ].filter((c) => c.path);

  return candidates.find((c) => fs.existsSync(c.path)) || candidates[candidates.length - 1];
}

const CHROME = resolveChromePath();

const TESLA_API = "https://www.tesla.com/inventory/api/v4/inventory-results";
const INVENTORY_PAGE = "https://www.tesla.com/en_AU/inventory/new/my";
const PAGE_SIZE = 24;
const BROWSER_MAX_AGE = Number(process.env.CHROME_MAX_AGE_MS || 24 * 3600 * 1000);
const CHROME_MAX_PROCESSES = Number(process.env.CHROME_MAX_PROCESSES || 35);
const CHROME_MAX_PAGES = Number(process.env.CHROME_MAX_PAGES || 6);
const CHROME_BACKGROUND_MODE = process.env.CHROME_BACKGROUND_MODE || "minimize";
const BROWSER_LANGUAGE = process.env.BROWSER_LANGUAGE || "en-AU,en;q=0.9";
const BROWSER_CHROME_LANG = process.env.BROWSER_CHROME_LANG || "en-AU";
const BROWSER_TIMEZONE = process.env.BROWSER_TIMEZONE || "Australia/Melbourne";
const BROWSER_VIEWPORT_WIDTH = Number(process.env.BROWSER_VIEWPORT_WIDTH || 900);
const BROWSER_VIEWPORT_HEIGHT = Number(process.env.BROWSER_VIEWPORT_HEIGHT || 700);
const BROWSER_INTERACTION_MODE = process.env.BROWSER_INTERACTION_MODE || "normal";
const BROWSER_REFERRER_CHAIN = process.env.BROWSER_REFERRER_CHAIN !== "false";
const DEFAULT_MAX_PAGES = Number(process.env.ACTIVE_MAX_PAGES || 4);
const PROXY_FAILOVER_ENABLED = process.env.PROXY_FAILOVER_ENABLED === "true";
const CHROME_PROXY_SERVER = process.env.CHROME_PROXY_SERVER || "";
const CHROME_PROXY_USERNAME = process.env.CHROME_PROXY_USERNAME || "";
const CHROME_PROXY_PASSWORD = process.env.CHROME_PROXY_PASSWORD || "";
const CHROME_USER_DATA_DIR = process.env.CHROME_USER_DATA_DIR ||
  (process.env.DEPLOYMENT_MODE === "docker" ? "/data/chrome-profile" : `${os.homedir()}/chrome-tesla-automation`);

let _browser = null;
let _browserAt = 0;
let _installing = false;
let _backgroundPage = null;
let _lastScrapeDurationMs = 0;
let _lastScrapeError = null;
let _lastBrowserPageCount = 0;
let _lastChromeProcessCount = 0;
let _secondaryPageIndex = 0;
let _referrerIndex = 0;

const SECONDARY_PAGES = [
  "https://www.tesla.com/en_au/modely/design",
  "https://www.tesla.com/en_au/modely",
  "https://www.tesla.com/en_au/inventory/new/my?arrangeby=plh",
  "https://www.tesla.com/en_au/model3/design",
];

const REFERRER_PAGES = [
  "https://www.google.com.au/",
  "https://www.tesla.com/en_au",
];

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

function browserConnected(browser) {
  if (!browser) return false;
  if (typeof browser.isConnected === "function") return browser.isConnected();
  return browser.connected !== false;
}

function countChromeProcesses() {
  try {
    return fs.readdirSync("/proc")
      .filter((name) => /^\d+$/.test(name))
      .filter((pid) => {
        try {
          const cmd = fs.readFileSync(`/proc/${pid}/cmdline`, "utf-8").replace(/\0/g, " ");
          return /chrome|chromium/i.test(cmd);
        } catch (_) {
          return false;
        }
      }).length;
  } catch (_) {
    return 0;
  }
}

function chromeProfilePids() {
  const needle = `--user-data-dir=${CHROME_USER_DATA_DIR}`;
  try {
    return fs.readdirSync("/proc")
      .filter((name) => /^\d+$/.test(name))
      .map((pid) => {
        try {
          const cmd = fs.readFileSync(`/proc/${pid}/cmdline`, "utf-8").replace(/\0/g, " ");
          return cmd.includes(needle) ? Number(pid) : null;
        } catch (_) {
          return null;
        }
      })
      .filter((pid) => pid && pid !== process.pid);
  } catch (_) {
    return [];
  }
}

async function waitForChromeProfileExit(timeoutMs) {
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    const pids = chromeProfilePids();
    if (!pids.length) return true;
    await sleep(250);
  }
  return chromeProfilePids().length === 0;
}

function removeProfileSingletonLocks() {
  for (const file of ["SingletonCookie", "SingletonLock", "SingletonSocket"]) {
    try { fs.rmSync(`${CHROME_USER_DATA_DIR}/${file}`, { force: true }); } catch (_) {}
  }
}

async function clearChromeProfileProcesses(reason) {
  let pids = chromeProfilePids();
  if (!pids.length) {
    removeProfileSingletonLocks();
    return;
  }

  console.warn(`[scraper:fallback] Clearing ${pids.length} Chrome process(es) for ${CHROME_USER_DATA_DIR}: ${reason}`);
  for (const pid of pids) {
    try { process.kill(pid, "SIGTERM"); } catch (_) {}
  }
  if (await waitForChromeProfileExit(5000)) {
    removeProfileSingletonLocks();
    return;
  }

  pids = chromeProfilePids();
  console.warn(`[scraper:fallback] Force killing ${pids.length} Chrome process(es) still holding ${CHROME_USER_DATA_DIR}`);
  for (const pid of pids) {
    try { process.kill(pid, "SIGKILL"); } catch (_) {}
  }
  await waitForChromeProfileExit(2000);
  removeProfileSingletonLocks();
}

function shouldRecycleBrowser() {
  _lastChromeProcessCount = countChromeProcesses();
  if (_lastChromeProcessCount > CHROME_MAX_PROCESSES) return `chrome process count ${_lastChromeProcessCount} > ${CHROME_MAX_PROCESSES}`;
  if (_lastBrowserPageCount > CHROME_MAX_PAGES) return `browser page count ${_lastBrowserPageCount} > ${CHROME_MAX_PAGES}`;
  return "";
}

function chromeWindowArgs() {
  if (CHROME_BACKGROUND_MODE === "visible") return [`--window-size=${BROWSER_VIEWPORT_WIDTH},${BROWSER_VIEWPORT_HEIGHT}`];
  return [
    "--start-minimized",
    "--window-position=-32000,-32000",
    `--window-size=${BROWSER_VIEWPORT_WIDTH},${BROWSER_VIEWPORT_HEIGHT}`,
  ];
}

function chromeProxyArgs() {
  if (!PROXY_FAILOVER_ENABLED || !CHROME_PROXY_SERVER) return [];
  return [`--proxy-server=${CHROME_PROXY_SERVER}`];
}

async function minimizeBrowserWindow(page) {
  if (CHROME_BACKGROUND_MODE === "visible") return;
  try {
    const client = await page.target().createCDPSession();
    const { windowId } = await client.send("Browser.getWindowForTarget");
    await client.send("Browser.setWindowBounds", {
      windowId,
      bounds: { left: -32000, top: -32000, width: 900, height: 700 },
    });
    await client.send("Browser.setWindowBounds", {
      windowId,
      bounds: { windowState: "minimized" },
    });
    await client.detach();
  } catch (e) {
    console.warn(`[scraper:fallback] Could not minimize Chrome window: ${e.message}`);
  }
}

async function ensureBackgroundPage(browser) {
  if (_backgroundPage && !_backgroundPage.isClosed()) {
    await minimizeBrowserWindow(_backgroundPage);
    return _backgroundPage;
  }

  const pages = await browser.pages().catch(() => []);
  _lastBrowserPageCount = pages.length || 0;
  _backgroundPage = pages.find((p) => !p.isClosed()) || await browser.newPage();
  await configurePageIdentity(_backgroundPage);
  await minimizeBrowserWindow(_backgroundPage);
  _lastBrowserPageCount = (await browser.pages().catch(() => [])).length || _lastBrowserPageCount;
  return _backgroundPage;
}

function buildQuery(offset) {
  return {
    query: {
      model: "my",
      condition: "new",
      options: {},
      arrangeby: "Price",
      order: "asc",
      market: "AU",
      language: "en",
      lng: 133.7751,
      lat: -25.2744,
      range: 0,
    },
    offset,
    count: PAGE_SIZE,
    outsideOffset: 0,
    outsideSearch: false,
    isFalconDeliverySelectionEnabled: true,
    version: null,
  };
}

async function ensureBrowser() {
  if (_browser && browserConnected(_browser) && Date.now() - _browserAt < BROWSER_MAX_AGE) {
    const recycleReason = shouldRecycleBrowser();
    if (!recycleReason) return _browser;
    console.warn(`[scraper:fallback] Recycling Chrome: ${recycleReason}`);
  }
  if (_browser) {
    try { await _browser.close(); } catch (_) {}
    _browser = null;
    _backgroundPage = null;
    _browserAt = 0;
    if (!(await waitForChromeProfileExit(5000))) {
      await clearChromeProfileProcesses("tracked browser did not exit before relaunch");
    }
  } else if (chromeProfilePids().length) {
    await clearChromeProfileProcesses("profile is already owned but Puppeteer has no browser handle");
  }
  if (_installing) {
    let waited = 0;
    while (_installing && waited < 30000) {
      await sleep(500);
      waited += 500;
    }
    if (_browser) return _browser;
  }
  _installing = true;
  try {
    console.log("[scraper:fallback] Launching headed Chrome (no stealth)…");
    _browser = await puppeteer.launch({
      executablePath: CHROME.path,
      headless: false,
      userDataDir: CHROME_USER_DATA_DIR,
      args: [
        "--no-sandbox",
        "--disable-setuid-sandbox",
        "--disable-blink-features=AutomationControlled",
        "--disable-infobars",
        "--disable-session-crashed-bubble",
        "--hide-crash-restore-bubble",
        "--no-first-run",
        "--no-default-browser-check",
        `--lang=${BROWSER_CHROME_LANG}`,
        ...chromeWindowArgs(),
        ...chromeProxyArgs(),
      ],
      ignoreDefaultArgs: ["--enable-automation"],
    });
    _browserAt = Date.now();
    console.log(`[scraper:fallback] Chrome launched (${CHROME.source}: ${CHROME.path})`);
    await ensureBackgroundPage(_browser);
  } finally {
    _installing = false;
  }
  return _browser;
}

async function configurePageIdentity(page) {
  await page.setViewport({
    width: BROWSER_VIEWPORT_WIDTH,
    height: BROWSER_VIEWPORT_HEIGHT,
    deviceScaleFactor: 1,
  }).catch(() => {});
  await page.setExtraHTTPHeaders({ "Accept-Language": BROWSER_LANGUAGE }).catch(() => {});
  await page.emulateTimezone(BROWSER_TIMEZONE).catch((e) => {
    console.warn(`[scraper:fallback] Could not set timezone ${BROWSER_TIMEZONE}: ${e.message}`);
  });
  if (PROXY_FAILOVER_ENABLED && CHROME_PROXY_USERNAME && CHROME_PROXY_PASSWORD) {
    await page.authenticate({
      username: CHROME_PROXY_USERNAME,
      password: CHROME_PROXY_PASSWORD,
    }).catch((e) => {
      console.warn(`[scraper:fallback] Could not set proxy credentials: ${e.message}`);
    });
  }
}

async function dismissOverlays(page) {
  try {
    const cookie = await page.$("#tsla-accept-cookie");
    if (cookie) {
      await cookie.click();
      await sleep(1000);
    }
  } catch (_) {}

  try {
    await page.evaluate(() => {
      const selectors = [
        '[data-testid="modal-close"]',
        ".tds-modal-close",
        'button[aria-label="Close"]',
        'button[aria-label="close"]',
      ];
      for (const selector of selectors) {
        const button = document.querySelector(selector);
        if (button) button.click();
      }

      const labels = ["Continue", "Confirm", "Stay on Australia", "Australia"];
      for (const button of document.querySelectorAll("button")) {
        const text = (button.textContent || "").trim();
        if (labels.some((label) => text.includes(label))) {
          button.click();
          break;
        }
      }
    });
  } catch (_) {}
}

function smallHash(text) {
  let hash = 2166136261;
  for (let i = 0; i < String(text || "").length; i++) {
    hash ^= String(text).charCodeAt(i);
    hash = Math.imul(hash, 16777619);
  }
  return (hash >>> 0).toString(16).padStart(8, "0");
}

function teslaMetaMessage(message, meta = {}) {
  return `${message} ${JSON.stringify({ teslaMeta: meta })}`;
}

async function warmupPage(page, retries = 2) {
  let blocked = false;
  let lastTitle = "";
  let lastUrl = "";
  for (let i = 0; i <= retries; i++) {
    try {
      if (BROWSER_REFERRER_CHAIN) {
        const ref = REFERRER_PAGES[_referrerIndex % REFERRER_PAGES.length];
        _referrerIndex++;
        await page.goto(ref, { waitUntil: "domcontentloaded", timeout: 15000 }).catch(() => {});
        await sleep(1000 + Math.random() * 2000);
      }
      await page.goto(INVENTORY_PAGE, {
        waitUntil: "domcontentloaded",
        timeout: 60000,
      });
      const title = await page.title();
      lastTitle = title;
      lastUrl = page.url();

      if (/access denied|blocked/i.test(title)) {
        blocked = true;
        console.warn(`[scraper:fallback] Blocked attempt ${i + 1}, waiting…`);
        await sleep(10000);
        continue;
      }

      await dismissOverlays(page);

      if (BROWSER_INTERACTION_MODE !== "extended") {
        await warmupInteraction(page);
      }
      return { ok: true, attempts: i + 1, blocked: false, pageTitle: title, pageUrl: page.url() };
    } catch (err) {
      console.warn(`[scraper:fallback] Warmup error (${i + 1}): ${err.message}`);
      if (i < retries) await sleep(5000);
    }
  }
  return { ok: false, attempts: retries + 1, blocked, pageTitle: lastTitle, pageUrl: lastUrl };
}

async function warmupInteraction(page) {
  const patterns = [
    async () => {
      await page.evaluate(() => window.scrollBy(0, 200 + Math.floor(Math.random() * 300))).catch(() => {});
      await sleep(2000 + Math.random() * 2000);
      await page.mouse.move(300 + Math.random() * 300, 200 + Math.random() * 200, { steps: 8 + Math.floor(Math.random() * 8) }).catch(() => {});
      await sleep(3000 + Math.random() * 3000);
      await page.mouse.move(400 + Math.random() * 200, 300 + Math.random() * 200, { steps: 5 + Math.floor(Math.random() * 5) }).catch(() => {});
    },
    async () => {
      await page.mouse.move(200 + Math.random() * 400, 150 + Math.random() * 300, { steps: 10 + Math.floor(Math.random() * 10) }).catch(() => {});
      await sleep(3000 + Math.random() * 2000);
      await page.mouse.move(350 + Math.random() * 250, 250 + Math.random() * 200, { steps: 6 + Math.floor(Math.random() * 6) }).catch(() => {});
      await sleep(4000 + Math.random() * 3000);
      await page.mouse.move(450 + Math.random() * 200, 350 + Math.random() * 150, { steps: 4 + Math.floor(Math.random() * 4) }).catch(() => {});
    },
    async () => {
      await page.evaluate(() => window.scrollBy(0, 150 + Math.floor(Math.random() * 250))).catch(() => {});
      await sleep(3000 + Math.random() * 2000);
      await page.evaluate(() => window.scrollBy(0, 300 + Math.floor(Math.random() * 400))).catch(() => {});
      await sleep(3000 + Math.random() * 2000);
    },
    async () => {
      await page.mouse.move(350 + Math.random() * 200, 400 + Math.random() * 150, { steps: 8 + Math.floor(Math.random() * 6) }).catch(() => {});
      await sleep(4000 + Math.random() * 3000);
      await page.evaluate(() => window.scrollBy(0, 250 + Math.floor(Math.random() * 200))).catch(() => {});
      await sleep(2000 + Math.random() * 1500);
      await page.mouse.move(450 + Math.random() * 150, 200 + Math.random() * 150, { steps: 5 + Math.floor(Math.random() * 5) }).catch(() => {});
    },
  ];
  await patterns[Math.floor(Math.random() * patterns.length)]();
}

async function visitSecondaryPage(page) {
  const url = SECONDARY_PAGES[_secondaryPageIndex % SECONDARY_PAGES.length];
  _secondaryPageIndex++;
  console.log(`[scraper:fallback] Visiting secondary page: ${url}`);
  await page.goto(url, { waitUntil: "domcontentloaded", timeout: 30000 }).catch(() => {});
  const interactions = [
    async () => page.evaluate(() => window.scrollBy(0, 200 + Math.floor(Math.random() * 300))).catch(() => {}),
    async () => page.mouse.move(400 + Math.random() * 200, 300 + Math.random() * 200, { steps: 5 + Math.floor(Math.random() * 5) }).catch(() => {}),
  ];
  const idx = Math.floor(Math.random() * interactions.length);
  await interactions[idx]();
  await sleep(8000 + Math.random() * 8000);
  await interactions[(idx + 1) % interactions.length]();
  await sleep(5000 + Math.random() * 5000);
  await page.goto(INVENTORY_PAGE, { waitUntil: "domcontentloaded", timeout: 30000 }).catch(() => {});
}

async function inspectSessionCookies(page) {
  const cookies = await page.cookies().catch(() => []);
  const akamaiCookies = cookies.filter((c) =>
    c.name.startsWith("ak_") || c.name.startsWith("bm_") || c.name === "_abck"
  );
  const teslaCookies = cookies.filter((c) => c.domain && c.domain.includes("tesla.com"));
  return {
    totalCookies: cookies.length,
    akamaiCookieCount: akamaiCookies.length,
    akamaiCookieNames: akamaiCookies.map((c) => c.name),
    teslaCookieCount: teslaCookies.length,
    sessionHealthy: akamaiCookies.length >= 2,
  };
}

function isTeslaBlockError(message) {
  return /HTTP 403|akamai|access denied|blocked/i.test(String(message || ""));
}

function domScrapeFallbackEnabled() {
  return process.env.DOM_SCRAPE_FALLBACK === "true" || process.env.DOM_SCRAPE_FALLBACK_ACTIVE === "true";
}

async function fetchPage(page, offset, phase, requestCount) {
  const query = buildQuery(offset);
  return page.evaluate(async (q, apiUrl, meta) => {
    const hashText = (text) => {
      let hash = 2166136261;
      for (let i = 0; i < String(text || "").length; i++) {
        hash ^= String(text).charCodeAt(i);
        hash = Math.imul(hash, 16777619);
      }
      return (hash >>> 0).toString(16).padStart(8, "0");
    };
    const url = `${apiUrl}?query=${encodeURIComponent(JSON.stringify(q))}`;
    const resp = await fetch(url, {
      credentials: "include",
      headers: { Accept: "application/json" },
    });
    if (!resp.ok) {
      const body = await resp.text().catch(() => "");
      throw new Error(`HTTP ${resp.status} ${JSON.stringify({
        teslaMeta: {
          ...meta,
          status: resp.status,
          urlKind: "inventory_api",
          contentType: resp.headers.get("content-type") || "",
          bodyLength: body.length,
          bodyHash: hashText(body),
          pageTitle: document.title || "",
          pageUrl: location.href || "",
        },
      })}`);
    }
    return resp.json();
  }, query, TESLA_API, { phase, offset, requestCount });
}

async function scrapeInventory(maxPages = DEFAULT_MAX_PAGES) {
  const started = Date.now();
  let page = null;
  const safeMaxPages = Math.max(1, Math.floor(Number(maxPages) || DEFAULT_MAX_PAGES || 1));

  try {
    const browser = await ensureBrowser();
    page = await ensureBackgroundPage(browser);
    await minimizeBrowserWindow(page);
    await configurePageIdentity(page);

    const warmed = await warmupPage(page);
    let requestCount = warmed.attempts || 1;
    if (!warmed.ok) {
      throw new Error(teslaMetaMessage("Fallback: page blocked by Akamai after retries", {
        phase: "warmup_page",
        requestCount,
        pageTitle: warmed.pageTitle || "",
        pageUrl: warmed.pageUrl || "",
        bodyHash: smallHash(warmed.pageTitle || warmed.pageUrl || "warmup_block"),
      }));
    }

    const cookieState = await inspectSessionCookies(page);
    if (!cookieState.sessionHealthy) {
      console.warn(`[scraper:fallback] Suspicious cookie state after warmup: ${cookieState.totalCookies} total, ${cookieState.akamaiCookieCount} Akamai cookies`);
    }

    if (BROWSER_INTERACTION_MODE === "extended") {
      await visitSecondaryPage(page);
      await dismissOverlays(page);
    }

    let total = null;
    const allResults = [];
    let pagesFetched = 0;
    let partial = false;
    let partialReason = null;

    requestCount += 1;
    let firstJson = null;
    try {
      firstJson = await fetchPage(page, 0, "api_page_1", requestCount);
    } catch (e) {
      if (isTeslaBlockError(e.message) && domScrapeFallbackEnabled()) {
        console.warn("[scraper:fallback] API blocked, attempting DOM scrape");
        const domData = await scrapeInventoryFromDOM(page, safeMaxPages);
        _lastScrapeError = null;
        return {
          ...domData,
          requestCount,
          scrapeDurationMs: Date.now() - started,
          cookieState,
        };
      }
      e.cookieState = cookieState;
      throw e;
    }
    pagesFetched = 1;
    total = firstJson.total_matches_found ?? 0;
    console.log(`[scraper:fallback] ${total} total vehicles in AU inventory`);

    const firstResults = firstJson.results ?? [];
    if (Array.isArray(firstResults) && firstResults.length) {
      allResults.push(...firstResults);
      console.log(`[scraper:fallback] Page 1: +${firstResults.length} (${allResults.length}/${total})`);
    }

    let offset = PAGE_SIZE;
    while (allResults.length < total && pagesFetched < safeMaxPages) {
      await sleep(1500 + Math.random() * 1500);
      let json = null;
      try {
        requestCount += 1;
        json = await fetchPage(page, offset, "api_page_n", requestCount);
      } catch (e) {
        if (/HTTP 403|akamai|access denied|blocked/i.test(String(e.message || ""))) {
          partial = true;
          partialReason = e.message;
          console.warn(`[scraper:fallback] Mid-pagination block after ${pagesFetched} page(s); returning partial data`);
          break;
        }
        throw e;
      }
      pagesFetched++;
      const results = json.results ?? [];
      if (!Array.isArray(results) || results.length === 0) break;

      allResults.push(...results);
      console.log(
        `[scraper:fallback] Page ${Math.floor(offset / PAGE_SIZE) + 1}: +${results.length} (${allResults.length}/${total})`
      );
      offset += PAGE_SIZE;
    }

    const capped = !partial && allResults.length < total && pagesFetched >= safeMaxPages;
    if (capped) {
      console.warn(`[scraper:fallback] Pagination capped at ${safeMaxPages} page(s): ${allResults.length}/${total}`);
    }

    _lastScrapeError = null;
    return {
      results: allResults,
      total_matches_found: total ?? allResults.length,
      pagesFetched,
      maxPages: safeMaxPages,
      requestCount,
      scrapeDurationMs: Date.now() - started,
      capped,
      partial,
      partialReason,
      cookieState,
    };
  } catch (e) {
    _lastScrapeError = e.message;
    throw e;
  } finally {
    _lastScrapeDurationMs = Date.now() - started;
    if (page && !page.isClosed()) {
      await page.goto("about:blank", { waitUntil: "domcontentloaded", timeout: 10000 }).catch(() => {});
      await minimizeBrowserWindow(page);
    }
    if (_browser && browserConnected(_browser)) {
      _lastBrowserPageCount = (await _browser.pages().catch(() => [])).length || 0;
    }
    _lastChromeProcessCount = countChromeProcesses();
  }
}

async function destroyBrowser() {
  if (_browser) {
    try { await _browser.close(); } catch (_) {}
    _browser = null;
    _backgroundPage = null;
    _browserAt = 0;
    if (!(await waitForChromeProfileExit(5000))) {
      await clearChromeProfileProcesses("destroyBrowser cleanup");
    } else {
      removeProfileSingletonLocks();
    }
    console.log("[scraper:fallback] Browser closed");
  } else if (chromeProfilePids().length) {
    await clearChromeProfileProcesses("destroyBrowser found orphaned profile owner");
  }
}

async function withScraperPage(fn) {
  const browser = await ensureBrowser();
  const page = await browser.newPage();
  try {
    await configurePageIdentity(page);
    await minimizeBrowserWindow(page);
    return await fn(page);
  } finally {
    if (page && !page.isClosed()) {
      await page.goto("about:blank", { waitUntil: "domcontentloaded", timeout: 10000 }).catch(() => {});
      await page.close().catch(() => {});
    }
    if (_browser && browserConnected(_browser)) {
      _lastBrowserPageCount = (await _browser.pages().catch(() => [])).length || 0;
    }
    _lastChromeProcessCount = countChromeProcesses();
    if (_backgroundPage && !_backgroundPage.isClosed()) await minimizeBrowserWindow(_backgroundPage);
  }
}

function getStatus() {
  return {
    chromeBackgroundMode: CHROME_BACKGROUND_MODE,
    chromePath: CHROME.path,
    chromePathSource: CHROME.source,
    chromeUserDataDir: CHROME_USER_DATA_DIR,
    browserLanguage: BROWSER_LANGUAGE,
    browserChromeLang: BROWSER_CHROME_LANG,
    browserTimezone: BROWSER_TIMEZONE,
    browserViewport: {
      width: BROWSER_VIEWPORT_WIDTH,
      height: BROWSER_VIEWPORT_HEIGHT,
      deviceScaleFactor: 1,
    },
    proxyFailoverEnabled: PROXY_FAILOVER_ENABLED,
    proxyConfigured: !!CHROME_PROXY_SERVER,
    browserInteractionMode: BROWSER_INTERACTION_MODE,
    browserReferrerChain: BROWSER_REFERRER_CHAIN,
    browserConnected: browserConnected(_browser),
    browserAgeMs: _browserAt ? Date.now() - _browserAt : null,
    browserPageCount: _lastBrowserPageCount,
    chromeProcessCount: _lastChromeProcessCount || countChromeProcesses(),
    lastScrapeDurationMs: _lastScrapeDurationMs,
    lastScrapeError: _lastScrapeError,
  };
}

module.exports = { scrapeInventory, destroyBrowser, getStatus, withScraperPage, inspectSessionCookies };
