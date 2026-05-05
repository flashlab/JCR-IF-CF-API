// ==UserScript==
// @name         MedReading JCR 标注
// @namespace    local.medreading.jcr
// @version      0.2.0
// @description  为网易企业邮箱 MedReading 邮件的黄色高亮杂志名自动补充 JCR IF 和中科院分区
// @author       local
// @match        https://mailh.qiye.163.com/*
// @run-at       document-idle
// @grant        GM_xmlhttpRequest
// @grant        GM_getValue
// @grant        GM_setValue
// @grant        GM_registerMenuCommand
// @connect      jcr-query-api.4cf.workers.dev
// ==/UserScript==

(function () {
  "use strict";

  // =========================================================================
  // Config
  // =========================================================================
  const JCR_CACHE_TTL_MS = 7 * 24 * 3600 * 1000;
  const JCR_ENDPOINT = "https://jcr-query-api.4cf.workers.dev/api/jcr";

  // =========================================================================
  // Utilities
  // =========================================================================
  function gmFetch(url) {
    return new Promise((resolve, reject) => {
      GM_xmlhttpRequest({
        method: "GET",
        url,
        timeout: 15000,
        onload(r) {
          if (r.status >= 200 && r.status < 300) {
            try {
              resolve(JSON.parse(r.responseText));
            } catch (e) {
              reject(e);
            }
          } else {
            reject(new Error("HTTP " + r.status));
          }
        },
        onerror() {
          reject(new Error("Network error"));
        },
        ontimeout() {
          reject(new Error("Timeout"));
        },
      });
    });
  }

  function makeQueue(concurrency) {
    let running = 0;
    const queue = [];
    function next() {
      while (running < concurrency && queue.length) {
        running++;
        const { fn, resolve, reject } = queue.shift();
        fn()
          .then(resolve, reject)
          .finally(() => {
            running--;
            next();
          });
      }
    }
    return {
      add(fn) {
        return new Promise((resolve, reject) => {
          queue.push({ fn, resolve, reject });
          next();
        });
      },
    };
  }

  // =========================================================================
  // Cache
  // =========================================================================
  function readCache() {
    try {
      return GM_getValue("mrjcrCache", {});
    } catch {
      return {};
    }
  }

  function writeCache(cache) {
    try {
      GM_setValue("mrjcrCache", cache);
    } catch {}
  }

  function cacheGet(kw) {
    const e = readCache()[kw];
    return e && Date.now() - e.ts < JCR_CACHE_TTL_MS ? e : null;
  }

  function cacheSet(kw, data, medHit) {
    const cache = readCache();
    cache[kw] = { data, medHit, ts: Date.now() };
    writeCache(cache);
  }

  // =========================================================================
  // JCR API
  // =========================================================================
  const jcrQueue = makeQueue(2);

  async function jcrLookup(keyword) {
    const ck = keyword.toLowerCase();
    const cached = cacheGet(ck);
    if (cached) return { row: cached.data[0] ?? null, medHit: cached.medHit };

    const q = encodeURIComponent(keyword.toUpperCase());
    let res = await gmFetch(`${JCR_ENDPOINT}?q=${q}`);
    if (!res.total) res = await gmFetch(`${JCR_ENDPOINT}?q=${q}&f=1`);
    if (!res.total) res = await gmFetch(`${JCR_ENDPOINT}?q=${q}&is_med=1`);

    const data = res.data ?? [];
    cacheSet(ck, data, !!res.med_hit);
    return { row: data[0] ?? null, medHit: !!res.med_hit };
  }

  // =========================================================================
  // DOM helpers
  // =========================================================================

  // The MedReading service wraps journal names in yellow spans with this exact color.
  // Handle both comma-space variants browsers may produce in computed/inline styles.
  const YELLOW_SEL =
    'span[style*="rgb(255,236,0)"], span[style*="rgb(255, 236, 0)"]';

  // Sender badges use a flat #67c23a. Auto-injected badges use tier-specific colors
  // (slightly darker) so they're visually distinct from sender-provided ones.
  const TIER_COLORS = {
    "1top": "#b71c1c", // CAS 1区 Top — dark red
    "1": "#2e7d32", // CAS 1区 — dark green
    "2": "#1565c0", // CAS 2区 — dark blue
    "3": "#e65100", // CAS 3区 — deep orange
  };
  const DEFAULT_COLOR = "#616161";

  // Matches sender badge base style exactly; background-color applied per-badge.
  const BADGE_BASE =
    "display:inline-block;height:auto;line-height:normal;padding:0 5px;" +
    "border-radius:4px;font-size:12px;margin-right:3px;white-space:nowrap;color:#fff;";

  function tierColor(row) {
    const fenquN = (row.fenqu || "").match(/^([1-4])/)?.[1];
    if (fenquN) {
      if (fenquN === "1" && row.is_top) return TIER_COLORS["1top"];
      return TIER_COLORS[fenquN] ?? DEFAULT_COLOR;
    }
    if (row.jif_quartile) {
      const n = row.jif_quartile.replace(/\D/g, "");
      return TIER_COLORS[n] ?? DEFAULT_COLOR;
    }
    return DEFAULT_COLOR;
  }

  function makeBadge(text, color) {
    const s = document.createElement("span");
    s.setAttribute(
      "style",
      `${BADGE_BASE}background-color:${color};border-color:${color};`,
    );
    s.title = "JCR API 自动标注";
    s.textContent = text;
    return s;
  }

  function injectBadges(yellowEl, row) {
    const color = tierColor(row);
    let anchor = yellowEl;

    if (row.jif_2024 != null) {
      const b = makeBadge(`IF: ${row.jif_2024}`, color);
      anchor.after(b);
      anchor = b;
    }

    // Prefer CAS 分区; fall back to JCR quartile label.
    const fenquMatch = (row.fenqu || "").match(/^([1-4])区/);
    if (fenquMatch) {
      const label = `中科院 ${fenquMatch[1]} 区${row.is_top ? " Top" : ""}`;
      anchor.after(makeBadge(label, color));
    } else if (row.jif_quartile) {
      anchor.after(makeBadge(row.jif_quartile, color));
    }

    yellowEl.dataset.mrDone = "1";
  }

  // Returns true if the yellow element already has IF/分区 annotations
  // (either from the sender or from a previous script run).
  function hasAnnotation(el) {
    if (el.dataset.mrDone) return true;
    let sib = el.nextSibling;
    for (let i = 0; i < 3 && sib; i++, sib = sib.nextSibling) {
      if (sib.nodeType !== 1) continue;
      if (/IF\s*[:：]|中科院|\b[1-4]\s*区/.test(sib.textContent || ""))
        return true;
      // Sender badge color detection
      if ((sib.getAttribute("style") || "").includes("67c23a")) return true;
    }
    return false;
  }

  // =========================================================================
  // Scanner
  // =========================================================================
  async function processEl(el) {
    if (hasAnnotation(el)) return;
    const name = el.textContent.trim();
    if (name.length < 3) return;
    // Mark immediately to prevent double-queuing from concurrent scans.
    el.dataset.mrDone = "pending";
    try {
      const { row } = await jcrLookup(name);
      if (row) {
        injectBadges(el, row); // sets mrDone = "1"
      } else {
        el.dataset.mrDone = "not-found";
      }
    } catch {
      // Allow retry on transient errors.
      delete el.dataset.mrDone;
    }
  }

  function scanRoot(root) {
    for (const el of root.querySelectorAll(YELLOW_SEL)) {
      if (!hasAnnotation(el)) jcrQueue.add(() => processEl(el));
    }
  }

  function tryFrame(iframe) {
    try {
      const doc = iframe.contentDocument;
      if (doc && doc.body) scanRoot(doc.body);
    } catch {
      // Cross-origin iframe — no access.
    }
  }

  // =========================================================================
  // Bootstrap
  // =========================================================================
  function runScan() {
    scanRoot(document.body);
    for (const f of document.querySelectorAll("iframe")) tryFrame(f);
  }

  GM_registerMenuCommand("扫描当前邮件 JCR 标注", runScan);
})();
