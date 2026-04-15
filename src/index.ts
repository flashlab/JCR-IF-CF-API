export interface Env {
  DB: D1Database;
}

const ISSN_RE = /^\d{4}-\d{3}[\dxX]$/;

// Cache TTL for successful responses (24h). Data refreshes yearly, so this is safe.
const CACHE_TTL_SECONDS = 86400;

// Trigram tokenizer needs ≥3 chars per MATCH token; shorter keywords fall back to LIKE.
const FTS_MIN_LEN = 3;

// Column projection strategy: we pull all output columns into jcr_hits so arm A
// reads the materialized CTE instead of re-reading journals. Three aligned lists
// per variant (default / show_all):
//   - CTE cols: `j.X AS c_X` — what jcr_hits materializes.
//   - JCR out:  `h.c_X AS X` + fenqu `f.X AS X` — arm A projection from (h, f).
//   - FQ  out:  NULL + `f.X AS X` — arm B projection with journals cols NULL.
// Prefix `c_` avoids FTS5 reserved-word collisions (notably `rank` under show_all)
// and disambiguates materialized copies from the base-table names. `qname` /
// `qabbr` are internal search mirrors; neither appears in output.

const JCR_CTE_COLS_DEFAULT =
  'j.qname AS _sortkey, ' +
  'j.name AS c_name, j.abbr AS c_abbr, j.jif_2024 AS c_jif_2024, j.jif_quartile AS c_jif_quartile';

const JCR_OUT_DEFAULT =
  'h._sortkey AS _sortkey, ' +
  'h.c_name AS name, h.c_abbr AS abbr, h.c_jif_2024 AS jif_2024, h.c_jif_quartile AS jif_quartile, ' +
  'f.fenqu AS fenqu, f.is_top AS is_top';

const FQ_OUT_DEFAULT =
  'f.qname AS _sortkey, ' +
  'f.name AS name, NULL AS abbr, NULL AS jif_2024, NULL AS jif_quartile, ' +
  'f.fenqu AS fenqu, f.is_top AS is_top';

const JCR_CTE_COLS_ALL =
  'j.qname AS _sortkey, ' +
  'j.rank AS c_rank, j.name AS c_name, j.abbr AS c_abbr, j.publisher AS c_publisher, ' +
  'j.issn AS c_issn, j.eissn AS c_eissn, ' +
  'j.total_cites AS c_total_cites, j.total_articles AS c_total_articles, j.citable_items AS c_citable_items, ' +
  'j.cited_half_life AS c_cited_half_life, j.citing_half_life AS c_citing_half_life, ' +
  'j.jif_2024 AS c_jif_2024, j.five_year_jif AS c_five_year_jif, ' +
  'j.jif_without_self_cites AS c_jif_without_self_cites, j.jci AS c_jci, ' +
  'j.jif_quartile AS c_jif_quartile, j.jif_rank AS c_jif_rank';

const JCR_OUT_ALL =
  'h._sortkey AS _sortkey, ' +
  'h.c_rank AS rank, h.c_name AS name, h.c_abbr AS abbr, h.c_publisher AS publisher, ' +
  'h.c_issn AS issn, h.c_eissn AS eissn, ' +
  'h.c_total_cites AS total_cites, h.c_total_articles AS total_articles, h.c_citable_items AS citable_items, ' +
  'h.c_cited_half_life AS cited_half_life, h.c_citing_half_life AS citing_half_life, ' +
  'h.c_jif_2024 AS jif_2024, h.c_five_year_jif AS five_year_jif, ' +
  'h.c_jif_without_self_cites AS jif_without_self_cites, h.c_jci AS jci, ' +
  'h.c_jif_quartile AS jif_quartile, h.c_jif_rank AS jif_rank, ' +
  'f.fenqu AS fenqu, f.is_top AS is_top, ' +
  'f.dalei_en AS dalei_en, f.dalei_zh AS dalei_zh, f.xiaolei_info AS xiaolei_info, ' +
  'f.db_source AS db_source, f.lang AS lang';

const FQ_OUT_ALL =
  'f.qname AS _sortkey, ' +
  'NULL AS rank, f.name AS name, NULL AS abbr, f.publisher AS publisher, ' +
  'f.issn AS issn, f.eissn AS eissn, ' +
  'NULL AS total_cites, NULL AS total_articles, NULL AS citable_items, ' +
  'NULL AS cited_half_life, NULL AS citing_half_life, ' +
  'NULL AS jif_2024, NULL AS five_year_jif, ' +
  'NULL AS jif_without_self_cites, NULL AS jci, ' +
  'NULL AS jif_quartile, NULL AS jif_rank, ' +
  'f.fenqu AS fenqu, f.is_top AS is_top, ' +
  'f.dalei_en AS dalei_en, f.dalei_zh AS dalei_zh, f.xiaolei_info AS xiaolei_info, ' +
  'f.db_source AS db_source, f.lang AS lang';

function jsonResponse(data: unknown, status = 200, extraHeaders: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: {
      'Content-Type': 'application/json',
      'Access-Control-Allow-Origin': '*',
      ...extraHeaders,
    },
  });
}

// LIKE metacharacters must be neutralized so literal `%` / `_` / `\` do not act as wildcards.
function escapeLike(s: string): string {
  return s.replace(/[\\%_]/g, '\\$&');
}

// FTS5 phrase: wrap in double quotes and escape embedded `"` by doubling.
// Trigram tokenizer treats punctuation as literal chars inside the phrase.
function ftsPhrase(kw: string): string {
  return `"${kw.replace(/"/g, '""')}"`;
}

// Half-open prefix upper bound so `col >= kw AND col < prefixUpperBound(kw)`
// is equivalent to `col LIKE kw || '%'` under BINARY collation — and, unlike
// LIKE with ESCAPE, lets SQLite do an index range scan on qname/qabbr.
function prefixUpperBound(kw: string): string {
  const last = kw.charCodeAt(kw.length - 1);
  if (last < 0xffff) {
    return kw.slice(0, -1) + String.fromCharCode(last + 1);
  }
  return kw + '\uffff';
}

// Each keyword lands in exactly one category per side:
//   - WherePart: a SQL predicate on j.* / f.* (ISSN, exact, prefix, LIKE-fallback).
//   - FtsPart:   an FTS5 MATCH phrase with optional per-keyword LIKE post-filter (f=3 suffix).
// Keeping them distinct lets the main assembler drive the FTS branch from
// `FROM journals_fts JOIN journals`, which is the only reliable way to pin the
// planner to an FTS-driven execution (an `IN (SELECT rowid FROM fts MATCH ?)`
// subquery was tried and regressed to a journals full scan — see CLAUDE.md).
type WherePart = { sql: string; bindings: unknown[] };
type FtsPart = { phrase: string; suffixSql: string | null; suffixBindings: unknown[] };
type KeywordMatch = {
  jcrWhere: WherePart | null;
  jcrFts: FtsPart | null;
  fenquWhere: WherePart | null;
  fenquFts: FtsPart | null;
};

// Name-mode column selector shared by exact / prefix / suffix paths.
function nameCols(isAbbr: string | null): string[] {
  if (isAbbr === 'true' || isAbbr === '1')  return ['qabbr'];
  if (isAbbr === 'false' || isAbbr === '0') return ['qname'];
  return ['qname', 'qabbr'];
}

// fenqu has no qabbr — is_abbr forcing abbr-only makes the fenqu arm vacuous.
function fenquNameEligible(isAbbr: string | null): boolean {
  return isAbbr !== 'true' && isAbbr !== '1';
}

function ftsColFilter(cols: string[]): string {
  return cols.length === 1 ? `{${cols[0]}}` : `{${cols.join(' ')}}`;
}

function emptyMatch(): KeywordMatch {
  return { jcrWhere: null, jcrFts: null, fenquWhere: null, fenquFts: null };
}

function buildKeywordMatch(
  kw: string,
  isAbbr: string | null,
  isEissn: string | null,
  f: string | null,
): KeywordMatch {
  // ── ISSN mode (exact) ───────────────────────────────────────────────
  if (ISSN_RE.test(kw)) {
    const out = emptyMatch();
    if (isEissn === 'true' || isEissn === '1') {
      out.jcrWhere   = { sql: 'j.eissn = ?', bindings: [kw] };
      out.fenquWhere = { sql: 'f.eissn = ?', bindings: [kw] };
    } else if (isEissn === 'false' || isEissn === '0') {
      out.jcrWhere   = { sql: 'j.issn = ?', bindings: [kw] };
      out.fenquWhere = { sql: 'f.issn = ?', bindings: [kw] };
    } else {
      out.jcrWhere   = { sql: '(j.issn = ? OR j.eissn = ?)', bindings: [kw, kw] };
      out.fenquWhere = { sql: '(f.issn = ? OR f.eissn = ?)', bindings: [kw, kw] };
    }
    return out;
  }

  // ── Name mode ───────────────────────────────────────────────────────
  const fqOk = fenquNameEligible(isAbbr);
  const cols = nameCols(isAbbr);
  const out = emptyMatch();

  // Substring (f=2) / suffix (f=3): FTS5 trigram, with LIKE post-filter for suffix.
  // Short keywords (<3 chars) can't be tokenized as trigrams — fall back to LIKE scan.
  const useFts = (f === '2' || f === '3') && kw.length >= FTS_MIN_LEN;

  if (useFts) {
    const phrase = ftsPhrase(kw);
    const jcrPhrase = `${ftsColFilter(cols)}: ${phrase}`;

    let jcrSuffixSql: string | null = null;
    const jcrSuffixBindings: unknown[] = [];
    if (f === '3') {
      const pat = `%${escapeLike(kw)}`;
      const parts = cols.map(c => `j.${c} LIKE ? ESCAPE '\\'`);
      jcrSuffixSql = parts.length === 1 ? parts[0] : `(${parts.join(' OR ')})`;
      for (const _ of cols) jcrSuffixBindings.push(pat);
    }
    out.jcrFts = { phrase: jcrPhrase, suffixSql: jcrSuffixSql, suffixBindings: jcrSuffixBindings };

    if (fqOk) {
      let fqSuffixSql: string | null = null;
      const fqSuffixBindings: unknown[] = [];
      if (f === '3') {
        fqSuffixSql = `f.qname LIKE ? ESCAPE '\\'`;
        fqSuffixBindings.push(`%${escapeLike(kw)}`);
      }
      out.fenquFts = { phrase: `{qname}: ${phrase}`, suffixSql: fqSuffixSql, suffixBindings: fqSuffixBindings };
    }
    return out;
  }

  // Prefix (f=1) — half-open range scan. Must not use LIKE ESCAPE: SQLite disables
  // the LIKE→range-scan optimization whenever ESCAPE is present, turning a B-tree
  // lookup into a full scan of every indexed column.
  if (f === '1') {
    const hi = prefixUpperBound(kw);
    const parts = cols.map(c => `(j.${c} >= ? AND j.${c} < ?)`);
    const jcrSql = parts.length === 1 ? parts[0] : `(${parts.join(' OR ')})`;
    const jcrBindings: unknown[] = [];
    for (const _ of cols) jcrBindings.push(kw, hi);
    out.jcrWhere = { sql: jcrSql, bindings: jcrBindings };

    if (fqOk) {
      out.fenquWhere = { sql: `(f.qname >= ? AND f.qname < ?)`, bindings: [kw, hi] };
    }
    return out;
  }

  // LIKE fallbacks — substring (f=2) / suffix (f=3) for sub-3-char keywords where
  // the FTS5 trigram tokenizer can't produce tokens. Leading `%` prevents any
  // index prefix use here, so ESCAPE is safe (no optimization to lose).
  let pat: string | null = null;
  if (f === '2') pat = `%${escapeLike(kw)}%`;
  else if (f === '3') pat = `%${escapeLike(kw)}`;

  if (pat !== null) {
    const parts = cols.map(c => `j.${c} LIKE ? ESCAPE '\\'`);
    const jcrSql = parts.length === 1 ? parts[0] : `(${parts.join(' OR ')})`;
    const jcrBindings: unknown[] = cols.map(() => pat);
    out.jcrWhere = { sql: jcrSql, bindings: jcrBindings };

    if (fqOk) {
      out.fenquWhere = { sql: `f.qname LIKE ? ESCAPE '\\'`, bindings: [pat] };
    }
    return out;
  }

  // Exact
  const parts = cols.map(c => `j.${c} = ?`);
  const jcrSql = parts.length === 1 ? parts[0] : `(${parts.join(' OR ')})`;
  const jcrBindings: unknown[] = cols.map(() => kw);
  out.jcrWhere = { sql: jcrSql, bindings: jcrBindings };

  if (fqOk) {
    out.fenquWhere = { sql: `f.qname = ?`, bindings: [kw] };
  }
  return out;
}

function combineWheres(parts: WherePart[]): WherePart | null {
  if (parts.length === 0) return null;
  const sqls = parts.map(p => p.sql);
  const bindings: unknown[] = [];
  for (const p of parts) bindings.push(...p.bindings);
  return {
    sql: sqls.length === 1 ? sqls[0] : `(${sqls.join(' OR ')})`,
    bindings,
  };
}

// FTS5 OR-combines multiple MATCH phrases inside a single MATCH expression —
// `{cols}: "a" OR {cols}: "b"` matches any row containing either phrase. Suffix
// post-filters (f=3) OR-combine at the SQL level: any row whose chosen column
// ends with any of the keywords. FTS index handles the prefix-narrowing; the
// LIKE filter tightens it to true suffixes.
//
// The returned `matchPredicate` uses the unaliased FTS table name (MATCH's
// left-hand side is technically a hidden table-name column reference in FTS5,
// and SQLite's docs only document the unaliased form). The assembler writes
// `FROM <ftsTable> JOIN <base> b ON b.id = <ftsTable>.rowid WHERE ...` so the
// FTS table is never aliased.
function combineFts(
  parts: FtsPart[],
  ftsTable: 'journals_fts' | 'fenqu_fts',
): { matchPredicate: string; bindings: unknown[] } | null {
  if (parts.length === 0) return null;
  const combinedPhrase = parts.map(p => p.phrase).join(' OR ');
  const bindings: unknown[] = [combinedPhrase];
  let matchPredicate = `${ftsTable} MATCH ?`;

  const suffixClauses: string[] = [];
  for (const p of parts) {
    if (p.suffixSql) {
      suffixClauses.push(`(${p.suffixSql})`);
      bindings.push(...p.suffixBindings);
    }
  }
  if (suffixClauses.length > 0) {
    const sfx = suffixClauses.length === 1 ? suffixClauses[0] : `(${suffixClauses.join(' OR ')})`;
    matchPredicate += ` AND ${sfx}`;
  }
  return { matchPredicate, bindings };
}

export default {
  async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    const url = new URL(request.url);

    if (url.pathname !== '/api/jcr') {
      return jsonResponse({ error: 'Not found' }, 404);
    }

    if (request.method === 'OPTIONS') {
      return new Response(null, {
        headers: {
          'Access-Control-Allow-Origin': '*',
          'Access-Control-Allow-Methods': 'GET, OPTIONS',
          'Access-Control-Allow-Headers': 'Content-Type',
        },
      });
    }

    if (request.method !== 'GET') {
      return jsonResponse({ error: 'Method not allowed' }, 405);
    }

    // ── Cache lookup ──────────────────────────────────────────────────────
    const cache = caches.default;
    const cacheKey = new Request(url.toString(), { method: 'GET' });
    const cached = await cache.match(cacheKey);
    if (cached) return cached;

    try {
      const params = url.searchParams;
      const q = params.get('q');
      if (!q) {
        return jsonResponse({ error: 'Missing required parameter: q' }, 400);
      }

      const isAbbr  = params.get('is_abbr');
      const isEissn = params.get('is_eissn');
      const f       = params.get('f');
      const showAll = params.get('show_all') === '1';
      const page    = Math.max(1, parseInt(params.get('page') ?? '1', 10) || 1);
      const pageSize = Math.min(100, Math.max(1, parseInt(params.get('page_size') ?? '20', 10) || 20));

      const keywords = q.split('|').map(k => k.trim().toUpperCase()).filter(k => k.length > 0);
      if (keywords.length === 0) {
        return jsonResponse({ error: 'Empty query' }, 400);
      }

      const offset = (page - 1) * pageSize;

      const jcrWheres: WherePart[] = [];
      const jcrFtses:  FtsPart[]   = [];
      const fqWheres:  WherePart[] = [];
      const fqFtses:   FtsPart[]   = [];
      for (const kw of keywords) {
        const m = buildKeywordMatch(kw, isAbbr, isEissn, f);
        if (m.jcrWhere)   jcrWheres.push(m.jcrWhere);
        if (m.jcrFts)     jcrFtses.push(m.jcrFts);
        if (m.fenquWhere) fqWheres.push(m.fenquWhere);
        if (m.fenquFts)   fqFtses.push(m.fenquFts);
      }

      const jcrCteCols = showAll ? JCR_CTE_COLS_ALL : JCR_CTE_COLS_DEFAULT;
      const jcrOut     = showAll ? JCR_OUT_ALL      : JCR_OUT_DEFAULT;
      const fqOut      = showAll ? FQ_OUT_ALL       : FQ_OUT_DEFAULT;

      // ── Build jcr_hits CTE body ─────────────────────────────────────────
      // FTS and non-FTS keywords produce structurally different FROM clauses, so
      // we emit each as its own SELECT and UNION them when both are present.
      // Using UNION (not UNION ALL) dedupes the rare mixed case where the same
      // journal matches both an ISSN lookup and an FTS substring hit.
      const jcrSubs: string[] = [];
      const jcrBindings: unknown[] = [];

      const jcrFtsCombined = combineFts(jcrFtses, 'journals_fts');
      if (jcrFtsCombined) {
        jcrSubs.push(
          `SELECT j.id AS j_id, j.fenqu_id AS f_link, ${jcrCteCols}
     FROM journals_fts JOIN journals j ON j.id = journals_fts.rowid
     WHERE ${jcrFtsCombined.matchPredicate}`
        );
        jcrBindings.push(...jcrFtsCombined.bindings);
      }
      const jcrWhereCombined = combineWheres(jcrWheres);
      if (jcrWhereCombined) {
        jcrSubs.push(
          `SELECT j.id AS j_id, j.fenqu_id AS f_link, ${jcrCteCols}
     FROM journals j WHERE ${jcrWhereCombined.sql}`
        );
        jcrBindings.push(...jcrWhereCombined.bindings);
      }
      // Every keyword always produces a jcr part (ISSN / name both match j.*),
      // so jcrSubs is non-empty in practice. Guard anyway with a never-matches
      // sentinel so the CTE remains structurally valid.
      const jcrCteBody = jcrSubs.length > 0
        ? jcrSubs.join('\n  UNION\n  ')
        : `SELECT NULL AS j_id, NULL AS f_link, ${jcrCteCols.replace(/j\.\w+/g, 'NULL')} WHERE 0`;

      // ── Build fenqu arm ─────────────────────────────────────────────────
      // Same FTS / where split. Each sub-arm filters out journals-linked rows
      // via `NOT IN jcr_hits.f_link` to preserve the dedup guarantee. We store
      // just the FROM+WHERE bodies so the count-fallback path can reuse them
      // with a COUNT(*) projection instead of the full output column list.
      const ANTI_JOIN = `f.id NOT IN (SELECT f_link FROM jcr_hits WHERE f_link IS NOT NULL)`;
      const fqBodies: string[] = [];
      const fqBindings: unknown[] = [];

      const fqFtsCombined = combineFts(fqFtses, 'fenqu_fts');
      if (fqFtsCombined) {
        fqBodies.push(
          `FROM fenqu_fts JOIN fenqu f ON f.id = fenqu_fts.rowid
     WHERE ${fqFtsCombined.matchPredicate} AND ${ANTI_JOIN}`
        );
        fqBindings.push(...fqFtsCombined.bindings);
      }
      const fqWhereCombined = combineWheres(fqWheres);
      if (fqWhereCombined) {
        fqBodies.push(
          `FROM fenqu f WHERE ${fqWhereCombined.sql} AND ${ANTI_JOIN}`
        );
        fqBindings.push(...fqWhereCombined.bindings);
      }

      // fenqu arm may be empty (e.g. is_abbr=1 strips the fenqu side entirely).
      // In that case the merged CTE is just arm A, no UNION ALL needed.
      const buildFenquArm = (projection: string): string =>
        fqBodies.length === 0
          ? ''
          : '\n  UNION ALL\n  ' +
            fqBodies
              .map(body => `SELECT ${projection} ${body}`)
              .join('\n  UNION\n  ');

      const sql =
`WITH jcr_hits AS MATERIALIZED (
  ${jcrCteBody}
),
merged AS (
  SELECT 0 AS _src, ${jcrOut}
  FROM jcr_hits h
  LEFT JOIN fenqu f ON f.id = h.f_link${buildFenquArm(`1 AS _src, ${fqOut}`)}
)
SELECT *, COUNT(*) OVER() AS _total
FROM merged
ORDER BY _src ASC, _sortkey ASC
LIMIT ? OFFSET ?`;

      const bindings: unknown[] = [
        ...jcrBindings,
        ...fqBindings,
        pageSize,
        offset,
      ];

      const { results } = await env.DB
        .prepare(sql)
        .bind(...bindings)
        .all<Record<string, unknown>>();

      const rows = results ?? [];
      let total = rows.length > 0 ? Number(rows[0]._total ?? 0) : 0;

      // Page-beyond-last returns 0 rows, losing COUNT(*) OVER(). Re-run the
      // same CTE shape with a COUNT(*) projection — keeps the hot path a
      // single round-trip and guarantees the count reflects the merged
      // semantics (UNION-dedup in the fenqu arm, anti-join for journals).
      if (rows.length === 0 && page > 1) {
        const countSql =
`WITH jcr_hits AS MATERIALIZED (
  ${jcrCteBody}
),
merged AS (
  SELECT 0 AS _src, h.j_id AS _id FROM jcr_hits h${buildFenquArm(`1 AS _src, f.id AS _id`)}
)
SELECT COUNT(*) AS total FROM merged`;
        const countBindings: unknown[] = [
          ...jcrBindings,
          ...fqBindings,
        ];
        const countRow = await env.DB
          .prepare(countSql)
          .bind(...countBindings)
          .first<{ total: number }>();
        total = countRow?.total ?? 0;
      }

      const data = rows.map(r => {
        const clean: Record<string, unknown> = {};
        for (const k of Object.keys(r)) {
          if (k === '_src' || k === '_sortkey' || k === '_total') continue;
          clean[k] = r[k];
        }
        return clean;
      });

      const response = jsonResponse({
        query: q,
        data,
        total,
        page,
        page_size: pageSize,
        total_pages: Math.ceil(total / pageSize),
      }, 200, {
        'Cache-Control': `public, max-age=${CACHE_TTL_SECONDS}, s-maxage=${CACHE_TTL_SECONDS}`,
      });
      ctx.waitUntil(cache.put(cacheKey, response.clone()));
      return response;
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : 'Unknown error';
      return jsonResponse({ error: message }, 500);
    }
  },
};
