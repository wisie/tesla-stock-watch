#!/usr/bin/env node

const esbuild = require("esbuild");
const fs = require("fs");
const path = require("path");

const root = path.join(__dirname, "..");
const distDir = path.join(root, "dist");
const reactShim = path.join(__dirname, "react-shim.js");

fs.rmSync(distDir, { recursive: true, force: true });
fs.mkdirSync(distDir, { recursive: true });

const shared = {
  bundle: true,
  format: "iife",
  platform: "browser",
  target: ["chrome109"],
  jsx: "transform",
  inject: [reactShim],
  define: {
    "process.env.NODE_ENV": JSON.stringify(process.env.NODE_ENV || "production"),
  },
  legalComments: "none",
  logLevel: "info",
  sourcemap: false,
  minify: process.env.NODE_ENV !== "development",
};

async function build() {
  await esbuild.build({
    ...shared,
    entryPoints: [path.join(__dirname, "ui-entry.js")],
    outfile: path.join(distDir, "app.bundle.js"),
  });
}

build().catch((err) => {
  console.error(err);
  process.exit(1);
});
