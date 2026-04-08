# JCR Query API

Cloudflare Worker + D1 API serving **Journal Citation Reports (JCR) 2024** data — ~20,449 journal records queryable via a single GET endpoint.

**Base URL:** `https://??.workers.dev/api/jcr`

## Quick Start

```bash
npm install
npm run dev       # Local dev server
npm run deploy    # Deploy to Cloudflare
```

## API Reference

### `GET /api/jcr`

#### Query Parameters

| Parameter | Required | Description |
|-----------|----------|-------------|
| `q` | Yes | Search keyword. Use `\|` to OR multiple terms (e.g. `LANCET\|NATURE`)|
| `isAbbr` | No | `true`/`1`: fuzzy match on `abbr` only. `false`/`0`: fuzzy match on `name`. Omit:exact match on both `name` and `abbr` |
| `group` | No | Filter by groupname (case insensitive) |
| `if_min` | No |Minimum Impact Factor (IF 2025) |
| `if_max` | No | Maximum Impact Factor (IF 2025) |
| `quartile` | No | Filter by quartile (`1`–`4`, maps to Q1–Q4) |
| `sortBy` | No | Sort field: `0`=name *(default)*,`1`=if_2025, `2`=quartile, `3`=five_year_jif, `4`=abbr, `5`=group. Use `\|` formulti-field sort (e.g. `sortBy=1\|2`) |
| `order` | No | `0`=ASC *(default)*, `1`=DESC.Numeric fields use `NULLS LAST` |
| `page` | No | Page number (default: `1`) |
| `pageSize` | No | Results per page,1–100 (default: `20`) |

#### Response

```json
{
  "data": [
    {
      "name": "LANCET",
      "abbr": "LANCET",
      "group": "ELSEVIER",
      "issn": "0140-6736",
      "eissn": "1474-547X",
      "if_2025": 98.4,
      "five_year_jif": 75.3,
      "quartile": "Q1",
      "jif_rank": "1/312"
    }
  ],
  "total": 1,
  "page":1,
  "pageSize": 20,
  "totalPages": 1
}
```

#### Examples

```
# Exact match
/api/jcr?q=LANCET

# OR search
/api/jcr?q=LANCET|NATURE

# Fuzzy abbreviation search
/api/jcr?q=CANCER&isAbbr=1&pageSize=3

# IF filter
/api/jcr?q=lancet&if_min=50

#Pagination
/api/jcr?q=nature&page=2&pageSize=5

# Group filter
/api/jcr?q=REV&isAbbr=true&group=NATURE%20PORTFOLIO&pageSize=3

# Sort by IF descending
/api/jcr?q=LANCET&sortBy=1&order=1

# Multi-field sort: IF then quartile, ascending
/api/jcr?q=CANCER&isAbbr=1&sortBy=1|2&order=0
```

## Architecture

```
src/index.ts       → Worker entry point (query building, validation, pagination)
schema.sql→ D1 table definition with NOCASE indexes
scripts/seed.ts    → Parses 2024_JCR_full.txt (TSV) → seed.sql
wrangler.toml      → D1 binding configuration
```

## Data Notes

- Source: `2024_JCR_full.txt` — tab-delimited,20,449 rows
- `IF_2025` / `Five_Year_JIF`: values `<0.1` stored as `0.05`; empty → `NULL`
- Some `Group` values containcommas (double-quoted in source, handled by seed script)

## Database Commands

```bash
npm run schema:remote    # Apply schema to remote D1
npm run seed:remote      # Generate + apply seed to remote D1
npm run schema:local     #Apply schema to local D1
npm run seed:local       # Generate + apply seed to local D1
npm run seed:generate    #Generate seed.sql only
```

> **Note:** `wrangler d1 execute --local` crashes on Windows (workerd bug). Use `--remote` or test on macOS/Linux.
