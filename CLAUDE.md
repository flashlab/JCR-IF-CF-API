# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project Overview

Cloudflare Worker + D1 API serving Journal Citation Reports (JCR) 2024 data, Chinese Fenqu 2026 grading data, and an NLM Medline alias fallback. Two tables: a flat `journals` table of ~22,440 merged JCR+Fenqu rows, and a `medline` table of ~35,398 NLM records with a pre-computed `journals_id` reverse-pointer. A single `GET /api/jcr` endpoint queries the main table first and falls back to medline aliases when the main table has zero hits.

Deployed at: `https://jcr-query-api.4cf.workers.dev/api/jcr`

## Commands

```bash
npm run dev              # Local dev server (wrangler dev)
npm run deploy           # Deploy Worker to Cloudflare
npm run seed:generate    # Parse integrated CSV + J_Medline.txt → seed.sql
npm run seed:remote      # Generate + apply seed to remote D1
npm run schema:remote    # Apply schema.sql to remote D1
npm run schema:local     # Apply schema.sql to local D1
npm run seed:local       # Generate + apply seed to local D1
```

**Note:** `wrangler d1 execute --local` crashes on Windows due to a workerd runtime bug. Use `--remote` for testing, or test on macOS/Linux for local D1.

## Architecture

- **`src/index.ts`** — Single Worker entry point. Handles `GET /api/jcr` with query building, parameter validation, pagination, main-table search with optional medline fallback / direct medline mode, and browser + Cloudflare-edge response caching (24h TTL via `Cache-Control` + `caches.default`).
- **`schema.sql`** — Flat `journals` table (JCR + Fenqu columns merged at export time) with mirror columns `qname`/`qabbr` (UPPER of name/abbr) and BINARY indexes on `qname`, `qabbr`, `issn`, `eissn`. Separate `medline` table with `journals_id INTEGER` precomputed at seed time (ISSN(Print) → EISSN match → ISSN(Online) → EISSN match → qabbr priority) and BINARY indexes on `qname`, `qabbr`, `issn`, `eissn`, `journals_id`. Two FTS5 contentless virtual tables — `journals_fts` and `medline_fts` — use the trigram tokenizer (`case_sensitive=0`) for substring / suffix fuzzy acceleration on each base table.
- **`scripts/seed.ts`** — Node script that reads `Clinicalscientists_JIF2024_integrated_Fenqu_2026.csv` (already a full-outer-joined merge of JCR and Fenqu with `Merge_Status`/`Merge_Match_By` columns that are intentionally discarded) and `J_Medline.txt`. It emits batched `INSERT` statements for `journals`, then computes per-medline-row `journals_id` via the priority above and emits batched `INSERT` statements for `medline`, and finally issues FTS `rebuild` statements so both virtual tables are populated after data load.
- **`wrangler.toml`** — D1 binding `DB` → database `jcr-db`.

## Data Sources

- **`Clinicalscientists_JIF2024_integrated_Fenqu_2026.csv`** — 22,440 rows (20,308 merged / 141 jcr_only / 1,991 fenqu_only). Columns: Rank, Name, JCR_Year, Abbr, Publisher, ISSN, EISSN, Total_Cites, Total_Articles, Citable_Items, Cited_Half_life, Citing_Half_life, JIF_2024, Five_Year_JIF, JIF_Without_Self_cites, JCI, JIF_Quartile, JIF_Rank, Fenqu_No, Lang, Database, Dalei_En, Dalei_Zh, Fenqu, Is_Top, Xiaolei_Info, Merge_Status, Merge_Match_By. `JCR_Year`, `Fenqu_No`, `Merge_Status`, and `Merge_Match_By` are not ingested.
- **`J_Medline.txt`** — 35,398 NLM journal records. Only `JournalTitle`, `MedAbbr`, `ISSN (Print)`, `ISSN (Online)`, and `NlmId` are ingested.

ISSN and EISSN are stored as UPPERCASE in both tables.

## API Query Logic

### Input Validation
- Keywords are uppercased, then any character outside `[A-Z0-9 &'()+,\-./:] ` is silently stripped. The legal set was derived from actual name/abbr values across JCR, Fenqu, and Medline.
- After stripping, each non-ISSN keyword must be ≥ 3 characters; shorter keywords return 400.

### Search Mode (per keyword after `|` split)
- If keyword matches `^\d{4}-\d{3}[\dxX]$` → **ISSN mode**: searches `issn`/`eissn` columns (direct equality). The ISSN columns in `journals` and `medline` have identical semantics, so the same predicate applies on either table.
- Otherwise → **Name/Abbr mode**: searches `qname` / `qabbr` (pre-uppercased mirror columns, indexed) on whichever table the dispatch path chose.

### Parameters
- **`is_eissn`** (ISSN mode only): `true`/`1` = EISSN only; `false`/`0` = ISSN only; omit = both.
- **`is_abbr`** (Name/Abbr mode only — **column selector**): `0`/`false` = search `qname` only; `1`/`true` = search `qabbr` only; omit = search both. Applies symmetrically to `journals` (main) and `medline` (fallback) paths.
- **`is_med`** (**dispatch selector**): `1`/`true` = skip `journals` and search `medline` directly; omit / `0` = search `journals` first, fall back to `medline` only when the main query returns zero rows (fallback triggers only on `page=1`).
- **`f`** (Name/Abbr mode only — **pattern selector**): omit = exact equality (`= ?`); **`1` = `kw%` (prefix, B-tree index)**; **`2` = `%kw%` (substring, FTS5 trigram)**; **`3` = `%kw` (suffix, FTS5 trigram + LIKE post-filter)**. Applied to the column(s) chosen by `is_abbr`. Literal `%` / `_` / `\` in keywords are escaped (`LIKE ? ESCAPE '\'`); `"` in keywords is doubled for FTS phrases.
- **`show_all`**: `0`/omit = name, abbr, jif_2024, jif_quartile, fenqu, is_top; `1` = all fields from `journals` + `nlm_id` from medline path. On the medline path, **orphan** rows (medline records whose `journals_id IS NULL`) are **dropped when `show_all=0`** and **returned when `show_all=1`** — with `name`/`abbr`/`issn`/`eissn` sourced from medline's own columns and JCR/Fenqu-specific fields left `NULL`. Internal `qname` / `qabbr` are never exposed.
- **`case`** (output formatting): `0`/omit = original case; `1` = all lower; `2` = first word upper; `3` = upper camel case (title case); `4` = ALL UPPER. Applies to both `name` and `abbr` unless `case_abbr` overrides.
- **`case_abbr`** (output formatting, `abbr` only): same values as `case`. If set, overrides `case` for `abbr`; if omitted, `abbr` follows `case`.
- **`page`**, **`page_size`** (1–100, default 20): pagination.

### Dispatch flow
1. If `is_med=1`: run medline query only.
2. Else: run main query. If `total=0` and `page=1`, run medline query as fallback.
3. Both queries emit identical row shapes (main path fills `nlm_id` with `NULL`; medline path fills missing journals fields via `COALESCE(j.*, m_*)` for orphan rows when `show_all=1`).
4. Response carries a top-level `med_hit: boolean` set iff the medline query actually executed AND matched ≥1 row in medline (including orphans). Default path is post-hoc bookkeeping (`medHit = total > 0` inside each medline-running branch — never in the main-hit branch). When the visible total is 0 under `show_all=0`, an extra `SELECT EXISTS(...)` probe runs against medline (orphan filter intentionally absent) to detect orphan-only matches that the data query's `journals_id IS NOT NULL` push-down would otherwise hide. `EXISTS` short-circuits, so the probe is ≈1–2 rows_read + 1 D1 round-trip on this rare path only. Hot paths (main hit, or medline with ≥1 visible row, or `show_all=1`) pay zero overhead.

Ordering is `_sortkey ASC` — uppercased name (main's `j.qname` or medline's `COALESCE(j.qname, h.m_qname)`). `COUNT(*) OVER()` inside the top SELECT provides the total in the same round-trip; a separate count query runs only when the requested page is beyond the last populated page.

### Main query shape (flat single-table)
The previous `journals + fenqu` full-outer-join CTE is gone. The main query is a single CTE over `journals` (two inner SELECTs only if the query mixes FTS-mode and non-FTS-mode keywords; otherwise a single SELECT). FTS-mode keywords are driven from `FROM journals_fts JOIN journals j ON j.id = journals_fts.rowid WHERE journals_fts MATCH ?` — the invariant below applies unchanged.

### Medline query shape (alias fallback)
Two CTEs over `medline`:
1. `med_hits` — materializes raw matches (projecting `m.journals_id` and `m_*` aliases used by the outer COALESCE). When `show_all=0`, `AND m.journals_id IS NOT NULL` is pushed into every subquery's WHERE so orphans never enter the CTE (the planner can use `idx_med_journals_id` at the source instead of materializing them and filtering at the outer SELECT).
2. `dedup` — collapses multiple medline aliases pointing to the same `journals_id` to a single representative row. With `show_all=0` this is a plain `MIN(m_id) GROUP BY journals_id` (no orphans to union). With `show_all=1` a `UNION ALL` re-adds orphan rows unchanged.
The outer SELECT joins `journals` on `h.journals_id`: `INNER JOIN` when `show_all=0` (seed guarantees every non-null journals_id has a matching journals row), `LEFT JOIN` when `show_all=1` (orphan rows must survive and fall through the projection's COALESCE).

### FTS planner invariant (f=2 / f=3)
FTS-mode keywords MUST drive the CTE from the FTS virtual table: `FROM <fts_table> JOIN <base> b ON b.id = <fts_table>.rowid WHERE <fts_table> MATCH ?`. The semantically-equivalent `FROM <base> b WHERE b.id IN (SELECT rowid FROM <fts_table> WHERE <fts_table> MATCH ?)` is planner-fragile — SQLite has been observed to fall back to a full scan of the base table the moment the CTE projection gets simplified to a cheap column read, because the planner's cost estimator stops preferring the FTS-driven plan. The explicit JOIN pins the execution order. Applies to both `journals_fts` and `medline_fts`. The FTS table must be referenced by its **unaliased** name on both sides of the JOIN — MATCH's left-hand side is a hidden table-name column reference in FTS5, and the unaliased form is the only one SQLite's docs commit to supporting.

Mixed-mode queries (e.g. one keyword is ISSN, another is f=2) emit two `SELECT`s inside the CTE — one FTS-driven, one where-driven — joined with `UNION` (dedupes). For single-category queries (the common case), only one subquery is emitted — no UNION overhead.

### rows_read expectations
- **Main exact hit** (1 journal, default `is_abbr`): ≈ 3–5 reads — 2 index probes (qname + qabbr) + materialize row. No more fenqu-side probes.
- **Main f=1 prefix** (default `is_abbr`): scales with ≈ 2× hit count (both `idx_qname` and `idx_qabbr` are range-scanned). Use `is_abbr=0` to cut to single-column cost.
- **Main f=2 substring**: scales with FTS-match count. Any sudden jump to 20k+ indicates the planner has reverted to a journals full scan — check that the FTS-driven JOIN shape is still intact.
- **Medline fallback**: additional round-trip to D1; `medline_fts`/`medline` indexes drive the plan; scales with medline hit count + the number of distinct `journals_id` values reached.

### Caching
Successful `GET /api/jcr` responses are cached for 24h at both the browser (`Cache-Control: public, max-age=86400`) and the Cloudflare edge (`s-maxage=86400` + `caches.default.put`). After a re-seed, the edge cache must age out or be manually purged to surface fresh data immediately. `is_med` participates in the cache key automatically (it's a URL param).

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
/api/jcr?q=NATURE%20REVIEWS.%20MICROBIOLOGY     # main 0 → medline fallback → returns journals row
/api/jcr?q=<some%20NLM-only%20title>&is_med=1   # skip main, search medline directly
/api/jcr?q=<NLM-orphan%20title>&show_all=1      # orphan returned (name/abbr/nlm_id from medline)
```

## Data Notes

- ISSN/EISSN stored as UPPERCASE in both tables
- `name` / `abbr` preserved in original case; `qname` / `qabbr` are uppercase mirror columns used as the actual search targets and are never exposed in API responses
- CSV cells equal to `N/A` (case-insensitive) are normalized to empty string during seed
- `JIF_2024` / `Five_Year_JIF` values of `<0.1` are stored as `0.05`; empty → `NULL`
- `Database` column in the integrated CSV is stored as `db_source` (SQL reserved word)
- `Merge_Status` / `Merge_Match_By` / `JCR_Year` / `Fenqu_No` columns in the integrated CSV are not ingested
- `journals_fts` / `medline_fts` are FTS5 virtual tables (trigram, case-insensitive) rebuilt at seed time; re-seeding must re-run the `rebuild` statements emitted by `scripts/seed.ts`
- `medline.journals_id` is computed at seed time via priority: Medline ISSN(Print) → journals.issn/eissn → Medline ISSN(Online) → journals.issn/eissn → upper(MedAbbr) → journals.qabbr. Re-seeding either the integrated CSV or `J_Medline.txt` regenerates these links.
- D1 database ID is in `wrangler.toml` — verify it before deploy
