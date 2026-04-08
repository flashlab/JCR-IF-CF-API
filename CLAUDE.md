# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project Overview

Cloudflare Worker + D1 API that serves Journal Citation Reports (JCR) 2024 data. ~20,449 journal records in a SQLite-backed D1 database, queried via a single GET endpoint.

Deployed at: `https://jcr-query-api.4cf.workers.dev/api/jcr`

## Commands

```bash
npm run dev              # Local dev server (wrangler dev)
npm run deploy           # Deploy Worker to Cloudflare
npm run seed:generate    # Parse 2024_JCR_full.txt → seed.sql
npm run seed:remote      # Generate+ apply seed to remote D1
npm run schema:remote    # Apply schema.sql to remote D1
npm run schema:local     # Apply schema.sql to local D1
npm run seed:local       # Generate+ apply seed to local D1
```

**Note:** `wrangler d1 execute --local`crashes on Windows due to a workerd runtime bug. Use `--remote` for testing, or test on macOS/Linux forlocal D1.

## Architecture

- **`src/index.ts`** —Single Worker entry point. Handles `GET /api/jcr` with query building, parameter validation, pagination. Allother routes return 404.
- **`schema.sql`** — D1 table definition (`journals`) with NOCASE indexes on name, abbr, group_name.
- **`scripts/seed.ts`** — Node script that reads `2024_JCR_full.txt` (TSV, 20,449 rows) and generates `seed.sql` with batched INSERTs (500 rows each).
- **`wrangler.toml`** — D1 binding `DB` →database `jcr-db`.

## API Query Logic

- **Default(`isAbbr=false`)**: Exact match on `name` or `abbr` (case insensitive via `UPPER()`)
- **`isAbbr=true`**: Fuzzy match (`LIKE %keyword%`) on `abbr` only
- **`|` in query string**: OR— each part searched separately
- Filters (`group`, `if_min`, `if_max`, `quartile`)are ANDed
- **`sortBy`**: `0`=name(default), `1`=if_2025, `2`=quartile, `3`=five_year_jif, `4`=abbr, `5`=group. `|` for combined sort (e.g. `sortBy=1|2`)
- **`order`**: `0`=ASC(default), `1`=DESC. Numericfields use `NULLS LAST`
- Results paginated with `LIMIT/OFFSET`

## Demo url

- /api/jcr?q=LANCET
- /api/jcr?q=LANCET%7CNATURE
- /api/jcr?q=CANCER&isAbbr=1&pageSize=3
- /api/jcr?q=lancet&if_min=50
- /api/jcr?q=nature&page=2&pageSize=5
- /api/jcr?q=REV&isAbbr=true&group=NATURE%20PORTFOLIO&pageSize=3
- /api/jcr?q=LANCET&sortBy=1&order=1
- /api/jcr?q=CANCER&isAbbr=1&sortBy=1|2&order=0

## Data Notes

- Source: `2024_JCR_full.txt` — tab-delimited, CRLF line endings
- `IF_2025` / `Five_Year_JIF` values of `<0.1` are stored as `0.05`; empty → `NULL`
- Some`Group` values are double-quoted with internal commas (handled by `stripQuotes` in seed script)
- D1 database ID is in `wrangler.toml` — do not commit placeholder values
