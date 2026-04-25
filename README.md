# JCR Query API

Cloudflare Worker + D1 API serving **Journal Citation Reports (JCR) 2024**, **Chinese Fenqu 2026** grading data, and an **NLM Medline alias fallback** — ~22,440 merged main-table rows plus ~35,398 medline alias records, queryable via a single GET endpoint.

**Base URL:** `https://jcr-query-api.4cf.workers.dev/api/jcr`

## Quick Start

```bash
npm install
npm run dev            # Local dev server
npm run deploy         # Deploy to Cloudflare
```

## API Reference

### `GET /api/jcr`

#### Query Parameters

| Parameter | Required | Description |
|-----------|----------|-------------|
| `q` | Yes | Search keyword. Use `\|` to OR multiple terms (e.g. `LANCET\|NATURE`). If keyword matches `^\d{4}-\d{3}[\dxX]$`, searches ISSN/EISSN; otherwise searches Name/Abbr. At least 3 chars each keyword. |
| `is_eissn` | No | ISSN-mode only. `true`/`1`: match EISSN only. `false`/`0`: match ISSN only. Omit: match both. |
| `is_abbr` | No | Name/Abbr-mode only — selects which column to search. `0`/`false`: `qname` only. `1`/`true`: `qabbr` only. Omit: both. Applies symmetrically to main table and medline fallback. |
| `is_med` | No | Dispatch selector. `1`/`true`: skip the main table and search medline directly. Omit/`0`: search main first; if no hits on `page=1`, fall back to medline automatically. |
| `f` | No | Name/Abbr-mode only — fuzzy pattern. Omit: exact equality. **`1`: `kw%` (prefix, B-tree index).** **`2`: `%kw%` (substring, FTS5 trigram index).** **`3`: `%kw` (suffix, FTS5 trigram + LIKE post-filter).** Literal `%` / `_` / `\` inside `q` are escaped; `"` is doubled for FTS phrases. |
| `show_all` | No | `0` *(default)*: return name, abbr, jif_2024, jif_quartile, fenqu, is_top. `1`: return all fields from `journals` + `nlm_id` from medline path. On the medline path, orphan records (no `journals_id` link) are dropped when `show_all=0` and returned when `show_all=1`. Internal `qname` / `qabbr` mirror columns are never exposed. |
| `case` | No | Output case for `name` (and `abbr` unless `case_abbr` overrides). `0` *(default)*: original. `1`: all lower. `2`: first word upper. `3`: title case. `4`: ALL UPPER. |
| `case_abbr` | No | Output case for `abbr` only — same values as `case`. If omitted, `abbr` follows `case`. |
| `page` | No | Page number (default: `1`) |
| `page_size` | No | Results per page, 1–100 (default: `20`) |

#### Search Logic (Single table + medline fallback)

1. Each keyword (split by `|`) is individually classified: ISSN format → ISSN mode; otherwise → Name/Abbr mode.
2. Keywords are uppercased once; queries hit internal `qname` / `qabbr` columns (pre-uppercased, indexed) or the `journals_fts` / `medline_fts` trigram indexes for substring / suffix fuzzy. API responses return the original-case `name` / `abbr`.
3. Dispatch:
   - `is_med=1` → search `medline` only.
   - Otherwise → search `journals`. If `total=0` on `page=1`, run a second query on `medline` as alias fallback.
4. Medline fallback rows LEFT-JOIN `journals` via the precomputed `journals_id` and return the journals columns. Multiple medline aliases pointing to the same `journals_id` are deduped (`MIN(m_id) GROUP BY journals_id`).
5. Orphan medline rows (`journals_id IS NULL`) are returned only when `show_all=1` — their `name`/`abbr`/`issn`/`eissn` come from the medline row and JCR/Fenqu-specific fields are `NULL`; `nlm_id` is always set.
6. Rows are ordered by uppercased name. Total count comes from `COUNT(*) OVER()` in the same round-trip.

Responses are cached for 24h at both the browser (`Cache-Control: public, max-age=86400`) and the Cloudflare edge (`s-maxage`, `caches.default`), so repeat queries do not hit D1.

#### Response

```json
{
  "query": "lancet",
  "data": [
    {
      "name": "LANCET",
      "abbr": "LANCET",
      "jif_2024": 98.4,
      "jif_quartile": "Q1",
      "fenqu": "1 区",
      "is_top": "Top"
    }
  ],
  "total": 1,
  "med_hit": false,
  "page": 1,
  "page_size": 20,
  "total_pages": 1
}
```

`med_hit` is `true` iff the medline query actually executed and matched ≥ 1 row anywhere in medline — **including orphan rows** that `show_all=0` would otherwise hide from `data`. So `med_hit=true` with `total=0` is a valid combination: it tells you the keyword matched an NLM-only record that you can surface by re-querying with `show_all=1`. `false` when the main `journals` table satisfied the query, or when medline ran but matched nothing.

For medline-orphan rows returned under `show_all=1`, JCR/Fenqu-derived fields are `null` and `nlm_id` is populated.

#### Examples

```
# Exact name match (default: f omitted → equality)
/api/jcr?q=LANCET

# OR search
/api/jcr?q=LANCET|NATURE

# ISSN search (auto-detected)
/api/jcr?q=0140-6736

# ISSN-only (exclude EISSN)
/api/jcr?q=0140-6736&is_eissn=0

# Prefix search on abbr only (fast, B-tree index)
/api/jcr?q=CANC&is_abbr=1&f=1&page_size=3

# Substring search across name and abbr (FTS5 trigram)
/api/jcr?q=CANCER&f=2

# Suffix search (FTS5 trigram + LIKE post-filter)
/api/jcr?q=LOGY&f=3

# All fields (JCR + Fenqu + nlm_id)
/api/jcr?q=LANCET&show_all=1

# Main 0 hits → medline alias fallback
/api/jcr?q=NATURE%20REVIEWS.%20MICROBIOLOGY

# Skip main, search medline directly
/api/jcr?q=NATURE%20REVIEWS.%20MICROBIOLOGY&is_med=1

# Orphan NLM record (no journals link) — returned only with show_all=1
/api/jcr?q=<nlm-orphan-title>&show_all=1

# Pagination
/api/jcr?q=nature&page=2&page_size=5

# Output case formatting
/api/jcr?q=LANCET&case=1                  # name + abbr all lowercase
/api/jcr?q=LANCET&case=3                  # name + abbr title case
/api/jcr?q=LANCET&case=1&case_abbr=4      # name lowercase, abbr ALL UPPER
```

## Architecture

```
src/index.ts        → Worker entry point (single-table search, medline fallback dispatch, pagination, FTS routing)
schema.sql          → D1 tables: journals (flat) + medline + journals_fts + medline_fts (FTS5 trigram)
scripts/seed.ts     → Parses Clinicalscientists_JIF2024_integrated_Fenqu_2026.csv + J_Medline.txt → seed.sql (+ FTS rebuild)
wrangler.toml       → D1 binding configuration
```

## Data Notes

- ISSN and EISSN stored as UPPERCASE in both tables
- Each table carries `qname` (and `qabbr`) — uppercase mirrors of the original `name` / `abbr`, used as the actual search targets. Original-case `name` / `abbr` are preserved for display; `qname` / `qabbr` are never returned by the API.
- CSV cells equal to `N/A` (case-insensitive) are normalized to empty string during seed
- `JIF_2024` / `Five_Year_JIF`: values `<0.1` stored as `0.05`; empty → `NULL`
- The integrated CSV's `Database` column is stored as `db_source` (SQL reserved word); its `JCR_Year`, `Fenqu_No`, `Merge_Status`, and `Merge_Match_By` columns are not ingested
- `journals_fts` / `medline_fts` are FTS5 trigram virtual tables rebuilt at seed time; any re-seed must re-run the `rebuild` statements appended to `seed.sql`
- `medline.journals_id` is computed at seed time via priority: Medline ISSN(Print) → journals.issn/eissn → Medline ISSN(Online) → journals.issn/eissn → upper(MedAbbr) → journals.qabbr. Re-seeding either input regenerates these links.
- For copyright consideration, the raw csv/txt file database is not public.

## Database Commands

```bash
npm run schema:remote    # Apply schema to remote D1
npm run seed:remote      # Generate + apply seed to remote D1
npm run schema:local     # Apply schema to local D1
npm run seed:local       # Generate + apply seed to local D1
npm run seed:generate    # Generate seed.sql only
```

> **Note:** `wrangler d1 execute --local` crashes on Windows (workerd bug). Use `--remote` or test on macOS/Linux.
