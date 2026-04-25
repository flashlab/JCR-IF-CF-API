export interface Env {
  DB: D1Database;
}

const ISSN_RE = /^\d{4}-\d{3}[\dxX]$/;

// Cache TTL for successful responses (24h). Data refreshes yearly, so this is safe.
const CACHE_TTL_SECONDS = 86400;

// Legal characters in query keywords (post-uppercase). Derived from actual name/abbr
// values across JCR / Fenqu / Medline. Anything outside this set is silently stripped.
const ILLEGAL_CHARS_RE = /[^A-Z0-9 &'()+,\-./:]/g;

// Output column lists — parallel between main (journals-sourced) and medline
// (medline-sourced, LEFT-JOINed to journals via journals_id). Both paths produce
// the same column shape so the Worker merges them transparently.

// Default projection: name, abbr, jif_2024, jif_quartile, fenqu, is_top + nlm_id (NULL on main).
// `_sortkey` drives ORDER BY; `_src` separates main-direct rows from medline-mapped rows.

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

// Output case transformation for name / abbr fields.
// 0 = original, 1 = lower, 2 = first-word upper, 3 = title case, 4 = UPPER.
function transformCase(s: string | null, mode: number): string | null {
  if (s == null || mode === 0) return s;
  switch (mode) {
    case 1: return s.toLowerCase();
    case 2: { const low = s.toLowerCase(); return low.charAt(0).toUpperCase() + low.slice(1); }
    case 3: return s.toLowerCase().replace(/\b\w/g, c => c.toUpperCase());
    case 4: return s.toUpperCase();
    default: return s;
  }
}

// Half-open prefix upper bound so `col >= kw AND col < prefixUpperBound(kw)`
// is equivalent to `col LIKE kw || '%'` under BINARY collation — and, unlike
// LIKE with ESCAPE, lets SQLite do an index range scan on qname/qabbr.
function prefixUpperBound(kw: string): string {
  const last = kw.charCodeAt(kw.length - 1);
  if (last < 0xffff) {
    return kw.slice(0, -1) + String.fromCharCode(last + 1);
  }
  return kw + '￿';
}

type WherePart = { sql: string; bindings: unknown[] };
type FtsPart   = { phrase: string; suffixSql: string | null; suffixBindings: unknown[] };
type Match     = { where: WherePart | null; fts: FtsPart | null };

function nameCols(isAbbr: string | null): string[] {
  if (isAbbr === 'true' || isAbbr === '1')  return ['qabbr'];
  if (isAbbr === 'false' || isAbbr === '0') return ['qname'];
  return ['qname', 'qabbr'];
}

function ftsColFilter(cols: string[]): string {
  return cols.length === 1 ? `{${cols[0]}}` : `{${cols.join(' ')}}`;
}

// Build match fragments for a single keyword against ONE table (journals or medline).
// `tblAlias` is the SQL alias used in the caller's FROM clause (always single-letter so
// substitutions stay stable). ISSN mode is table-agnostic — both journals and medline
// have issn/eissn columns with identical semantics.
function buildKeywordMatch(
  kw: string,
  tblAlias: string,
  isAbbr: string | null,
  isEissn: string | null,
  f: string | null,
): Match {
  // ── ISSN mode ───────────────────────────────────────────────────────
  if (ISSN_RE.test(kw)) {
    if (isEissn === 'true' || isEissn === '1') {
      return { where: { sql: `${tblAlias}.eissn = ?`, bindings: [kw] }, fts: null };
    }
    if (isEissn === 'false' || isEissn === '0') {
      return { where: { sql: `${tblAlias}.issn = ?`, bindings: [kw] }, fts: null };
    }
    return { where: { sql: `(${tblAlias}.issn = ? OR ${tblAlias}.eissn = ?)`, bindings: [kw, kw] }, fts: null };
  }

  // ── Name / Abbr mode ────────────────────────────────────────────────
  const cols = nameCols(isAbbr);

  // Substring (f=2) / suffix (f=3): FTS5 trigram, optional LIKE post-filter for suffix.
  if (f === '2' || f === '3') {
    const phrase = `${ftsColFilter(cols)}: ${ftsPhrase(kw)}`;
    let suffixSql: string | null = null;
    const suffixBindings: unknown[] = [];
    if (f === '3') {
      const pat = `%${escapeLike(kw)}`;
      const parts = cols.map(c => `${tblAlias}.${c} LIKE ? ESCAPE '\\'`);
      suffixSql = parts.length === 1 ? parts[0] : `(${parts.join(' OR ')})`;
      for (const _ of cols) suffixBindings.push(pat);
    }
    return { where: null, fts: { phrase, suffixSql, suffixBindings } };
  }

  // Prefix (f=1) — half-open range scan so SQLite keeps the B-tree range plan.
  if (f === '1') {
    const hi = prefixUpperBound(kw);
    const parts = cols.map(c => `(${tblAlias}.${c} >= ? AND ${tblAlias}.${c} < ?)`);
    const sql = parts.length === 1 ? parts[0] : `(${parts.join(' OR ')})`;
    const bindings: unknown[] = [];
    for (const _ of cols) bindings.push(kw, hi);
    return { where: { sql, bindings }, fts: null };
  }

  // Exact
  const parts = cols.map(c => `${tblAlias}.${c} = ?`);
  const sql = parts.length === 1 ? parts[0] : `(${parts.join(' OR ')})`;
  const bindings: unknown[] = cols.map(() => kw);
  return { where: { sql, bindings }, fts: null };
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

// FTS5 OR-combines multiple MATCH phrases inside a single MATCH expression.
// Suffix post-filters OR-combine at the SQL level. The returned `matchPredicate`
// uses the unaliased FTS table name — MATCH's left-hand side is technically a
// hidden table-name column reference in FTS5, and SQLite's docs only commit to
// supporting the unaliased form.
function combineFts(
  parts: FtsPart[],
  ftsTable: 'journals_fts' | 'medline_fts',
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

// ── Main (journals) output projection ──────────────────────────────────
// Always emits nlm_id column (NULL on main path) so the row shape is uniform
// between main and medline paths, letting the Worker merge transparently.

function journalsProjection(showAll: boolean): string {
  if (showAll) {
    return (
      'j.qname AS _sortkey, 0 AS _src, ' +
      'j.rank AS rank, j.name AS name, j.abbr AS abbr, j.publisher AS publisher, ' +
      'j.issn AS issn, j.eissn AS eissn, ' +
      'j.total_cites AS total_cites, j.total_articles AS total_articles, j.citable_items AS citable_items, ' +
      'j.cited_half_life AS cited_half_life, j.citing_half_life AS citing_half_life, ' +
      'j.jif_2024 AS jif_2024, j.five_year_jif AS five_year_jif, ' +
      'j.jif_without_self_cites AS jif_without_self_cites, j.jci AS jci, ' +
      'j.jif_quartile AS jif_quartile, j.jif_rank AS jif_rank, ' +
      'j.fenqu AS fenqu, j.is_top AS is_top, ' +
      'j.dalei_en AS dalei_en, j.dalei_zh AS dalei_zh, j.xiaolei_info AS xiaolei_info, ' +
      'j.db_source AS db_source, j.lang AS lang, ' +
      'NULL AS nlm_id'
    );
  }
  return (
    'j.qname AS _sortkey, 0 AS _src, ' +
    'j.name AS name, j.abbr AS abbr, ' +
    'j.jif_2024 AS jif_2024, j.jif_quartile AS jif_quartile, ' +
    'j.fenqu AS fenqu, j.is_top AS is_top'
  );
}

// ── Medline output projection ──────────────────────────────────────────
// Rows are medline-sourced, left-joined to journals via journals_id. For linked
// rows, journals columns come from j.*; for orphans (journals_id IS NULL), they
// fall back to medline's own fields for name / abbr / issn / eissn, and JCR/Fenqu
// specific fields stay NULL. nlm_id always comes from the medline row.

function medlineProjection(showAll: boolean): string {
  if (showAll) {
    return (
      'COALESCE(j.qname, h.m_qname) AS _sortkey, 1 AS _src, ' +
      'j.rank AS rank, ' +
      'COALESCE(j.name,  h.m_name) AS name, ' +
      'COALESCE(j.abbr,  h.m_abbr) AS abbr, ' +
      'j.publisher AS publisher, ' +
      'COALESCE(j.issn,  h.m_issn)  AS issn, ' +
      'COALESCE(j.eissn, h.m_eissn) AS eissn, ' +
      'j.total_cites AS total_cites, j.total_articles AS total_articles, j.citable_items AS citable_items, ' +
      'j.cited_half_life AS cited_half_life, j.citing_half_life AS citing_half_life, ' +
      'j.jif_2024 AS jif_2024, j.five_year_jif AS five_year_jif, ' +
      'j.jif_without_self_cites AS jif_without_self_cites, j.jci AS jci, ' +
      'j.jif_quartile AS jif_quartile, j.jif_rank AS jif_rank, ' +
      'j.fenqu AS fenqu, j.is_top AS is_top, ' +
      'j.dalei_en AS dalei_en, j.dalei_zh AS dalei_zh, j.xiaolei_info AS xiaolei_info, ' +
      'j.db_source AS db_source, j.lang AS lang, ' +
      'h.nlm_id AS nlm_id'
    );
  }
  return (
    'COALESCE(j.qname, h.m_qname) AS _sortkey, 1 AS _src, ' +
    'COALESCE(j.name, h.m_name) AS name, ' +
    'COALESCE(j.abbr, h.m_abbr) AS abbr, ' +
    'j.jif_2024 AS jif_2024, j.jif_quartile AS jif_quartile, ' +
    'j.fenqu AS fenqu, j.is_top AS is_top'
  );
}

// ── Main query builder ─────────────────────────────────────────────────
// Single-table journals search. Two SELECTs UNION'd only if the query mixes
// FTS and non-FTS keywords (e.g. one ISSN + one f=2). The FTS JOIN shape is
// pinned so the planner stays on the FTS-driven plan (see CLAUDE.md FTS
// planner invariant).
function buildMainSql(
  jWheres: WherePart[],
  jFtses: FtsPart[],
  showAll: boolean,
): { sql: string; bindings: unknown[] } {
  const proj = journalsProjection(showAll);
  const subs: string[] = [];
  const bindings: unknown[] = [];

  const ftsCombined = combineFts(jFtses, 'journals_fts');
  if (ftsCombined) {
    subs.push(
      `SELECT ${proj}
     FROM journals_fts JOIN journals j ON j.id = journals_fts.rowid
     WHERE ${ftsCombined.matchPredicate}`
    );
    bindings.push(...ftsCombined.bindings);
  }
  const whereCombined = combineWheres(jWheres);
  if (whereCombined) {
    subs.push(
      `SELECT ${proj}
     FROM journals j WHERE ${whereCombined.sql}`
    );
    bindings.push(...whereCombined.bindings);
  }

  const cte = subs.length > 1 ? subs.join('\n  UNION\n  ') : (subs[0] ?? `SELECT ${proj} FROM journals j WHERE 0`);

  const sql =
`WITH hits AS MATERIALIZED (
  ${cte}
)
SELECT *, COUNT(*) OVER() AS _total
FROM hits
ORDER BY _sortkey ASC
LIMIT ? OFFSET ?`;

  return { sql, bindings };
}

// ── Medline query builder ──────────────────────────────────────────────
// Two CTEs: `med_hits` materializes raw medline matches (with m_* aliases used
// by the projection COALESCE); `dedup` collapses multiple medline aliases that
// point to the same journals_id to a single representative row.
//
// `show_all=0` pushes `journals_id IS NOT NULL` into the med_hits WHERE so the
// planner can use idx_med_journals_id to skip orphan rows at the source,
// dedup collapses to a single GROUP BY, and the outer JOIN can be an INNER
// JOIN (seed guarantees every non-null journals_id has a matching journals row).
// `show_all=1` keeps orphans: dedup keeps the UNION ALL branch and the join
// stays LEFT so orphan medline fields fall through the COALESCE in projection.
function buildMedlineSql(
  mWheres: WherePart[],
  mFtses: FtsPart[],
  showAll: boolean,
): { sql: string; bindings: unknown[] } {
  const proj = medlineProjection(showAll);
  const subs: string[] = [];
  const bindings: unknown[] = [];
  const notOrphan = showAll ? '' : ' AND m.journals_id IS NOT NULL';

  const ftsCombined = combineFts(mFtses, 'medline_fts');
  if (ftsCombined) {
    subs.push(
      `SELECT m.id AS m_id, m.journals_id AS journals_id, m.qname AS m_qname,
            m.name AS m_name, m.abbr AS m_abbr,
            m.issn AS m_issn, m.eissn AS m_eissn, m.nlm_id AS nlm_id
     FROM medline_fts JOIN medline m ON m.id = medline_fts.rowid
     WHERE ${ftsCombined.matchPredicate}${notOrphan}`
    );
    bindings.push(...ftsCombined.bindings);
  }
  const whereCombined = combineWheres(mWheres);
  if (whereCombined) {
    subs.push(
      `SELECT m.id AS m_id, m.journals_id AS journals_id, m.qname AS m_qname,
            m.name AS m_name, m.abbr AS m_abbr,
            m.issn AS m_issn, m.eissn AS m_eissn, m.nlm_id AS nlm_id
     FROM medline m WHERE ${whereCombined.sql}${notOrphan}`
    );
    bindings.push(...whereCombined.bindings);
  }

  const medHitsCte = subs.length > 1 ? subs.join('\n  UNION\n  ') : (subs[0] ?? `SELECT NULL AS m_id, NULL AS journals_id, NULL AS m_qname, NULL AS m_name, NULL AS m_abbr, NULL AS m_issn, NULL AS m_eissn, NULL AS nlm_id WHERE 0`);

  const dedupCte = showAll
    ? `SELECT MIN(m_id) AS m_id FROM med_hits WHERE journals_id IS NOT NULL GROUP BY journals_id
  UNION ALL
  SELECT m_id FROM med_hits WHERE journals_id IS NULL`
    : `SELECT MIN(m_id) AS m_id FROM med_hits GROUP BY journals_id`;

  const joinKind = showAll ? 'LEFT JOIN' : 'JOIN';

  const sql =
`WITH med_hits AS MATERIALIZED (
  ${medHitsCte}
),
dedup AS (
  ${dedupCte}
),
mapped AS (
  SELECT ${proj}
  FROM dedup d
  JOIN med_hits h ON h.m_id = d.m_id
  ${joinKind} journals j ON j.id = h.journals_id
)
SELECT *, COUNT(*) OVER() AS _total
FROM mapped
ORDER BY _sortkey ASC
LIMIT ? OFFSET ?`;

  return { sql, bindings };
}

// Separate count query for the rare page-beyond-last case: same CTE shape
// but projects COUNT(*) only, keeping the hot path a single round-trip.
function buildMainCountSql(jWheres: WherePart[], jFtses: FtsPart[]): { sql: string; bindings: unknown[] } {
  const subs: string[] = [];
  const bindings: unknown[] = [];

  const ftsCombined = combineFts(jFtses, 'journals_fts');
  if (ftsCombined) {
    subs.push(
      `SELECT j.id AS j_id
     FROM journals_fts JOIN journals j ON j.id = journals_fts.rowid
     WHERE ${ftsCombined.matchPredicate}`
    );
    bindings.push(...ftsCombined.bindings);
  }
  const whereCombined = combineWheres(jWheres);
  if (whereCombined) {
    subs.push(`SELECT j.id AS j_id FROM journals j WHERE ${whereCombined.sql}`);
    bindings.push(...whereCombined.bindings);
  }
  const cte = subs.length > 1 ? subs.join('\n  UNION\n  ') : (subs[0] ?? `SELECT NULL AS j_id WHERE 0`);

  return { sql: `WITH hits AS MATERIALIZED (${cte}) SELECT COUNT(*) AS total FROM hits`, bindings };
}

// Orphan-aware existence probe: under `show_all=0`, the medline data/count queries
// push `journals_id IS NOT NULL` into med_hits, which hides orphan matches from the
// visible result set. When the visible total is 0, this probe checks whether ANY
// medline row (including orphans) matches — `EXISTS` short-circuits at the first
// match so the cost is ≈1–2 rows_read regardless of orphan match count. The
// `journals_id IS NOT NULL` filter is intentionally NOT applied here.
function buildMedlineExistsSql(
  mWheres: WherePart[],
  mFtses: FtsPart[],
): { sql: string; bindings: unknown[] } {
  const parts: string[] = [];
  const bindings: unknown[] = [];

  const ftsCombined = combineFts(mFtses, 'medline_fts');
  if (ftsCombined) {
    parts.push(
      `EXISTS(SELECT 1 FROM medline_fts JOIN medline m ON m.id = medline_fts.rowid WHERE ${ftsCombined.matchPredicate})`
    );
    bindings.push(...ftsCombined.bindings);
  }
  const whereCombined = combineWheres(mWheres);
  if (whereCombined) {
    parts.push(`EXISTS(SELECT 1 FROM medline m WHERE ${whereCombined.sql})`);
    bindings.push(...whereCombined.bindings);
  }

  const expr = parts.length === 0 ? '0' : parts.join(' OR ');
  return { sql: `SELECT (${expr}) AS hit`, bindings };
}

function buildMedlineCountSql(
  mWheres: WherePart[],
  mFtses: FtsPart[],
  showAll: boolean,
): { sql: string; bindings: unknown[] } {
  const subs: string[] = [];
  const bindings: unknown[] = [];
  const notOrphan = showAll ? '' : ' AND m.journals_id IS NOT NULL';

  const ftsCombined = combineFts(mFtses, 'medline_fts');
  if (ftsCombined) {
    subs.push(
      `SELECT m.id AS m_id, m.journals_id AS journals_id
     FROM medline_fts JOIN medline m ON m.id = medline_fts.rowid
     WHERE ${ftsCombined.matchPredicate}${notOrphan}`
    );
    bindings.push(...ftsCombined.bindings);
  }
  const whereCombined = combineWheres(mWheres);
  if (whereCombined) {
    subs.push(`SELECT m.id AS m_id, m.journals_id AS journals_id FROM medline m WHERE ${whereCombined.sql}${notOrphan}`);
    bindings.push(...whereCombined.bindings);
  }
  const medHitsCte = subs.length > 1 ? subs.join('\n  UNION\n  ') : (subs[0] ?? `SELECT NULL AS m_id, NULL AS journals_id WHERE 0`);

  // show_all=0: single GROUP BY (no orphans exist in med_hits); outer COUNT is
  // just over dedup. show_all=1: keep UNION ALL split so orphans are counted.
  if (!showAll) {
    return {
      sql: `WITH med_hits AS MATERIALIZED (${medHitsCte})
SELECT COUNT(*) AS total FROM (SELECT MIN(m_id) AS m_id FROM med_hits GROUP BY journals_id)`,
      bindings,
    };
  }
  const sql =
`WITH med_hits AS MATERIALIZED (${medHitsCte}),
dedup AS (
  SELECT MIN(m_id) AS m_id FROM med_hits WHERE journals_id IS NOT NULL GROUP BY journals_id
  UNION ALL
  SELECT m_id FROM med_hits WHERE journals_id IS NULL
)
SELECT COUNT(*) AS total FROM dedup d JOIN med_hits h ON h.m_id = d.m_id`;
  return { sql, bindings };
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
      const isMedRaw = params.get('is_med');
      const isMed   = isMedRaw === '1' || isMedRaw === 'true';
      const f       = params.get('f');
      const showAll = params.get('show_all') === '1';
      const page    = Math.max(1, parseInt(params.get('page') ?? '1', 10) || 1);
      const pageSize = Math.min(100, Math.max(1, parseInt(params.get('page_size') ?? '20', 10) || 20));
      const nameCase = Math.min(4, Math.max(0, parseInt(params.get('case') ?? '0', 10) || 0));
      const abbrCaseRaw = params.get('case_abbr');
      const abbrCase = abbrCaseRaw != null
        ? Math.min(4, Math.max(0, parseInt(abbrCaseRaw, 10) || 0))
        : nameCase;

      const keywords = q.split('|')
        .map(k => k.trim().toUpperCase().replace(ILLEGAL_CHARS_RE, ''))
        .filter(k => k.length > 0);
      if (keywords.length === 0) {
        return jsonResponse({ error: 'Empty query' }, 400);
      }
      const tooShort = keywords.filter(k => !ISSN_RE.test(k) && k.length < 3);
      if (tooShort.length > 0) {
        return jsonResponse({ error: `Each keyword must be at least 3 characters (too short: ${tooShort.join(', ')})` }, 400);
      }

      const offset = (page - 1) * pageSize;

      // Build per-keyword matches for BOTH tables upfront. Cheap — reused across
      // main and potential medline fallback paths.
      const jWheres: WherePart[] = [];
      const jFtses:  FtsPart[]   = [];
      const mWheres: WherePart[] = [];
      const mFtses:  FtsPart[]   = [];
      for (const kw of keywords) {
        const mj = buildKeywordMatch(kw, 'j', isAbbr, isEissn, f);
        if (mj.where) jWheres.push(mj.where);
        if (mj.fts)   jFtses.push(mj.fts);
        const mm = buildKeywordMatch(kw, 'm', isAbbr, isEissn, f);
        if (mm.where) mWheres.push(mm.where);
        if (mm.fts)   mFtses.push(mm.fts);
      }

      // ── Runner ─────────────────────────────────────────────────────────
      const runMain = async () => {
        const { sql, bindings } = buildMainSql(jWheres, jFtses, showAll);
        const { results } = await env.DB.prepare(sql).bind(...bindings, pageSize, offset).all<Record<string, unknown>>();
        const rows = results ?? [];
        let total = rows.length > 0 ? Number(rows[0]._total ?? 0) : 0;
        if (rows.length === 0 && page > 1) {
          const { sql: cs, bindings: cb } = buildMainCountSql(jWheres, jFtses);
          const cr = await env.DB.prepare(cs).bind(...cb).first<{ total: number }>();
          total = cr?.total ?? 0;
        }
        return { rows, total };
      };

      const runMedline = async () => {
        const { sql, bindings } = buildMedlineSql(mWheres, mFtses, showAll);
        const { results } = await env.DB.prepare(sql).bind(...bindings, pageSize, offset).all<Record<string, unknown>>();
        const rows = results ?? [];
        let total = rows.length > 0 ? Number(rows[0]._total ?? 0) : 0;
        if (rows.length === 0 && page > 1) {
          const { sql: cs, bindings: cb } = buildMedlineCountSql(mWheres, mFtses, showAll);
          const cr = await env.DB.prepare(cs).bind(...cb).first<{ total: number }>();
          total = cr?.total ?? 0;
        }
        return { rows, total };
      };

      // ── Dispatch: is_med=1 skips main; otherwise main first + fallback on total=0 (page=1 only).
      // medHit=true when the medline query actually executed AND matched ≥1 row.
      let rows: Record<string, unknown>[];
      let total: number;
      let medHit = false;
      if (isMed) {
        ({ rows, total } = await runMedline());
        medHit = total > 0;
      } else {
        ({ rows, total } = await runMain());
        if (total === 0 && page === 1) {
          ({ rows, total } = await runMedline());
          medHit = total > 0;
        }
      }
      // Orphan-aware probe: medline ran AND visible total=0 AND show_all=0 means
      // orphan matches may have been hidden by the `journals_id IS NOT NULL` push-down.
      // EXISTS short-circuits → ≈1–2 extra rows_read, only on this rare path.
      // Gate `(isMed || page === 1)` filters out the !isMed && page>1 case where
      // fallback never fired and medline didn't run.
      if (total === 0 && !showAll && (isMed || page === 1)) {
        const { sql: es, bindings: eb } = buildMedlineExistsSql(mWheres, mFtses);
        const er = await env.DB.prepare(es).bind(...eb).first<{ hit: number }>();
        medHit = (er?.hit ?? 0) > 0;
      }

      const data = rows.map(r => {
        const clean: Record<string, unknown> = {};
        for (const k of Object.keys(r)) {
          if (k === '_src' || k === '_sortkey' || k === '_total') continue;
          clean[k] = r[k];
        }
        if ('name' in clean) clean['name'] = transformCase(clean['name'] as string | null, nameCase);
        if ('abbr' in clean) clean['abbr'] = transformCase(clean['abbr'] as string | null, abbrCase);
        return clean;
      });

      const response = jsonResponse({
        query: q,
        data,
        total,
        med_hit: medHit,
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
