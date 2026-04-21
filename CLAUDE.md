# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project Overview

Cloudflare Worker + D1 API serving Journal Citation Reports (JCR) 2024 data and Chinese Fenqu 2026 grading data. Two tables: ~20,449 JCR journal records (`journals`) and ~22,297 Chinese grading entries (`fenqu`), queried via a single GET endpoint.

Deployed at: `https://jcr-query-api.4cf.workers.dev/api/jcr`

## Commands

```bash
npm run dev              # Local dev server (wrangler dev)
npm run deploy           # Deploy Worker to Cloudflare
npm run seed:generate    # Parse both CSVs → seed.sql
npm run seed:remote      # Generate + apply seed to remote D1
npm run schema:remote    # Apply schema.sql to remote D1
npm run schema:local     # Apply schema.sql to local D1
npm run seed:local       # Generate + apply seed to local D1
```

**Note:** `wrangler d1 execute --local` crashes on Windows due to a workerd runtime bug. Use `--remote` for testing, or test on macOS/Linux for local D1.

## Architecture

- **`src/index.ts`** — Single Worker entry point. Handles `GET /api/jcr` with query building, parameter validation, pagination, full-outer-join merge of journals + fenqu results, and browser + Cloudflare-edge response caching (24h TTL via `Cache-Control` + `caches.default`).
- **`schema.sql`** — Two base D1 tables plus two FTS5 virtual tables. `journals` has mirror columns `qname`/`qabbr` (UPPER of name/abbr) with BINARY indexes on `qname`, `qabbr`, `issn`, `eissn`, and a denormalized `fenqu_id` column pre-computed at seed time (ISSN → EISSN → qname priority). `fenqu` has `qname` mirror with indexes on `qname`, `issn`, `eissn`. `journals_fts` / `fenqu_fts` are contentless FTS5 tables using the trigram tokenizer (`case_sensitive=0`) for substring / suffix fuzzy acceleration.
- **`scripts/seed.ts`** — Node script that reads `Clinicalscientists_JIF2024.csv` and `Fenqu_2026.csv`, emits both original and uppercase copies, normalizes `N/A` cells to empty string, writes `seed.sql` with batched INSERTs, appends a single `UPDATE journals SET fenqu_id = ...` to backfill the denormalized pointer, then issues FTS `rebuild` statements so the virtual tables are populated after data load.
- **`wrangler.toml`** — D1 binding `DB` → database `jcr-db`.

## Data Sources

- **`Clinicalscientists_JIF2024.csv`** — 20,449 rows. Columns: Rank, Name, JCR_Year, Abbr, Publisher, ISSN, EISSN, Total_Cites, Total_Articles, Citable_Items, Cited_Half_life, Citing_Half_life, JIF_2024, Five_Year_JIF, JIF_Without_Self_cites, JCI, JIF_Quartile, JIF_Rank
- **`Fenqu_2026.csv`** — 22,297 rows. Columns: No, Name, ISSN, EISSN, Lang, Publisher, Database, Dalei_En, Dalei_Zh, Fenqu, Is_Top, Xiaolei_Info

ISSN and EISSN are stored as UPPERCASE in both tables.

## API Query Logic

### Input Validation
- Keywords are uppercased, then any character outside `[A-Z0-9 &'()+,\-./:] ` is silently stripped. The legal set was derived from actual name/abbr values across both CSVs.
- After stripping, each non-ISSN keyword must be ≥ 3 characters; shorter keywords return 400.

### Search Mode (per keyword after `|` split)
- If keyword matches `^\d{4}-\d{3}[\dxX]$` → **ISSN mode**: searches `issn`/`eissn` columns (direct equality).
- Otherwise → **Name/Abbr mode**: searches `qname` / `qabbr` (pre-uppercased mirror columns, indexed).

### Parameters
- **`is_eissn`** (ISSN mode only): `true`/`1` = EISSN only; `false`/`0` = ISSN only; omit = both.
- **`is_abbr`** (Name/Abbr mode only — **column selector**): `0`/`false` = search `qname` only; `1`/`true` = search `qabbr` only; omit = search both. `is_abbr=1` makes the fenqu arm vacuous (no `qabbr` column there) — only journals contributes.
- **`f`** (Name/Abbr mode only — **pattern selector**): omit = exact equality (`= ?`); **`1` = `kw%` (prefix, B-tree index)**; **`2` = `%kw%` (substring, FTS5 trigram)**; **`3` = `%kw` (suffix, FTS5 trigram + LIKE post-filter)**. Applied to the column(s) chosen by `is_abbr`. Literal `%` / `_` / `\` in keywords are escaped (`LIKE ? ESCAPE '\'`); `"` in keywords is doubled for FTS phrases.
- **`show_all`**: `0`/omit = name, abbr, jif_2024, jif_quartile, fenqu, is_top; `1` = all fields from both tables (internal `qname` / `qabbr` are never exposed).
- **`case`** (output formatting): `0`/omit = original case; `1` = all lower; `2` = first word upper; `3` = upper camel case (title case); `4` = ALL UPPER. Applies to both `name` and `abbr` unless `case_abbr` overrides.
- **`case_abbr`** (output formatting, `abbr` only): same values as `case`. If set, overrides `case` for `abbr`; if omitted, `abbr` follows `case`.
- **`page`**, **`page_size`** (1–100, default 20): pagination.

### Full-Outer-Join Merge
A single CTE query returns journals matches (with LEFT JOIN fenqu enrichment) UNION ALL with fenqu rows that match the query AND are not already linked by a matched journal. Fenqu-only matches are no longer dropped when journals also has hits. Rows where a journal matched but no matching fenqu exists keep NULL fenqu columns; rows where only fenqu matched keep NULL journals columns.

Ordering is `_src ASC, _sortkey ASC` — journals-sourced rows first, then fenqu-only rows, each alphabetized by uppercased name. `COUNT(*) OVER()` inside the CTE provides the total in the same round-trip; a separate count query runs only when the requested page is beyond the last populated page.

Response does **not** carry a top-level `source` field — each row's origin is inferable from which columns are populated.

### fenqu Enrichment (journals-sourced rows)
The best-matching fenqu row id is precomputed at seed time into `journals.fenqu_id` using priority ISSN → EISSN → `qname`. The hot query path reads this column directly (no correlated COALESCE) and LEFT JOINs fenqu on it. The same id is reused to dedupe the fenqu-only arm, so any re-seed of either CSV must regenerate `seed.sql` to refresh `fenqu_id`.

### CTE projection (arm-A retable avoidance)
`jcr_hits` materializes `j.id`, `j.fenqu_id`, **and every column the final response needs** (aliased `c_*` so `rank` doesn't collide with the FTS5 virtual column name). Arm A then projects from the materialized temp + a single `LEFT JOIN fenqu ON f.id = h.f_link` — it no longer reads the `journals` base table a second time. Without this inlining, each matched journal is read twice (once inside the CTE, once in arm A's `JOIN journals j ON j.id = h.j_id`), doubling `rows_read` on every hit.

### FTS planner invariant (f=2 / f=3)
FTS-mode keywords MUST drive the CTE from the FTS virtual table: `FROM journals_fts JOIN journals j ON j.id = journals_fts.rowid WHERE journals_fts MATCH ?`. The semantically-equivalent `FROM journals j WHERE j.id IN (SELECT rowid FROM journals_fts WHERE journals_fts MATCH ?)` is planner-fragile — SQLite switched to a journals full scan (~20k rows_read per query) the moment the CTE projection was simplified to a cheap column read, because the planner's cost estimator stopped preferring the FTS-driven plan. The explicit JOIN pins the execution order. The same invariant applies to the fenqu-only arm via `fenqu_fts`. The FTS table must be referenced by its unaliased name on both sides of the JOIN — MATCH's left-hand side is technically a hidden table-name column reference in FTS5, and the unaliased form is the only one SQLite's docs commit to supporting.

Mixed-mode queries (e.g. one keyword is ISSN, another is f=2) emit two `SELECT`s inside `jcr_hits` — one FTS-driven, one where-driven — joined with `UNION` (dedupes). The fenqu arm does the same inside the outer `UNION ALL`. For single-category queries (the common case), only one subquery is emitted — no UNION overhead.

### rows_read expectations
- **Exact** (1 hit, default `is_abbr`): ≈ 8 reads — 2 index probes (qname + qabbr) + materialize + fenqu row + fenqu-arm probe + fenqu-arm row + anti-join scan. The theoretical floor is ≈ 6 if `is_abbr=0` (single-column).
- **f=1 prefix** (default `is_abbr`): scales with ≈ 2× hit count because *both* `idx_qname` and `idx_qabbr` are range-scanned. A ~150-hit prefix costs ≈ 600 reads. Use `is_abbr=0` to cut to single-column cost (~300).
- **f=2 substring**: scales with FTS-match count + fenqu lookups; a mid-frequency keyword (e.g. `SCIENCE`) lands in the 1–2k range. Any sudden jump to 20k+ indicates the planner has reverted to a journals full scan — check that the FTS-driven JOIN shape is still intact.

### Caching
Successful `GET /api/jcr` responses are cached for 24h at both the browser (`Cache-Control: public, max-age=86400`) and the Cloudflare edge (`s-maxage=86400` + `caches.default.put`). After a re-seed, the edge cache must age out or be manually purged to surface fresh data immediately.

## Demo URLs

```
/api/jcr?q=LANCET
/api/jcr?q=LANCET%7CNATURE
/api/jcr?q=0140-6736
/api/jcr?q=0140-6736&is_eissn=0
/api/jcr?q=CANC&is_abbr=1&f=1&page_size=3   # prefix on abbr
/api/jcr?q=CANCER&f=2                        # substring (FTS5 trigram)
/api/jcr?q=LOGY&f=3                          # suffix (FTS5 trigram + LIKE post-filter)
/api/jcr?q=LANCET&show_all=1
/api/jcr?q=LANCET&page=1&page_size=5
/api/jcr?q=LANCET&case=1                        # name + abbr lowercase
/api/jcr?q=LANCET&case=3                        # name + abbr title case
/api/jcr?q=LANCET&case=1&case_abbr=4            # name lowercase, abbr UPPER
```

## Data Notes

- ISSN/EISSN stored as UPPERCASE in both tables
- `name` / `abbr` preserved in original case; `qname` / `qabbr` are uppercase mirror columns used as the actual search targets and are never exposed in API responses
- CSV cells equal to `N/A` (case-insensitive) are normalized to empty string during seed
- `JIF_2024` / `Five_Year_JIF` values of `<0.1` are stored as `0.05`; empty → `NULL`
- `Database` column in Fenqu CSV renamed to `db_source` (SQL reserved word)
- `journals_fts` / `fenqu_fts` are FTS5 virtual tables (trigram, case-insensitive) rebuilt at seed time; re-seeding must re-run the `rebuild` statements emitted by `scripts/seed.ts`
- D1 database ID is in `wrangler.toml` — verify it before deploy
