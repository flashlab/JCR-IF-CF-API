# CLAUDE.md

This file provides guidance to Claude Code when working with code in this directory.

## Project

Single-file Tampermonkey / Violentmonkey userscript: `medreading-jcr.user.js`. It automatically looks up JCR IF and 中科院分区 data for journal names highlighted in yellow inside MedReading literature-digest emails received via Netease enterprise webmail (`mailh.qiye.163.com`), and injects inline badge spans that visually match the badges the email sender already provides for a subset of journals.

## Development commands

- Syntax check: `npm run medreading:check`  (i.e. `node --check medreading-jcr.user.js`)
- Build (minify): `npm run medreading:build`  (outputs to `scripts/extension/dist/medreading-jcr.user.min.js`)
- Manual test: install / reload the userscript in Tampermonkey, open a MedReading email in `mailh.qiye.163.com`, and confirm that yellow-highlighted journal names without sender badges get annotated within ~1–2 s.

Do not introduce a bundler, transpiler, or test framework unless explicitly requested.

## Architecture

All code lives in a single IIFE. Top-to-bottom sections:

1. **Config** — `JCR_ENDPOINT` and `JCR_CACHE_TTL_MS` (7 days). No per-user settings UI for now; quartile source is always CAS (`fenqu` field, falling back to `jif_quartile`).

2. **Utilities** — `gmFetch(url)`: GM_xmlhttpRequest promise wrapper (15 s timeout). `makeQueue(n)`: concurrency-capped async queue; shared `jcrQueue` is capped at 2 to be gentle on the API.

3. **Cache** — `GM_getValue(JCR_CACHE_KEY, {})` keyed by lowercased journal name. `JCR_CACHE_KEY` carries a schema version (`'mrjcrCache_v2'`); bump the suffix whenever the cached row shape changes (e.g. the current-year JIF field rename) so stale entries are abandoned instead of rendering blank IF badges. Entry shape: `{ data: Row[], medHit: bool, ts: number }` with a 7-day TTL. Separate namespace from scholarscope-lite's `jcrCache`.

4. **JCR API** — `jcrLookup(keyword)`: 2-attempt waterfall:
   - Attempt 1: exact match (`q=KEYWORD`)
   - Attempt 2: prefix (`q=KEYWORD&f=1`) if `total === 0`

   No explicit `is_med=1` attempt is needed — the API already auto-falls-back to the medline alias table when the main table returns zero rows, so both attempts surface medline hits via `med_hit`. Returns `{ row: firstRow | null, medHit: bool }`. Caches both hits and misses to avoid repeat calls.

5. **DOM helpers**:
   - `YELLOW_SEL`: attribute selector for MedReading's yellow highlight color `rgb(255,236,0)`.
   - `tierColor(row)`: maps fenqu/jif_quartile to one of four badge background colors.
   - `makeBadge(text, color)`: creates a `<span>` styled to match the sender's badge base style.
   - `injectBadges(yellowEl, row)`: inserts IF badge then 分区 badge immediately after the yellow element, each separated by a non-breaking space (`\u00A0`); sets `data-mr-done="1"`.
   - `hasAnnotation(el)`: returns `true` if `data-mr-done` is set, or if any of the next 3 sibling elements contain IF/分区 text, or carry the sender badge color (`#67c23a`).

6. **Scanner** — `processEl(el)`: sets `data-mr-done="pending"` immediately (prevents double-queuing), calls `jcrLookup`, calls `injectBadges` on success, sets `"not-found"` on miss, deletes the attribute on error (allows retry). `scanRoot(root)`: iterates all yellow elements in `root` and enqueues `processEl` for unannotated ones. `tryFrame(iframe)`: runs `scanRoot` inside a same-origin iframe's `contentDocument`.

7. **Bootstrap (manual trigger only)** — There is no auto-scan and no MutationObserver. `runScan()` scans `document.body` plus every same-origin `<iframe>` once, and is wired to a single `GM_registerMenuCommand` entry ("扫描当前邮件 JCR 标注"). Annotation happens only when the user invokes that menu command, so opening/switching emails does **not** auto-annotate — re-run the command after the email body renders.

## Important conventions

- **No CSS prefix class** — Injected spans use only inline `style` attributes (no injected class names), so they don't conflict with the mail app's CSS.
- **Yellow selector** — The `rgb(255,236,0)` color is specific to MedReading emails. If the sender changes the color, update `YELLOW_SEL`. Handle both `rgb(255,236,0)` (no space) and `rgb(255, 236, 0)` (space after comma) since browsers may normalise differently.
- **Sender badge detection** — `hasAnnotation` looks for the sender's `#67c23a` green background. If the sender changes their color scheme, update the string in `hasAnnotation`.
- **Tier color distinction** — Injected badges use darker colors (CAS 1区 deep orange `#e65100` / 2区 dark blue `#1565c0` / 3区 dark green `#2e7d32` / 1区 Top dark red `#b71c1c`) rather than the sender's flat `#67c23a`, so users can distinguish auto-injected from sender-provided badges. Keep the inline `TIER_COLORS` comments in sync with the hex values.
- **Badge separator** — `injectBadges` precedes every badge with a non-breaking space (`"\u00A0"`), not a plain space. A plain whitespace text node between `inline-block` badges is collapsible and can be dropped from the clipboard when the user copies the line; NBSP is non-collapsing so the IF / 分区 values stay separated on copy-paste.
- **`data-mr-done` lifecycle** — `"pending"` during an in-flight API call; `"1"` after successful injection; `"not-found"` when the API returns no matches; attribute deleted on network error (retry allowed).
- **`GM_*` grants** — `GM_xmlhttpRequest`, `GM_getValue`, `GM_setValue`, and `GM_registerMenuCommand` are declared; all four are used (the menu command calls `runScan`). Do not add `GM_addStyle` without a matching call site.
- **Cache namespace / schema version** — Use `JCR_CACHE_KEY` (currently `'mrjcrCache_v2'`) for this script's cache. Never share with or read from scholarscope-lite's `'jcrCache'`. **Bump the `_vN` suffix together with any change to the cached row shape** (in lockstep with the `jif_2025`/quartile/fenqu fields `injectBadges` reads) — otherwise older installs keep serving stale-shape rows for up to the 7-day TTL and render blank IF badges until the cache is cleared manually.

## External API contracts

- **JCR** — `https://jcr-query-api.4cf.workers.dev/api/jcr`. Response shape: `{ data: Row[], total: number, med_hit?: boolean }`. Default fields per row: `name`, `abbr`, `jif_2025` (nullable), `jif_quartile` (nullable), `fenqu` (nullable), `is_top` (nullable). Update `jif_2025` field reference when the upstream year rolls over.
