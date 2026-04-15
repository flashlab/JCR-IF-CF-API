# JCR Query API

Cloudflare Worker + D1 API serving **Journal Citation Reports (JCR) 2024** and **Chinese Fenqu 2026** journal grading data — ~20,449 JCR records and ~22,297 Fenqu entries queryable via a single GET endpoint.

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
| `q` | Yes | Search keyword. Use `\|` to OR multiple terms (e.g. `LANCET\|NATURE`). If keyword matches `^\d{4}-\d{3}[\dxX]$`, searches ISSN/EISSN; otherwise searches Name/Abbr. |
| `is_eissn` | No | ISSN-mode only. `true`/`1`: match EISSN only. `false`/`0`: match ISSN only. Omit: match both. |
| `is_abbr` | No | Name/Abbr-mode only — selects which column to search. `0`/`false`: `name` only. `1`/`true`: `abbr` only. Omit: both `name` and `abbr`. `is_abbr=1` narrows the match to journals (fenqu has no `abbr`). |
| `f` | No | Name/Abbr-mode only — fuzzy pattern. Omit: exact equality. **`1`: `kw%` (prefix, B-tree index).** **`2`: `%kw%` (substring, FTS5 trigram index).** **`3`: `%kw` (suffix, FTS5 trigram + LIKE post-filter).** Keywords shorter than 3 chars on `f=2`/`f=3` fall back to LIKE scan. Literal `%` / `_` / `\` inside `q` are escaped; `"` is doubled for FTS phrases. |
| `show_all` | No | `0` *(default)*: return name, abbr, jif_2024, jif_quartile, fenqu, is_top. `1`: return all fields from both tables. Internal `qname` / `qabbr` mirror columns are never exposed. |
| `page` | No | Page number (default: `1`) |
| `page_size` | No | Results per page, 1–100 (default: `20`) |

#### Search Logic (Full Outer Join)

1. Each keyword (split by `|`) is individually classified: ISSN format → ISSN mode; otherwise → Name/Abbr mode.
2. Keywords are uppercased once; queries hit internal `qname` / `qabbr` columns (pre-uppercased, indexed) or the `journals_fts` / `fenqu_fts` trigram indexes for substring / suffix fuzzy. API responses return the original-case `name` / `abbr`.
3. A single CTE query returns the **full outer join** of both tables:
   - **Journals arm**: every journals row matching the query, LEFT JOINed with its best-matching fenqu row (priority: ISSN → EISSN → qname).
   - **Fenqu-only arm**: every fenqu row matching the query whose id is not already linked by a matched journal (deduped).
4. Rows are ordered journals-first, then by uppercased name. Total count comes from `COUNT(*) OVER()` in the same round-trip.
5. The response no longer carries a top-level `source` field — each row's origin is inferable from which columns are populated (journals-only fields are `null` on fenqu-only rows; fenqu-only fields are `null` on journals rows with no enrichment).

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
  "page": 1,
  "page_size": 20,
  "total_pages": 1
}
```

For fenqu-only rows, journals-derived fields (`abbr`, `jif_2024`, `jif_quartile`, etc.) are `null`. For journals rows without a matching fenqu entry, fenqu-derived fields (`fenqu`, `is_top`, …) are `null`.

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

# All fields (JCR + Fenqu)
/api/jcr?q=LANCET&show_all=1

# Pagination
/api/jcr?q=nature&page=2&page_size=5
```

## Architecture

```
src/index.ts        → Worker entry point (search, full-outer-join merge, pagination, FTS routing)
schema.sql          → D1 tables: journals + fenqu + journals_fts + fenqu_fts (FTS5 trigram)
scripts/seed.ts     → Parses Clinicalscientists_JIF2024.csv + Fenqu_2026.csv → seed.sql (+ FTS rebuild)
wrangler.toml       → D1 binding configuration
```

## Data Notes

- ISSN and EISSN stored as UPPERCASE in both tables
- Each table carries `qname` (and `qabbr` on journals) — uppercase mirrors of the original `name` / `abbr`, used as the actual search targets. Original-case `name` / `abbr` are preserved for display; `qname` / `qabbr` are never returned by the API.
- CSV cells equal to `N/A` (case-insensitive) are normalized to empty string during seed
- `JIF_2024` / `Five_Year_JIF`: values `<0.1` stored as `0.05`; empty → `NULL`
- Fenqu `Database` column renamed to `db_source` (SQL reserved word)
- `journals_fts` / `fenqu_fts` are FTS5 trigram virtual tables rebuilt at seed time; any re-seed must re-run the `rebuild` statements appended to `seed.sql`
- For copyright consideration, the raw csv file database is not public.

## Database Commands

```bash
npm run schema:remote    # Apply schema to remote D1
npm run seed:remote      # Generate + apply seed to remote D1
npm run schema:local     # Apply schema to local D1
npm run seed:local       # Generate + apply seed to local D1
npm run seed:generate    # Generate seed.sql only
```

> **Note:** `wrangler d1 execute --local` crashes on Windows (workerd bug). Use `--remote` or test on macOS/Linux.
