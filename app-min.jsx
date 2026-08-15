/* Tesla Stock Watch — target-first watchlist UI. Server handles polling, diffing, alerting. */
const { useState, useEffect, useRef, useCallback } = React;
const Y = window.YL;
const TESLA_URL = "https://www.tesla.com/en_AU/inventory/new/my";
const POLL_MS = 60_000;
const NEW_WINDOW = 3 * 24 * 3600 * 1000;
const SHOP_PRODUCT_COUNT = 5;
const BROWSER_ALERTS_KEY = "yl-browser-alerts-on";
const DISMISSED_ALERTS_KEY = "yl-dismissed-availability-alerts-v1";

const iconProps = { viewBox: "0 0 24 24", fill: "none", stroke: "currentColor", strokeWidth: "2", strokeLinecap: "round", strokeLinejoin: "round" };
const IcoRefresh = <svg {...iconProps} strokeWidth="2.2"><path d="M21 12a9 9 0 1 1-2.64-6.36M21 4v5h-5"/></svg>;
const IcoAlert = <svg {...iconProps}><path d="M18 8a6 6 0 0 0-12 0c0 7-3 9-3 9h18s-3-2-3-9"/><path d="M13.7 21a2 2 0 0 1-3.4 0"/></svg>;
const IcoAlertOff = <svg {...iconProps}><path d="M13.7 21a2 2 0 0 1-3.4 0"/><path d="M18 8a6 6 0 0 0-9.3-5"/><path d="M3 3l18 18"/><path d="M6 8c0 7-3 9-3 9h12"/></svg>;
const IcoSun = <svg {...iconProps}><circle cx="12" cy="12" r="4"/><path d="M12 2v2M12 20v2M4.93 4.93l1.41 1.41M17.66 17.66l1.41 1.41M2 12h2M20 12h2M4.93 19.07l1.41-1.41M17.66 6.34l1.41-1.41"/></svg>;
const IcoMoon = <svg {...iconProps}><path d="M12 3a6.9 6.9 0 0 0 8.7 8.7A8.2 8.2 0 1 1 12 3Z"/></svg>;
const IcoCheck = <svg {...iconProps}><path d="M20 6 9 17l-5-5"/></svg>;
const IcoMap = {
  pin: <svg {...iconProps}><path d="M20 10c0 5-8 12-8 12S4 15 4 10a8 8 0 1 1 16 0Z"/><circle cx="12" cy="10" r="3"/></svg>,
  paint: <svg {...iconProps}><path d="m19 11-8-8-8.6 8.6a2 2 0 0 0 0 2.8l4.2 4.2a2 2 0 0 0 2.8 0L19 9"/><path d="m5 16 3 3"/><path d="M19 11c1.5 1.5 1.5 4 0 5.5s-4 1.5-5.5 0"/></svg>,
  cabin: <svg {...iconProps}><path d="M7 11V8a5 5 0 0 1 10 0v3"/><path d="M5 11h14l-1.5 8h-11L5 11Z"/><path d="M8 15h8"/></svg>,
  wheel: <svg {...iconProps}><circle cx="12" cy="12" r="8"/><circle cx="12" cy="12" r="2"/><path d="M12 4v6M12 14v6M4 12h6M14 12h6"/></svg>,
  seats: <svg {...iconProps}><path d="M6 20v-6a3 3 0 0 1 3-3h6a3 3 0 0 1 3 3v6"/><path d="M8 7a4 4 0 0 1 8 0v4H8V7Z"/></svg>,
  model: <svg {...iconProps}><path d="M3 13h18l-2-5a3 3 0 0 0-3-2H8a3 3 0 0 0-3 2l-2 5Z"/><path d="M5 13v5M19 13v5"/><circle cx="7" cy="18" r="1"/><circle cx="17" cy="18" r="1"/></svg>,
  transit: <svg {...iconProps}><path d="M3 7h11v10H3z"/><path d="M14 11h4l3 3v3h-7z"/><circle cx="7" cy="18" r="2"/><circle cx="18" cy="18" r="2"/></svg>,
  clock: <svg {...iconProps}><circle cx="12" cy="12" r="9"/><path d="M12 7v5l3 2"/></svg>,
  price: <svg {...iconProps}><path d="M12 2v20"/><path d="M17 5H9.5a3.5 3.5 0 0 0 0 7H14a3.5 3.5 0 0 1 0 7H6"/></svg>,
};

function Icon({ name }) {
  return <span className="ico">{IcoMap[name]}</span>;
}

const isNewWindow = (v, now) => !v.removed && ((v.fresh && !v.baseline) || v.uiPreview);
const getTrimKeywords = (target) => Array.isArray(target?.trimKeywords) ? target.trimKeywords : [];
const trimTokens = (value) => String(value || "").toLowerCase().split(/[^a-z0-9]+/).filter(Boolean);
const trimKeywordMatches = (trim, keyword) => {
  const trimSet = new Set(trimTokens(trim));
  const keywordTokens = trimTokens(keyword);
  return keywordTokens.length > 0 && keywordTokens.every((token) => trimSet.has(token));
};
const joinTarget = (values, fallback) => values?.length ? values.join(" / ") : fallback;
const targetExteriorText = (target) => joinTarget(target?.exterior, "Any exterior");
const targetInteriorText = (target) => joinTarget(target?.interior, "Any interior");
const shortTime = (ts) => ts ? new Date(ts).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", second: "2-digit" }) : "—";
const vehicleKey = (v, scope, index) => {
  const base = v.id || v.hash || v.vinDisplay || `${v.state || "state"}-${v.location || "location"}-${v.price || "price"}`;
  return `${scope}-${index}-${base}`;
};

function isYlVehicle(v, target) {
  const trimKeywords = getTrimKeywords(target);
  const trim = String(v.trimName || "").toLowerCase();
  const requiredCabin = target?.cabinConfig || "SIX";
  const cabinMatch = requiredCabin ? String(v.cabinConfig || "").includes(requiredCabin) : true;
  const ylNameMatch = trim.includes("model y l");
  const keywordMatch = trimKeywords.length && trimKeywords.some((k) => trimKeywordMatches(trim, k));
  return cabinMatch && (ylNameMatch || keywordMatch);
}

function isExactTarget(v, target) {
  return matchesTargetConfig(v, target);
}

function vehicleTier(v, target) {
  if (isExactTarget(v, target)) return "exact";
  if (isYlVehicle(v, target)) return "candidate";
  return "standard";
}

function matchesTargetConfig(v, target) {
  if (!target) return false;
  if (target.exterior?.length && !target.exterior.includes(v.exterior)) return false;
  if (target.interior?.length && !target.interior.includes(v.interior)) return false;
  if (target.cabinConfig && !String(v.cabinConfig || "").includes(target.cabinConfig)) return false;
  const trimKeywords = getTrimKeywords(target);
  if (trimKeywords.length && !trimKeywords.some((k) => trimKeywordMatches(v.trimName, k))) return false;
  if (target.state && target.state !== "all" && v.state !== target.state) return false;
  if (target.excludeDemo && v.isDemo) return false;
  return true;
}

function sourceLabel(src) {
  if (src === "main") return "via Chrome";
  if (src === "main_restarted") return "via Chrome (restarted)";
  if (src === "main_recovery_probe") return "via Chrome (recovery)";
  if (src === "stealth_recovery_probe") return "via Chrome backup (recovery)";
  if (src === "stealth") return "via Chrome (backup)";
  if (src === "main_dom_fallback") return "DOM fallback";
  if (src === "stale") return "stale";
  return src || "";
}

function shopStatusLabel(status) {
  if (status === "in_stock") return "IN STOCK";
  if (status === "blocked") return "blocked";
  if (status === "unknown") return "unknown";
  return "Out of stock";
}

function fmtBytes(n) {
  if (!n) return "0 B";
  if (n < 1024) return n + " B";
  if (n < 1024 * 1024) return Math.round(n / 1024) + " KB";
  return (n / 1024 / 1024).toFixed(1) + " MB";
}

function fmtRemaining(ms) {
  if (!ms || ms <= 0) return "0m";
  const mins = Math.ceil(ms / 60000);
  if (mins < 60) return mins + "m";
  const hours = Math.floor(mins / 60);
  const rem = mins % 60;
  return rem ? `${hours}h ${rem}m` : `${hours}h`;
}

let _actx = null;
function chime() {
  try {
    _actx = _actx || new (window.AudioContext || window.webkitAudioContext)();
    if (_actx.state === "suspended") _actx.resume();
    [880, 1320].forEach((freq, i) => {
      const o = _actx.createOscillator(), g = _actx.createGain();
      o.type = "sine"; o.frequency.value = freq;
      const t0 = _actx.currentTime + i * 0.16;
      g.gain.setValueAtTime(0.0001, t0);
      g.gain.exponentialRampToValueAtTime(0.18, t0 + 0.02);
      g.gain.exponentialRampToValueAtTime(0.0001, t0 + 0.32);
      o.connect(g); g.connect(_actx.destination);
      o.start(t0); o.stop(t0 + 0.34);
    });
  } catch (e) {}
}

function StatusBadge({ children, tone = "" }) {
  return <span className={"badge " + tone}>{children}</span>;
}

function sourceTone(source) {
  if (!source?.enabled) return "off";
  if (source.status === "ok") return "ok";
  if (source.status === "cooldown" || source.status === "degraded" || source.status === "stale") return "warn";
  return "fail";
}

function SourceDot({ tone }) {
  return <span className={"source-dot " + tone}></span>;
}

function preferredValue(values, preferred, fallback) {
  if (values?.includes(preferred)) return preferred;
  return values?.[0] || fallback;
}

function previewVehicle(mode, target, now) {
  if (mode !== "exact" && mode !== "candidate") return null;
  const exact = mode === "exact";
  const exterior = exact ? preferredValue(target?.exterior, "Diamond Black", "Diamond Black") : "Glacier Blue";
  const interior = exact ? preferredValue(target?.interior, "White", "White") : preferredValue(target?.interior, "White", "White");
  return {
    id: "ui-preview-" + mode,
    vinDisplay: "LRWY999_preview_" + mode,
    trimName: "Model Y L Premium All-Wheel Drive",
    exterior,
    interior,
    cabinConfig: target?.cabinConfig || "SIX",
    wheels: "20'' Helix 2.0 Wheels",
    price: exact ? 84800 : 83600,
    state: "VIC",
    location: exact ? "Richmond" : "Mulgrave",
    vrlName: exact ? "Tesla Richmond" : "Tesla Mulgrave",
    firstSeen: now - 45_000,
    appeared: now - 45_000,
    inTransit: exact,
    isDemo: false,
    removed: false,
    uiPreview: mode,
  };
}

function withPreviewVehicles(vehicles, target, previewMode, now) {
  const preview = previewVehicle(previewMode, target, now);
  return preview ? [preview].concat(vehicles) : vehicles;
}

function withPreviewShopProducts(products, previewMode, now) {
  if (previewMode !== "accessory") return products;
  const base = products?.[0] || {
    id: "ui-preview-accessory",
    name: "Trunk Storage Bins",
    url: "https://shop.tesla.com/en_au/product/model-yl-trunk-storage-bins",
  };
  const preview = {
    ...base,
    status: "in_stock",
    lastInStockAt: now,
    lastCheckedAt: now,
    alertsSent: base.alertsSent || 0,
    fresh: true,
    uiPreview: true,
  };
  return [preview].concat((products || []).filter((p) => p.id !== preview.id));
}

function Spec({ icon, label, children, swatch }) {
  return (
    <span className="spec">
      {swatch ? <span className="sw" style={{ background: swatch }}></span> : <Icon name={icon} />}
      <span className="spec-text"><b>{label}</b>{children}</span>
    </span>
  );
}

function candidateGapText(v, target) {
  const gaps = [];
  if (target?.cabinConfig && !String(v.cabinConfig || "").includes(target.cabinConfig)) {
    const want = target.cabinConfig === "SIX" ? "6-seat" : target.cabinConfig;
    const have = v.cabinConfig === "FIVE" ? "5-seat" : (v.cabinConfig || "unknown cabin");
    gaps.push(`${have}, not ${want}`);
  }
  if (target?.exterior?.length && !target.exterior.includes(v.exterior)) gaps.push("outside target paint");
  if (target?.interior?.length && !target.interior.includes(v.interior)) gaps.push("outside target interior");
  if (target?.excludeDemo && v.isDemo) gaps.push("demo vehicle");
  return gaps.length ? "Close only: " + gaps.join(" · ") : "Close trim match";
}

function Listing({ v, now, tier, target }) {
  const nu = isNewWindow(v, now);
  const cls = ["listing", "tier-" + tier];
  if (v.removed) cls.push("is-removed");
  if (v.fresh) cls.push("enter");

  const vinText = v.vinDisplay ? Y.maskVin(v.vinDisplay) : "—";
  const shownFirstSeen = v.firstSeen || v.appeared;
  const title = tier === "exact" ? "Exact Model Y L match" : tier === "candidate" ? "6-seat Model Y L candidate" : "Standard Model Y";
  const cta = tier === "exact" ? "Open Tesla now" : "Open Tesla";
  const seenText = v.removed
    ? "removed " + Y.timeAgo(v.removed, now) + " ago"
    : nu ? (shownFirstSeen ? "listed " + Y.timeAgo(shownFirstSeen, now) + " ago" : "listed recently")
      : shownFirstSeen ? "tracked " + Y.timeAgo(shownFirstSeen, now) + " ago" : "tracked";

  return (
    <a className={cls.join(" ")} href={TESLA_URL} target="_blank" rel="noopener">
      <span className="l-main">
        <span className="l-kicker">
          <span className="tier-label">{title}</span>
          <span className="status-row">
            {v.uiPreview && <StatusBadge tone="preview">PREVIEW</StatusBadge>}
            {v.domSource && <StatusBadge tone="preview">DOM</StatusBadge>}
            {nu && !v.removed && <StatusBadge tone="new">NEW</StatusBadge>}
            {v.inTransit && !v.removed && <StatusBadge tone="transit">IN TRANSIT</StatusBadge>}
            {v.isDemo && !v.removed && <StatusBadge tone="demo">DEMO</StatusBadge>}
            {v.removed && <StatusBadge>REMOVED</StatusBadge>}
          </span>
        </span>
        <span className="l-model"><Icon name="model" />{v.trimName || "Model Y"}</span>
        {tier === "candidate" && <span className="candidate-gap">{candidateGapText(v, target)}</span>}
        <span className="l-location"><Icon name="pin" /><b>{v.state}</b><span>{v.location}{v.vrlName && v.vrlName !== v.location ? " / " + v.vrlName : ""}</span></span>
      </span>

      <span className="l-specs">
        <Spec label="Paint" swatch={Y.EXTERIOR[v.exterior] || "#555"}>{v.exterior}</Spec>
        <Spec icon="cabin" label="Interior">{v.interior}</Spec>
        <Spec icon="seats" label="Cabin">{v.cabinConfig === "SIX" ? "6-seat" : v.cabinConfig === "FIVE" ? "5-seat" : v.cabinConfig}</Spec>
        <Spec icon="wheel" label="Wheels">{v.wheels}</Spec>
        {tier !== "standard" && <span className="vin">{vinText}</span>}
      </span>

      <span className="l-price">
        <span className="p"><Icon name="price" />{Y.fmtPrice(v.price)}</span>
        <span className="seen"><Icon name="clock" />{seenText}</span>
      </span>

      <span className="l-go">{cta}<svg {...iconProps}><path d="M5 12h14M13 6l6 6-6 6"/></svg></span>
    </a>
  );
}

function MatchAlarm({ match, count, targetExterior, targetInterior }) {
  if (!match) return null;
  return (
    <a className="match-alarm" href={TESLA_URL} target="_blank" rel="noopener">
      <span className="alarm-mark">{IcoCheck}</span>
      <span className="alarm-copy">
        <span className="alarm-kicker">Target match</span>
        <b>{count === 1 ? "Model Y L is available" : count + " Model Y L matches available"}</b>
        <span>{targetExterior} / {targetInterior} · {match.state} {match.location} · {Y.fmtPrice(match.price)}</span>
      </span>
      <span className="alarm-cta">Open Tesla now</span>
    </a>
  );
}

function SourceHealthCards({ sources, now }) {
  const tesla = sources?.teslaDirect;
  const telegram = sources?.telegram;
  if (!tesla && !telegram) return null;
  const telegramListings = telegram?.recentListings || [];
  return (
    <section className="source-panel">
      <div className="section-head"><span>Source health</span><b>{[tesla, telegram].filter(Boolean).length}</b></div>
      <div className="source-grid">
        {tesla && (
          <div className={"source-card " + sourceTone(tesla)}>
            <span className="source-card-head"><SourceDot tone={sourceTone(tesla)} /><b>Tesla Direct</b><em>{tesla.status || "unknown"}</em></span>
            <span className="source-card-main">{tesla.enabled ? (tesla.lastSuccess ? "success " + Y.timeAgo(tesla.lastSuccess, now) + " ago" : "no successful poll yet") : "vehicle inventory paused"}</span>
            <span className="source-card-meta">{tesla.enabled ? (tesla.cooldownActive ? "cooldown active" : tesla.browserConnected ? "browser connected" : "browser starting") : "accessory-first mode"} · {tesla.cookieState ? `${tesla.cookieState.akamaiCookieCount} Akamai cookies` : "cookies pending"}</span>
          </div>
        )}
        {telegram && (
          <div className={"source-card " + sourceTone(telegram)}>
            <span className="source-card-head"><SourceDot tone={sourceTone(telegram)} /><b>Telegram</b><em>{telegram.status || "unknown"}</em></span>
            <span className="source-card-main">{telegram.enabled ? (telegram.lastMessageAt ? "MY message " + Y.timeAgo(telegram.lastMessageAt, now) + " ago" : "waiting for MY messages") : "disabled"}</span>
            <span className="source-card-meta">{telegram.myMessageCount || 0} MY messages · {telegram.lastFetchAt ? "fetched " + Y.timeAgo(telegram.lastFetchAt, now) + " ago" : "not fetched yet"}</span>
            {telegramListings.length > 0 && (
              <div className="telegram-list">
                {telegramListings.slice(0, 5).map((m) => (
                  <a key={m.id || m.link} href={m.link} target="_blank" rel="noopener">
                    <b>{m.trim || "MY"} {m.paint || ""}</b>
                    <span>{m.interior || "unknown interior"} · {m.location} · {Y.fmtPrice(m.price)}</span>
                  </a>
                ))}
              </div>
            )}
          </div>
        )}
      </div>
    </section>
  );
}

const THEME_TIMEZONE = "Australia/Melbourne";
const NIGHT_START_BY_MONTH = [20, 20, 19, 18, 17, 17, 17, 18, 18, 19, 20, 20];
const NIGHT_END_HOUR = 7;
const TWEAK_DEFAULTS = {"density":"cozy","autoCheck":true,"showRemoved":false,"theme":"auto"};

function themeTimeParts(ts) {
  const parts = new Intl.DateTimeFormat("en-AU", {
    timeZone: THEME_TIMEZONE,
    month: "numeric",
    hour: "numeric",
    hour12: false,
  }).formatToParts(new Date(ts));
  return {
    hour: Number(parts.find((p) => p.type === "hour")?.value || 0),
    month: Number(parts.find((p) => p.type === "month")?.value || 1),
  };
}

function scheduledTheme(ts) {
  const { hour, month } = themeTimeParts(ts);
  const nightStart = NIGHT_START_BY_MONTH[month - 1] || 18;
  return hour >= nightStart || hour < NIGHT_END_HOUR ? "night" : "day";
}

function resolveTheme(mode, ts) {
  if (mode === "day" || mode === "night") return mode;
  return scheduledTheme(ts);
}

function storedTheme() {
  try {
    const mode = window.localStorage.getItem("yl-theme-mode");
    return mode === "auto" || mode === "day" || mode === "night" ? mode : TWEAK_DEFAULTS.theme;
  } catch (e) {
    return TWEAK_DEFAULTS.theme;
  }
}

function storedBrowserAlerts() {
  try {
    return window.localStorage.getItem(BROWSER_ALERTS_KEY) === "1";
  } catch (e) {
    return false;
  }
}

function readStoredKeySet(key) {
  try {
    const values = JSON.parse(window.localStorage.getItem(key) || "[]");
    return new Set(Array.isArray(values) ? values : []);
  } catch (e) {
    return new Set();
  }
}

function writeStoredKeySet(key, values) {
  try {
    window.localStorage.setItem(key, JSON.stringify(Array.from(values).slice(-80)));
  } catch (e) {}
}

function carAlertKey(v) {
  return `car:${v.id}:${v.firstSeen || v.appeared || v.lastSeen || "new"}`;
}

function shopAlertKey(p) {
  return `shop:${p.id}:${p.lastInStockAt || p.lastCheckedAt || "in-stock"}`;
}

function carAvailabilityAlert(v) {
  return {
    key: carAlertKey(v),
    kind: "car",
    title: "Model Y L available",
    eyebrow: "Target match",
    detail: `${v.exterior} / ${v.interior} / ${v.state} ${v.location} / ${Y.fmtPrice(v.price)}`,
    meta: v.wheels || "New inventory",
    url: TESLA_URL,
    cta: "Open Tesla",
    notificationTitle: "Tesla Y L available",
    notificationBody: `${v.exterior} / ${v.interior} / ${v.location} / ${Y.fmtPrice(v.price)}`,
  };
}

function shopAvailabilityAlert(p, now) {
  const checked = p.lastCheckedAt || p.lastInStockAt || now;
  return {
    key: shopAlertKey(p),
    kind: "shop",
    title: "Accessory available",
    eyebrow: "Tesla Shop",
    detail: p.name || "Watched accessory is in stock",
    meta: checked ? "checked " + Y.timeAgo(checked, now) + " ago" : "in stock now",
    url: p.url || "https://shop.tesla.com/en_au/",
    cta: "Open Shop",
    notificationTitle: "Tesla accessory available",
    notificationBody: p.name || "Watched accessory is in stock",
  };
}

function App() {
  const [t, setTweak] = useTweaks({ ...TWEAK_DEFAULTS, theme: storedTheme() });
  const [now, setNow] = useState(Date.now());
  const [vehicles, setVehicles] = useState([]);
  const [lastChecked, setLastChecked] = useState(null);
  const [lastSuccess, setLastSuccess] = useState(null);
  const [lastSource, setLastSource] = useState("");
  const [stale, setStale] = useState(false);
  const [targetConfig, setTargetConfig] = useState(null);
  const [health, setHealth] = useState(null);
  const [sources, setSources] = useState(null);
  const [snoozeState, setSnoozeState] = useState(null);
  const [recentPolls, setRecentPolls] = useState([]);
  const [recentBlocks, setRecentBlocks] = useState([]);
  const [shopProducts, setShopProducts] = useState([]);
  const [shopLastChecked, setShopLastChecked] = useState(null);
  const [shopStale, setShopStale] = useState(false);
  const [busy, setBusy] = useState(false);
  const [loadError, setLoadError] = useState(null);
  const [newSince, setNewSince] = useState(0);
  const [previewMode] = useState(() => {
    const mode = new URLSearchParams(window.location.search).get("preview");
    return mode === "exact" || mode === "candidate" || mode === "accessory" ? mode : "";
  });

  const [viewMode, setViewMode] = useState("all");
  const [fInterior, setFInterior] = useState("all");
  const [fPaint, setFPaint] = useState(() => new Set());
  const [fState, setFState] = useState("all");
  const [fNew, setFNew] = useState(false);
  const [fDemo, setFDemo] = useState(false);

  const [alertsOn, setAlertsOn] = useState(storedBrowserAlerts);
  const [availabilityToast, setAvailabilityToast] = useState(null);
  const alertsRef = useRef(false); alertsRef.current = alertsOn;
  const availabilityToastRef = useRef(null);
  const announcedAlertKeysRef = useRef(new Set());
  const dismissedAlertKeysRef = useRef(readStoredKeySet(DISMISSED_ALERTS_KEY));
  const originalTitleRef = useRef(typeof document !== "undefined" ? document.title : "Tesla Stock Watch");

  useEffect(() => {
    availabilityToastRef.current = availabilityToast;
  }, [availabilityToast]);

  useEffect(() => {
    try {
      window.localStorage.setItem(BROWSER_ALERTS_KEY, alertsOn ? "1" : "0");
    } catch (e) {}
  }, [alertsOn]);

  useEffect(() => {
    if (!availabilityToast) {
      document.title = originalTitleRef.current;
      return;
    }
    const alertTitle = availabilityToast.kind === "car" ? "Model Y L available" : "Accessory available";
    let bright = true;
    document.title = `* ${alertTitle}`;
    const id = setInterval(() => {
      bright = !bright;
      document.title = bright ? `* ${alertTitle}` : originalTitleRef.current;
    }, 1400);
    return () => {
      clearInterval(id);
      document.title = originalTitleRef.current;
    };
  }, [availabilityToast]);

  const runCheck = useCallback(async () => {
    setBusy(true);
    setLoadError(null);
    try {
      const res = await fetch("/api/inventory");
      if (!res.ok) {
        const err = await res.json().catch(() => ({ error: res.statusText }));
        throw new Error(err.error || "HTTP " + res.status);
      }
      const data = await res.json();
      const targetRes = await fetch("/api/target");
      const target = targetRes.ok ? await targetRes.json() : null;
      const healthRes = await fetch("/api/health").catch(() => null);
      const healthData = healthRes?.ok ? await healthRes.json() : null;
      const pollsRes = await fetch("/api/poll-events?limit=5").catch(() => null);
      const pollsData = pollsRes?.ok ? await pollsRes.json() : null;
      const blocksRes = await fetch("/api/block-events?limit=5").catch(() => null);
      const blocksData = blocksRes?.ok ? await blocksRes.json() : null;
      const sourcesRes = await fetch("/api/sources").catch(() => null);
      const sourcesData = sourcesRes?.ok ? await sourcesRes.json() : null;
      const snoozeRes = await fetch("/api/alerts/snooze").catch(() => null);
      const snoozeData = snoozeRes?.ok ? await snoozeRes.json() : null;
      const shopRes = await fetch("/api/shop-products").catch(() => null);
      const shopData = shopRes?.ok ? await shopRes.json() : null;
      const at = Date.now();
      const incoming = withPreviewVehicles(data.vehicles || [], target, previewMode, at);
      const shopIncoming = shopData ? withPreviewShopProducts(shopData.products || [], previewMode, at) : [];
      const newHashSet = new Set(data.newHashes || []);

      setLastSource(data.source || "");
      setStale(!!data.stale);
      setLastSuccess(data.lastSuccess || null);
      setTargetConfig(target);
      setHealth(healthData);
      setSources(sourcesData);
      if (snoozeData) setSnoozeState(snoozeData);
      setRecentPolls(pollsData?.events || []);
      setRecentBlocks(blocksData?.events || []);
      if (shopData) {
        setShopProducts(shopIncoming);
        setShopLastChecked(shopData.lastChecked || null);
        setShopStale(!!shopData.stale);
      }

      const withFresh = incoming.map((v) => ({ ...v, fresh: newHashSet.has(v.id) || !!v.uiPreview }));
      if (newHashSet.size > 0) {
        setNewSince((n) => n + newHashSet.size);
      }
      if (alertsRef.current) {
        const exactAlerts = withFresh
          .filter((v) => v.fresh && isExactTarget(v, target))
          .map(carAvailabilityAlert);
        const shopAlerts = shopIncoming
          .filter((p) => p.status === "in_stock" && p.fresh)
          .map((p) => shopAvailabilityAlert(p, at));
        const nextAlert = exactAlerts.concat(shopAlerts).find((alert) => (
          availabilityToastRef.current?.key !== alert.key &&
          !announcedAlertKeysRef.current.has(alert.key) &&
          !dismissedAlertKeysRef.current.has(alert.key)
        ));
        if (nextAlert) {
          announcedAlertKeysRef.current.add(nextAlert.key);
          chime();
          setAvailabilityToast(nextAlert);
          if ("Notification" in window && Notification.permission === "granted") {
            try {
              new Notification(nextAlert.notificationTitle, {
                body: nextAlert.notificationBody,
                tag: nextAlert.key,
              });
            } catch (e) {}
          }
        }
      }

      setVehicles(withFresh);
      setLastChecked(at);
    } catch (err) {
      console.error("Check failed:", err);
      setLoadError(err.message);
    } finally {
      setBusy(false);
    }
  }, [previewMode]);

  useEffect(() => { runCheck(); }, [runCheck]);
  const activeTheme = resolveTheme(t.theme, now);
  useEffect(() => {
    document.documentElement.dataset.theme = activeTheme;
  }, [activeTheme]);
  useEffect(() => {
    try {
      window.localStorage.setItem("yl-theme-mode", t.theme);
      window.localStorage.removeItem("yl-theme");
    } catch (e) {}
  }, [t.theme]);
  useEffect(() => {
    if (!t.autoCheck) return;
    const id = setInterval(runCheck, POLL_MS);
    return () => clearInterval(id);
  }, [t.autoCheck, runCheck]);
  useEffect(() => { const id = setInterval(() => setNow(Date.now()), 1000); return () => clearInterval(id); }, []);
  useEffect(() => {
    const fetchSnooze = () => {
      fetch("/api/alerts/snooze")
        .then((r) => r.ok ? r.json() : null)
        .then((d) => { if (d) setSnoozeState(d); })
        .catch(() => {});
    };
    fetchSnooze();
    const id = setInterval(fetchSnooze, 10000);
    return () => clearInterval(id);
  }, []);
  useEffect(() => {
    if (vehicles.some((v) => v.fresh)) {
      const id = setTimeout(() => setVehicles((vs) => vs.map((v) => v.fresh ? { ...v, fresh: false } : v)), 900);
      return () => clearTimeout(id);
    }
  }, [vehicles]);
  const armAlerts = useCallback(() => {
    if (alertsRef.current) { setAlertsOn(false); return; }
    setAlertsOn(true);
    chime();
    if ("Notification" in window && Notification.permission === "default") Notification.requestPermission();
  }, []);
  const dismissAvailabilityToast = useCallback(() => {
    const key = availabilityToastRef.current?.key;
    if (key) {
      dismissedAlertKeysRef.current.add(key);
      writeStoredKeySet(DISMISSED_ALERTS_KEY, dismissedAlertKeysRef.current);
    }
    setAvailabilityToast(null);
  }, []);

  const snoozeAlerts = useCallback((durationMs) => {
    fetch("/api/alerts/toggle", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ durationMs }),
    })
      .then((r) => r.ok ? r.json() : null)
      .then((d) => { if (d) setSnoozeState(d); })
      .catch((err) => console.error("Snooze failed:", err));
  }, []);

  const updateTarget = useCallback((patch) => {
    setTargetConfig((current) => {
      const next = { ...(current || {}), ...patch };
      fetch("/api/target", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(next),
      }).catch((err) => console.error("Target update failed:", err));
      return next;
    });
  }, []);

  const active = vehicles.filter((v) => !v.removed);
  const removed = vehicles.filter((v) => v.removed);
  const exactMatches = active.filter((v) => isExactTarget(v, targetConfig));
  const ylCandidates = active.filter((v) => isYlVehicle(v, targetConfig) && !isExactTarget(v, targetConfig));
  const standardInventory = active.filter((v) => !isYlVehicle(v, targetConfig));
  const newCount = active.filter((v) => isNewWindow(v, now)).length;
  const freshnessWindowMs = Math.max(
    health?.watcherStaleThresholdMs || 30 * 60 * 1000,
    (health?.effectivePollIntervalMs || 0) * 2
  );
  const dataStale = stale || !!health?.watcherStale || (lastSuccess && (now - lastSuccess) > freshnessWindowMs);
  const directInventoryEnabled = health?.directInventoryEnabled !== false;
  const visibleDataStale = directInventoryEnabled && dataStale;

  const paintsPresent = [...new Set(active.map((v) => v.exterior))];
  const statesPresent = [...new Set(active.map((v) => v.state))];
  const swatchKeys = Y.extKeys.filter((k) => paintsPresent.includes(k)).concat(paintsPresent.filter((p) => !Y.extKeys.includes(p)));
  const togglePaint = (e) => setFPaint((s) => { const n = new Set(s); n.has(e) ? n.delete(e) : n.add(e); return n; });
  const clearFilters = () => { setViewMode("all"); setFInterior("all"); setFPaint(new Set()); setFState("all"); setFNew(false); setFDemo(false); };
  const anyFilter = viewMode !== "all" || fInterior !== "all" || fPaint.size || fState !== "all" || fNew || fDemo;
  const activeFilterCount = (viewMode !== "all" ? 1 : 0) + (fInterior !== "all" ? 1 : 0) + fPaint.size + (fState !== "all" ? 1 : 0) + (fNew ? 1 : 0) + (fDemo ? 1 : 0);

  const passesFilters = (v) => {
    const tier = vehicleTier(v, targetConfig);
    if (viewMode === "exact" && tier !== "exact") return false;
    if (viewMode === "yl" && tier === "standard") return false;
    if (viewMode === "standard" && tier !== "standard") return false;
    if (fNew && !isNewWindow(v, now)) return false;
    if (!fDemo && v.isDemo) return false;
    if (fInterior !== "all" && v.interior !== fInterior) return false;
    if (fPaint.size && !fPaint.has(v.exterior)) return false;
    if (fState !== "all" && v.state !== fState) return false;
    return true;
  };
  const sortNewest = (a, b) => (b.firstSeen || b.appeared || 0) - (a.firstSeen || a.appeared || 0);
  const exactShown = exactMatches.filter(passesFilters).sort(sortNewest);
  const candidateShown = ylCandidates.filter(passesFilters).sort(sortNewest);
  const standardShown = standardInventory.filter(passesFilters).sort(sortNewest);
  const totalShown = exactShown.length + candidateShown.length + standardShown.length;
  const targetExterior = targetExteriorText(targetConfig);
  const targetInterior = targetInteriorText(targetConfig);
  const targetCabin = targetConfig?.cabinConfig === "SIX" ? "6-seat" : targetConfig?.cabinConfig || "Any cabin";
  const targetModel = getTrimKeywords(targetConfig).join(" / ") || "Any model";
  const targetState = targetConfig?.state && targetConfig.state !== "all" ? targetConfig.state : "All monitored states";
  const targetStateOptions = health?.monitoredStates?.length === 1
    ? health.monitoredStates
    : ["all"].concat(health?.monitoredStates?.length ? health.monitoredStates : Y.stateKeys);
  const firstExact = exactMatches[0] || null;
  const snoozedUntil = snoozeState?.snoozedUntil || health?.alertsSnoozedUntil || 0;
  const snoozeRemaining = snoozedUntil ? Math.max(0, snoozedUntil - now) : 0;
  const browserBackoffRemaining = health?.browserBackoffRemainingMs ? Math.max(0, health.browserBackoffRemainingMs) : 0;
  const pollStatus = !directInventoryEnabled ? "inventory paused" : busy ? "checking" : browserBackoffRemaining > 0 ? "browser backoff" : dataStale ? "stale" : "OK";
  const alertStatus = snoozeRemaining > 0
    ? "snoozed " + fmtRemaining(snoozeRemaining)
    : health?.realAlertsEnabled === false
    ? "muted"
    : health?.alertReady ? "ready" : health?.alertMissing?.length ? "missing " + health.alertMissing.join(" / ") : "checking";
  const deploymentStatus = health?.deploymentMode === "docker"
    ? "Production on Docker"
    : (health?.realAlertsEnabled ? "Production local" : "Local muted");
  const deploymentDetail = health?.hostName ? deploymentStatus + " / " + health.hostName : deploymentStatus;
  const backgroundStatus = health?.chromeBackgroundMode === "visible"
    ? (health?.deploymentMode === "docker" ? "noVNC display active" : "visible debug")
    : health?.browserConnected ? "Chrome minimized" : "Chrome starting";
  const stateStatus = health?.lastStateSave ? "saved " + Y.timeAgo(health.lastStateSave, now) + " ago" : "not saved yet";
  const failureStatus = health?.consecutiveFailedPolls
    ? `${health.consecutiveFailedPolls} active`
    : health?.failedPolls ? `${health.failedPolls} past` : "none";
  const cleanPolls = typeof health?.recentPollSuccesses === "number" && typeof health?.recentPollWindow === "number"
    ? `${health.recentPollSuccesses}/${health.recentPollWindow} recent checks clean`
    : "recent checks loading";
  const reliabilityText = directInventoryEnabled
    ? `Polling ${pollStatus} · ${cleanPolls} · ${stateStatus} · alerts ${alertStatus}`
    : `Accessories active · vehicle inventory paused · ${stateStatus} · alerts ${alertStatus}`;
  const storageStatus = health?.stateFileSize ? `${fmtBytes(health.stateFileSize)} state` : "state pending";
  const backupStatus = health?.latestBackupValid
    ? `${health.backupCount || 0} backups`
    : health?.backupCount ? `${health.backupCount} backups need check` : "no backups yet";
  const browserStatus = health?.browserConnected
    ? `${health.browserPageCount ?? "?"} pages / ${health.chromeProcessCount ?? "?"} procs`
    : "not connected";
  const browserHealthStatus = browserBackoffRemaining > 0
    ? `backoff ${fmtRemaining(browserBackoffRemaining)}`
    : health?.browserLaunchFailures ? `${health.browserLaunchFailures} launch failures` : "normal";
  const matchTestStatus = health?.lastExactMatchTestAt
    ? "last " + Y.timeAgo(health.lastExactMatchTestAt, now) + " ago"
    : "not run";
  const shopTotalCount = shopProducts.length || health?.shopProductCount || SHOP_PRODUCT_COUNT;
  const loadedShopInStockCount = shopProducts.filter((p) => p.status === "in_stock").length;
  const shopInStockCount = shopProducts.length ? loadedShopInStockCount : health?.shopProductsInStock || 0;
  const shopUnknownCount = shopProducts.filter((p) => p.status === "unknown").length;
  const shopBlockedCount = shopProducts.filter((p) => p.status === "blocked").length;
  const shopFreshCount = shopProducts.filter((p) => p.fresh).length;
  const firstInStockAccessory = shopProducts.find((p) => p.status === "in_stock") || null;
  const shopAlertTone = shopInStockCount > 0 ? "hit" : shopStale || shopUnknownCount > 0 || shopBlockedCount > 0 ? "warn" : "";
  const shopStatValue = shopStale && !shopProducts.length ? "stale" : `${shopInStockCount}/${shopTotalCount}`;
  const shopStatLabel = shopInStockCount > 0
    ? "IN STOCK"
    : shopStale ? "stale"
      : shopBlockedCount > 0 ? `${shopBlockedCount} blocked`
      : shopUnknownCount > 0 ? `${shopUnknownCount} unknown`
        : "out of stock";
  const AccessoryStat = firstInStockAccessory ? "a" : "span";
  const isAutoTheme = t.theme === "auto";
  const isDayTheme = activeTheme === "day";
  const themeToggleLabel = isAutoTheme
    ? (isDayTheme ? "Force night" : "Force day")
    : (isDayTheme ? "Night mode" : "Day mode");
  const themeToggleTitle = isAutoTheme
    ? `Auto theme: ${isDayTheme ? "day" : "night"} now in Melbourne. Click to pin ${isDayTheme ? "night" : "day"} mode.`
    : (isDayTheme ? "Switch to dark night mode" : "Switch to day mode");

  return (
    <div className="wrap" data-density={t.density} data-theme={isDayTheme ? "day" : "night"}>
      <div className="top">
        <div className="title">
          <h1>{directInventoryEnabled ? "Tesla Stock" : "Tesla Accessories"} <b>Watch</b></h1>
          <span className="sub">{directInventoryEnabled ? `${targetExterior} / ${targetInterior} interior / ${targetModel}` : "Accessory availability first / vehicle inventory paused"}</span>
        </div>
        <div className="top-right">
          <div className={"checked" + (busy ? " busy" : "")}>
            <span className={"dot" + (visibleDataStale ? " stale" : "")}></span>
            {busy ? "checking..." : lastChecked ? "checked " + Y.timeAgo(lastChecked, now) + " ago" : "loading..."}
            {lastSource && !busy && <span className="source">{sourceLabel(lastSource)}</span>}
          </div>
          <div className="actions">
            <button
              className={"theme-toggle" + (isDayTheme ? " day" : "")}
              onClick={() => setTweak("theme", isDayTheme ? "night" : "day")}
              aria-pressed={!isAutoTheme}
              title={themeToggleTitle}
            >
              {isDayTheme ? IcoMoon : IcoSun}
              {themeToggleLabel}
            </button>
            <button className={"alertbtn" + (alertsOn ? " on" : "")} onClick={armAlerts} title={alertsOn ? "Browser chime and desktop notification armed" : "Arm this browser's chime and desktop notification"}>
              {alertsOn ? IcoAlert : IcoAlertOff}{alertsOn ? "Browser alerts on" : "Browser alerts off"}
            </button>
            <button className={"refresh" + (busy ? " busy" : "")} onClick={runCheck}>{IcoRefresh} Check now</button>
          </div>
        </div>
      </div>

      {directInventoryEnabled && dataStale && !busy && vehicles.length > 0 && (
        <div className="errbanner stale-banner">
          <span>Data stale — last successful Tesla fetch {lastSuccess ? Y.timeAgo(lastSuccess, now) + " ago" : "not yet completed"}. Retrying automatically.</span>
        </div>
      )}
      {loadError && <div className="errbanner"><span>Could not reach Tesla — {loadError}</span><button onClick={runCheck}>Retry</button></div>}

      {directInventoryEnabled && <MatchAlarm match={firstExact} count={exactMatches.length} targetExterior={targetExterior} targetInterior={targetInterior} />}

      {!directInventoryEnabled && (
        <section className="target-hero accessory-focus">
          <div className="hero-copy">
            <span className="eyebrow">{previewMode ? "Accessory watch · UI preview" : "Accessory watch"}</span>
            <h2>{firstInStockAccessory ? `${firstInStockAccessory.name} is available` : "Accessory watch active"}</h2>
            <p>{firstInStockAccessory
              ? "A watched Tesla Shop accessory is in stock now. Open the product page before it disappears."
              : shopUnknownCount > 0
                ? `${shopUnknownCount} accessory ${shopUnknownCount === 1 ? "status is" : "statuses are"} unknown. The watcher will keep checking without polling vehicle inventory.`
                : shopBlockedCount > 0
                  ? `Tesla Shop blocked ${shopBlockedCount} accessory ${shopBlockedCount === 1 ? "page" : "pages"} from this host. The watcher will keep retrying without sending availability alerts from blocked pages.`
                : `Watching ${shopTotalCount} Tesla Shop accessories. Vehicle inventory polling is paused because your Model Y L order is confirmed.`}</p>
            <div className="target-chips">
              <span>Vehicle inventory paused</span>
              <span>Shop interval {fmtRemaining(health?.effectiveShopPollIntervalMs || 0)}</span>
              <span>Alerts {alertStatus}</span>
              {shopLastChecked && <span>Last shop check {Y.timeAgo(shopLastChecked, now)} ago</span>}
            </div>
            {firstInStockAccessory && <a className="hero-cta" href={firstInStockAccessory.url} target="_blank" rel="noopener">Open Tesla Shop<svg {...iconProps}><path d="M5 12h14M13 6l6 6-6 6"/></svg></a>}
          </div>
          <div className="hero-stats">
            <AccessoryStat
              className={["hero-stat", "accessory-stat", shopAlertTone].filter(Boolean).join(" ")}
              href={firstInStockAccessory?.url}
              target={firstInStockAccessory ? "_blank" : undefined}
              rel={firstInStockAccessory ? "noopener" : undefined}
            >
              <b>{shopStatValue}</b> Accessories · {shopStatLabel}{shopFreshCount > 0 ? ` · ${shopFreshCount} new` : ""}
            </AccessoryStat>
            <span className="hero-stat"><b>{shopBlockedCount}</b> blocked</span>
            <span className="hero-stat"><b>{shopLastChecked ? Y.timeAgo(shopLastChecked, now) : "—"}</b> last shop check</span>
            <span className="hero-stat"><b>{directInventoryEnabled ? "on" : "off"}</b> Vehicle polling</span>
          </div>
        </section>
      )}

      {shopProducts.length > 0 && (
        <section className="section shop-section">
          <div className="section-head">
            <span>Accessories first priority</span>
            <b>{shopProducts.length}</b>
          </div>
          <div className={"shop-grid" + (shopStale ? " is-stale" : "")}>
            {shopProducts.map((p) => {
              const checkedAt = p.lastCheckedAt || shopLastChecked;
              const cls = ["shop-card", p.status === "in_stock" ? "in-stock" : "", p.status === "unknown" || p.status === "blocked" ? "unknown" : ""].filter(Boolean).join(" ");
              return (
                <a key={p.id} className={cls} href={p.url} target="_blank" rel="noopener">
                  <span className="shop-top">
                    <span className="shop-status">{shopStatusLabel(p.status)}</span>
                    {p.uiPreview && <StatusBadge tone="preview">PREVIEW</StatusBadge>}
                    {p.fresh && <StatusBadge tone="new">NEW</StatusBadge>}
                  </span>
                  <span className="shop-name">{p.name}</span>
                  <span className="shop-checked">{checkedAt ? "checked " + Y.timeAgo(checkedAt, now) + " ago" : "not yet checked"}</span>
                </a>
              );
            })}
          </div>
        </section>
      )}

      {directInventoryEnabled && <section className={"target-hero" + (exactMatches.length ? " hit" : " watch")}>
        <div className="hero-copy">
          <span className="eyebrow">{previewMode ? "Target watch · UI preview" : "Target watch"}</span>
          {exactMatches.length > 0 && <span className="hero-match-badge">{IcoCheck}<span>Target matched</span></span>}
          <h2>{exactMatches.length ? "Model Y L available" : "No Y L target found"}</h2>
          <p>{exactMatches.length
            ? `A ${targetExterior} / ${targetInterior} Model Y L is listed now. Review the details and open Tesla when you are ready.`
            : ylCandidates.length
              ? `No exact ${targetExterior} / ${targetInterior} Model Y L found yet. ${ylCandidates.length} six-seat Y L close ${ylCandidates.length === 1 ? "match is" : "matches are"} listed below for review.`
              : `No ${targetExterior} / ${targetInterior} Model Y L found yet. ${standardInventory.length} standard Model Y vehicles are tracked for context.`}</p>
          <div className="target-chips">
            <span>{targetModel}</span>
            <span>{targetState}</span>
            {(targetConfig?.exterior?.length ? targetConfig.exterior : ["Any exterior"]).map((x) => <span key={"ex-" + x}>{x}</span>)}
            {(targetConfig?.interior?.length ? targetConfig.interior : ["Any interior"]).map((x) => <span key={"in-" + x}>{x} interior</span>)}
            <span>{targetCabin}</span>
            <span>{targetConfig?.excludeDemo ? "No demos" : "Demos included"}</span>
            {previewMode && <span className="preview-chip">Preview only · no alerts</span>}
          </div>
          {firstExact && <a className="hero-cta" href={TESLA_URL} target="_blank" rel="noopener">Open Tesla now<svg {...iconProps}><path d="M5 12h14M13 6l6 6-6 6"/></svg></a>}
        </div>
        <div className="hero-stats">
          <span className="hero-stat"><b>{active.length}</b> tracked</span>
          <span className="hero-stat"><b>{standardInventory.length}</b> standard Model Y</span>
          <span className="hero-stat"><b>{ylCandidates.length}</b> 6-seat Y L</span>
          <span className="hero-stat"><b>{newCount}</b> new</span>
          <AccessoryStat
            className={["hero-stat", "accessory-stat", shopAlertTone].filter(Boolean).join(" ")}
            href={firstInStockAccessory?.url}
            target={firstInStockAccessory ? "_blank" : undefined}
            rel={firstInStockAccessory ? "noopener" : undefined}
            title={shopLastChecked ? "Accessories checked " + Y.timeAgo(shopLastChecked, now) + " ago" : "Accessory stock monitor"}
          >
            <b>{shopStatValue}</b> Accessories · {shopStatLabel}{shopFreshCount > 0 ? ` · ${shopFreshCount} new` : ""}
          </AccessoryStat>
        </div>
      </section>}

      <details className="system-panel">
        <summary>
          <span>System status</span>
          <b>{pollStatus}</b>
          <em>{reliabilityText}</em>
        </summary>
        <div className="reliability-line">{reliabilityText}</div>
        <div className="service-strip">
          <span className={"service-pill production " + (health?.realAlertsEnabled ? "ok" : "warn")} title={deploymentDetail}>
            <b>Mode</b><span className="service-value">{deploymentDetail}</span>
          </span>
          <span className={"service-pill " + (pollStatus === "OK" || pollStatus === "inventory paused" ? "ok" : pollStatus === "checking" ? "busy" : "warn")}>
            <b>Polling</b><span className="service-value">{pollStatus}</span>
          </span>
          <span className={"service-pill " + (health?.alertReady || health?.realAlertsEnabled === false ? "ok" : "warn")}>
            <b>Alerts</b><span className="service-value">{alertStatus}</span>
          </span>
          <button
            className={"snooze-btn" + (snoozeRemaining > 0 ? " active" : "")}
            onClick={() => snoozeAlerts(snoozeRemaining > 0 ? 0 : 2 * 60 * 60 * 1000)}
            title={snoozeRemaining > 0 ? "Cancel alert snooze" : "Snooze automatic Pushover and email alerts for 2 hours"}
          >
            {snoozeRemaining > 0 ? "Snoozed " + fmtRemaining(snoozeRemaining) : "Snooze 2h"}
          </button>
          <span className={"service-pill " + (health?.chromeBackgroundMode === "visible" && health?.deploymentMode !== "docker" ? "warn" : "ok")}>
            <b>Background</b><span className="service-value">{backgroundStatus}</span>
          </span>
          <span className={"service-pill " + (health?.browserConnected ? "ok" : "warn")}>
            <b>Browser</b><span className="service-value">{browserStatus}</span>
          </span>
          <span className={"service-pill " + (browserBackoffRemaining > 0 || health?.browserLaunchFailures ? "warn" : "ok")}>
            <b>Browser health</b><span className="service-value">{browserHealthStatus}</span>
          </span>
          <span className="service-pill">
            <b>State</b><span className="service-value">{stateStatus}</span>
          </span>
          <span className="service-pill">
            <b>Storage</b><span className="service-value">{storageStatus}</span>
          </span>
          <span className={"service-pill " + (health?.latestBackupValid ? "ok" : "warn")}>
            <b>Backups</b><span className="service-value">{backupStatus}</span>
          </span>
          <span className="service-pill">
            <b>Version</b><span className="service-value">{health?.buildVersion || "unknown"}</span>
          </span>
          <span className={"service-pill " + (health?.lastExactMatchTestAt ? "ok" : "")}>
            <b>Match test</b><span className="service-value">{matchTestStatus}</span>
          </span>
          <span className={"service-pill " + (health?.consecutiveFailedPolls ? "warn" : "ok")}>
            <b>Failures</b><span className="service-value">{failureStatus}</span>
          </span>
        </div>

        <SourceHealthCards sources={sources || health?.sources} now={now} />

        <section className="poll-panel">
          <div className="section-head"><span>Recent polls</span><b>{recentPolls.length}</b></div>
          <div className="poll-list">
            {recentPolls.length ? recentPolls.slice().reverse().map((p, i) => (
              <span key={(p.timestamp || "") + i} className={"poll-row " + (p.success ? "ok" : "fail")}>
                <b>{shortTime(p.timestamp)}</b>
                <em>{p.success ? "OK" : "FAIL"}</em>
                <span>{p.source || "unknown"}</span>
                <span>{p.vehicleCount ?? 0} vehicles</span>
                {p.error ? <small title={p.error}>{p.error}</small> : <small>{p.success ? "clean" : "poll failed"}</small>}
              </span>
            )) : <div className="poll-empty">No poll events recorded yet.</div>}
          </div>
        </section>

        <section className="poll-panel">
          <div className="section-head"><span>Recent blocks</span><b>{recentBlocks.length}</b></div>
          <div className="poll-list">
            {recentBlocks.length ? recentBlocks.slice().reverse().map((b, i) => (
              <span key={(b.timestamp || "") + i} className="poll-row fail">
                <b>{shortTime(b.timestamp)}</b>
                <em>{b.status || "BLOCK"}</em>
                <span>{b.phase || b.source || "unknown"}</span>
                <span>{b.requestCount || 0} req</span>
                <small title={b.error || ""}>{b.bodyHash ? `hash ${b.bodyHash}` : (b.error || "blocked")}</small>
              </span>
            )) : <div className="poll-empty">No block incidents recorded yet.</div>}
          </div>
        </section>
      </details>

      {directInventoryEnabled && <details className="filter-panel">
        <summary>
          <span>Filters</span>
          <b>{anyFilter ? activeFilterCount + " active" : "No filters"}</b>
          <em>{totalShown} shown · {active.length} tracked</em>
        </summary>
        <div className="filters">
          <div className="fg wide">
            <span className="fl">Inventory</span>
            <div className="view-pills">
              {[
                ["all", "All monitored"],
                ["yl", "6-seat Y L"],
                ["exact", "Exact target"],
                ["standard", "Standard Y"],
              ].map(([value, label]) => (
                <button key={value} className={viewMode === value ? "on" : ""} onClick={() => setViewMode(value)}>{label}</button>
              ))}
            </div>
          </div>
          <div className="fg">
            <span className="fl">Interior</span>
            <div className="seg">
              {["all", "Black", "White"].map((o) => (
                <button key={o} className={fInterior === o ? "on" : ""} onClick={() => setFInterior(o)}>{o === "all" ? "All" : o}</button>
              ))}
            </div>
          </div>
          {swatchKeys.length > 0 && (
            <div className="fg">
              <span className="fl">Paint</span>
              <div className="swatches">
                {swatchKeys.map((e) => <button key={e} className={"swbtn" + (fPaint.has(e) ? " on" : "")} title={e} onClick={() => togglePaint(e)} style={{ background: Y.EXTERIOR[e] || "#666" }}></button>)}
              </div>
            </div>
          )}
          <div className="fg">
            <span className="fl">State</span>
            <select className="sel" value={fState} onChange={(e) => setFState(e.target.value)}>
              <option value="all">All states</option>
              {Y.stateKeys.filter((s) => statesPresent.includes(s)).map((s) => <option key={s} value={s}>{s}</option>)}
            </select>
          </div>
          <label className={"chk" + (fNew ? " on" : "")} onClick={() => setFNew((x) => !x)}><span className="box"></span>New only</label>
          <label className={"chk" + (fDemo ? " on" : "")} onClick={() => setFDemo((x) => !x)}><span className="box"></span>Include demos</label>
          <div className="fmeta">
            {anyFilter ? <button className="clr" onClick={clearFilters}>clear filters</button> : <span className="count">No colour, interior, trim, or state filters applied.</span>}
          </div>
        </div>
      </details>}

      {alertsOn && availabilityToast && (
        <div className={"availability-toast " + availabilityToast.kind} role="status" aria-live="assertive">
          <div className="toast-head">
            <span className="toast-pulse"></span>
            <span className="toast-kicker">{availabilityToast.eyebrow}</span>
            <button className="toast-dismiss" onClick={dismissAvailabilityToast}>Dismiss</button>
          </div>
          <div className="toast-title">{availabilityToast.title}</div>
          <div className="toast-detail">{availabilityToast.detail}</div>
          <div className="toast-foot">
            <span>{availabilityToast.meta}</span>
            <a className="toast-action" href={availabilityToast.url} target="_blank" rel="noopener">
              {availabilityToast.cta}
              <svg {...iconProps}><path d="M5 12h14M13 6l6 6-6 6"/></svg>
            </a>
          </div>
        </div>
      )}
      {newSince > 0 && <div className="newbar"><span className="pulse"></span><span className="nb-msg">{newSince} new {newSince === 1 ? "listing" : "listings"} since you opened</span><span className="x" onClick={() => setNewSince(0)}>x</span></div>}

      {directInventoryEnabled && exactShown.length > 0 && (
        <section className="section priority-section">
          <div className="section-head"><span>Priority matches</span><b>{exactShown.length}</b></div>
          <div className="list">{exactShown.map((v, i) => <Listing key={vehicleKey(v, "exact", i)} v={v} now={now} tier="exact" target={targetConfig} />)}</div>
        </section>
      )}

      {directInventoryEnabled && candidateShown.length > 0 && (
        <section className="section">
          <div className="section-head"><span>6-seat Y L candidates</span><b>{candidateShown.length}</b></div>
          <div className="list">{candidateShown.map((v, i) => <Listing key={vehicleKey(v, "candidate", i)} v={v} now={now} tier="candidate" target={targetConfig} />)}</div>
        </section>
      )}

      {directInventoryEnabled && <section className="section standard-section">
        <div className="section-head"><span>Standard Model Y context inventory</span><b>{standardShown.length}</b></div>
        {busy && vehicles.length === 0 && <div className="empty"><div className="sm">Fetching inventory from Tesla AU...</div></div>}
        {!busy && !loadError && totalShown === 0 && vehicles.length > 0 && <div className="empty">No listings match these filters.</div>}
        <div className="list">{standardShown.map((v, i) => <Listing key={vehicleKey(v, "standard", i)} v={v} now={now} tier="standard" target={targetConfig} />)}</div>
      </section>}

      {directInventoryEnabled && t.showRemoved && removed.length > 0 && (
        <section className="section">
          <div className="section-head"><span>Removed from inventory</span><b>{removed.length}</b></div>
          <div className="list">{removed.sort((a, b) => (b.removed || 0) - (a.removed || 0)).map((v, i) => <Listing key={vehicleKey(v, "removed", i)} v={v} now={now} tier={vehicleTier(v, targetConfig)} target={targetConfig} />)}</div>
        </section>
      )}

      <div className="foot">Personal watcher · not affiliated with Tesla · refreshes locally · accessory-first mode</div>

      <TweaksPanel>
        <TweakSection label="Display" />
        <TweakRadio label="Theme" value={t.theme} options={[{ value: "auto", label: "Auto" }, { value: "night", label: "Night" }, { value: "day", label: "Day" }]} onChange={(v) => setTweak("theme", v)} />
        <TweakRadio label="Row height" value={t.density} options={["cozy", "compact"]} onChange={(v) => setTweak("density", v)} />
        <TweakSection label="Checking" />
        <TweakToggle label="Auto-check (60s)" value={t.autoCheck} onChange={(v) => setTweak("autoCheck", v)} />
        <TweakToggle label="Show removed listings" value={t.showRemoved} onChange={(v) => setTweak("showRemoved", v)} />
        {directInventoryEnabled && <TweakSection label="Alert target" />}
        {directInventoryEnabled && <TweakRow label="Exact matches now" value={exactMatches.length} />}
        {directInventoryEnabled && targetConfig && (
          <>
            <TweakRadio label="Cabin" value={targetConfig.cabinConfig} options={["SIX", "FIVE"]} onChange={(v) => updateTarget({ cabinConfig: v })} />
            <TweakRadio label="Paint" value={targetConfig.exterior?.length ? "Preferred" : "All"} options={["Preferred", "All"]} onChange={(v) => updateTarget({ exterior: v === "All" ? [] : ["Stealth Grey", "Diamond Black"] })} />
            <TweakRadio label="Interior" value={targetConfig.interior?.length ? "Preferred" : "All"} options={["Preferred", "All"]} onChange={(v) => updateTarget({ interior: v === "All" ? [] : ["Black", "White"] })} />
            <TweakRadio label="Model" value={targetConfig.trimKeywords?.length ? "Premium AWD" : "Any"} options={["Premium AWD", "Any"]} onChange={(v) => updateTarget({ trimKeywords: v === "Any" ? [] : ["Premium All-Wheel Drive"] })} />
            <TweakSelect label="State" value={targetConfig.state || targetStateOptions[0] || "all"} options={targetStateOptions} onChange={(v) => updateTarget({ state: v })} />
            <TweakToggle label="Exclude demos" value={!!targetConfig.excludeDemo} onChange={(v) => updateTarget({ excludeDemo: v })} />
          </>
        )}
      </TweaksPanel>
    </div>
  );
}

ReactDOM.createRoot(document.getElementById("root")).render(<App />);
