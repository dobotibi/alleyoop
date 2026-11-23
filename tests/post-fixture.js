#!/usr/bin/env node
"use strict";
// Usage:
//   node tests/post-fixture.js <jobDir> [host]   POST a job dir (manifest.json + element files) to /frame
//   node tests/post-fixture.js --ping [host]     GET /ping
// host defaults to http://localhost:47800
// Exit code: 0 when ok:true, otherwise 1.

const fs = require("fs");
const path = require("path");
const http = require("http");
const https = require("https");

const DEFAULT_HOST = "http://localhost:47800";
const TIMEOUT_MS = 11 * 60 * 1000; // server job timeout is 10 min

function normalizeHost(h) {
  let base = h || DEFAULT_HOST;
  if (!/^https?:\/\//i.test(base)) base = "http://" + base;
  return base.replace(/\/+$/, "");
}

function request(method, urlStr, body) {
  return new Promise((resolve, reject) => {
    const u = new URL(urlStr);
    const lib = u.protocol === "https:" ? https : http;
    const headers = {};
    if (body !== undefined) {
      headers["Content-Type"] = "application/json";
      headers["Content-Length"] = Buffer.byteLength(body);
    }
    const started = Date.now();
    const req = lib.request(u, { method, headers }, (res) => {
      let data = "";
      res.setEncoding("utf8");
      res.on("data", (chunk) => (data += chunk));
      res.on("end", () =>
        resolve({ status: res.statusCode, text: data, ms: Date.now() - started })
      );
      res.on("error", reject);
    });
    req.setTimeout(TIMEOUT_MS, () =>
      req.destroy(new Error("timeout after " + TIMEOUT_MS + " ms"))
    );
    req.on("error", reject);
    if (body !== undefined) req.write(body);
    req.end();
  });
}

function printResponse(res) {
  console.log("HTTP status: " + res.status);
  console.log("Elapsed:     " + (res.ms / 1000).toFixed(2) + " s");
  let parsed = null;
  try {
    parsed = JSON.parse(res.text);
  } catch (_) {
    parsed = null;
  }
  if (parsed !== null) {
    console.log(JSON.stringify(parsed, null, 2));
  } else {
    console.log("(non-JSON response)");
    console.log(res.text);
  }
  return parsed;
}

function buildBody(jobDir) {
  const manifest = JSON.parse(
    fs.readFileSync(path.join(jobDir, "manifest.json"), "utf8")
  );
  const elements = Array.isArray(manifest.elements) ? manifest.elements : [];
  const files = {};
  for (const el of elements) {
    if (!el || typeof el.file !== "string") {
      throw new Error("manifest element without a 'file' field: " + JSON.stringify(el));
    }
    const filePath = path.join(jobDir, el.file);
    files[el.file] = fs.readFileSync(filePath).toString("base64");
  }
  return JSON.stringify({ manifest, files });
}

async function main() {
  const args = process.argv.slice(2);
  if (args.length === 0) {
    console.error("Usage: node tests/post-fixture.js <jobDir> [host]");
    console.error("       node tests/post-fixture.js --ping [host]");
    return 1;
  }

  if (args[0] === "--ping") {
    const base = normalizeHost(args[1]);
    const res = await request("GET", base + "/ping");
    const parsed = printResponse(res);
    return parsed && parsed.ok === true ? 0 : 1;
  }

  const jobDir = path.resolve(args[0]);
  const base = normalizeHost(args[1]);
  let body;
  try {
    body = buildBody(jobDir);
  } catch (err) {
    console.error("Cannot read job dir " + jobDir + ": " + err.message);
    return 1;
  }
  console.log("POST " + base + "/frame  (" + Math.round(body.length / 1024) + " KB)");
  const res = await request("POST", base + "/frame", body);
  const parsed = printResponse(res);
  return parsed && parsed.ok === true ? 0 : 1;
}

main().then(
  (code) => {
    process.exitCode = code;
  },
  (err) => {
    if (err && err.code) {
      console.error(
        "Request failed (" + err.code + (err.message && err.message !== err.code ? ": " + err.message : "") + ").\n" +
          "Is Dunk running and listening on the given host?"
      );
    } else {
      console.error("Error: " + (err && err.message ? err.message : err));
    }
    process.exitCode = 1;
  }
);
