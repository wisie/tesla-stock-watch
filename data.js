/* Tesla Stock Watch — data layer and display helpers.
   Plain JS, exposed on window.YL. No framework deps. */
(function () {
  "use strict";

  const STATES = {
    NSW: "New South Wales",
    VIC: "Victoria",
    QLD: "Queensland",
    SA: "South Australia",
    WA: "Western Australia",
    ACT: "Australian Capital Territory",
    TAS: "Tasmania",
    NT: "Northern Territory",
  };

  const EXTERIOR = {
    "Stealth Grey":   "#5a5e63",
    "Pearl White":    "#e9ebec",
    "Pearl White Multi-Coat": "#e9ebec",
    "Diamond Black":  "#16181a",
    "Quicksilver":    "#a7adb3",
    "Silver":         "#a7adb3",
    "Cosmic Silver":  "#c8c4bc",
    "Deep Blue":      "#27406b",
    "Ultra Red":      "#8e2b27",
    "Red Multi-Coat": "#8e2b27",
    "Glacier Blue":   "#7fa8c4",
  };

  const INTERIOR = {
    "Black": "#202225",
    "White": "#e6e3dc",
  };

  const stateKeys = Object.keys(STATES).sort();
  const extKeys = Object.keys(EXTERIOR).sort();
  const intKeys = Object.keys(INTERIOR).sort();

  const pad = (n) => String(n).padStart(2, "0");

  function fmtPrice(v) {
    return "$" + v.toLocaleString("en-AU");
  }

  function maskVin(vin) {
    if (!vin) return "—";
    if (vin.includes("_")) {
      var parts = vin.split("_");
      return parts[0] + "_" + parts[1].slice(0, 4) + "…";
    }
    return vin.length > 12 ? vin.slice(0, 3) + "••••••" + vin.slice(-5) : vin;
  }

  function timeAgo(ts, now) {
    var s = Math.max(0, Math.floor((now - ts) / 1000));
    if (s < 60) return s + "s";
    var m = Math.floor(s / 60);
    if (m < 60) return m + "m";
    var h = Math.floor(m / 60);
    if (h < 24) return h + "h";
    return Math.floor(h / 24) + "d";
  }

  function clockTime(ts) {
    var d = new Date(ts);
    return pad(d.getHours()) + ":" + pad(d.getMinutes()) + ":" + pad(d.getSeconds());
  }

  window.YL = {
    STATES, EXTERIOR, INTERIOR, stateKeys, extKeys, intKeys,
    fmtPrice, maskVin, timeAgo, clockTime,
  };
})();
