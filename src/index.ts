export interface Env {
  DB: D1Database;
}

interface JournalRow {
  name: string;
  abbr: string;
group_name: string;
  issn: string;
  eissn: string;
  if_2025: number | null;
  five_year_jif: number | null;
  quartile: string;
  jif_rank: string;
}

function jsonResponse(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: {
      'Content-Type': 'application/json',
      'Access-Control-Allow-Origin': '*',
    },
  });
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
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

    try {
      const params = url.searchParams;
      const q = params.get('q');
      if (!q) {
        return jsonResponse({ error: 'Missing required parameter: q' }, 400);
      }

      const isAbbr = params.get('isAbbr');
      const group = params.get('group');
      const ifMin = params.get('if_min');
      const ifMax = params.get('if_max');
      const quartileParam = params.get('quartile');
      const page = Math.max(1, parseInt(params.get('page') ??'1', 10) || 1);
      const pageSize = Math.min(100, Math.max(1, parseInt(params.get('pageSize') ?? '20', 10) || 20));

      // sortBy: name(0), if_2025(1), quartile(2), five_year_jif(3), abbr(4), group(5). "|" forcombined sort.
      // order: ASC(0, default), DESC(1)
      const sortByMap: Record<string, string> = {
        '0': 'name','1': 'if_2025', '2': 'quartile',
        '3': 'five_year_jif', '4': 'abbr', '5': 'group_name',
      };
      const sortByRaw = params.get('sortBy') ?? '0';
      const orderDir = params.get('order') ==='1' ? 'DESC' : 'ASC';
      const orderClauses = sortByRaw.split('|').map(s => s.trim()).filter(Boolean)
        .map(k => sortByMap[k]).filter((col): col is string => !!col)
        .map(col => (col === 'if_2025' ||col === 'five_year_jif')
          ? `${col} ${orderDir} NULLS LAST` : `${col} ${orderDir}`);
      if (orderClauses.length === 0) orderClauses.push(`name ${orderDir}`);

      // Split query by | for OR matching
      const keywords = q.split('|').map(k => k.trim()).filter(k => k.length> 0);
      if (keywords.length === 0) {
        return jsonResponse({ error: 'Empty query' }, 400);
      }

      // Build WHERE clause
      const conditions: string[] = [];
      const bindings: unknown[] = [];

      // When isAbbr is set:fuzzy match (LIKE). true/1 =abbr only, false/0 = both name+abbr.
      // When isAbbr is not set:exact match on both name and abbr.
      const keywordClauses: string[] = [];
      for (const kw of keywords) {
        if (isAbbr !== null) {
            // Fuzzy match
            keywordClauses.push(`UPPER(${(isAbbr === 'true' || isAbbr === '1') ? 'abbr' : 'name'}) LIKE UPPER(?)`);
            bindings.push(`%${kw}%`);
          } else {
          // Exact match on both name and abbr (case insensitive)
          keywordClauses.push('(UPPER(name) = UPPER(?) OR UPPER(abbr) = UPPER(?))');
          bindings.push(kw, kw);
        }
      }
      conditions.push(`(${keywordClauses.join(' OR ')})`);

      //Group filter
      if (group) {
        conditions.push('UPPER(group_name) = UPPER(?)');
        bindings.push(group);
      }

      // IF range filters
      if (ifMin) {
        const min = parseFloat(ifMin);
        if (!isNaN(min)) {
          conditions.push('if_2025 >= ?');
          bindings.push(min);
        }
      }
      if (ifMax) {
        const max = parseFloat(ifMax);
        if (!isNaN(max)) {
          conditions.push('if_2025 <= ?');
          bindings.push(max);
        }
      }

      // Quartile filter
      if (quartileParam) {
        const qNum = parseInt(quartileParam, 10);
        if (qNum >= 1 && qNum <= 4) {
          conditions.push('quartile = ?');
          bindings.push(`Q${qNum}`);
        }
      }

      const whereClause = conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : '';

      // Count query
      const countSQL = `SELECT COUNT(*) as total FROM journals ${whereClause}`;
      const countResult = await env.DB.prepare(countSQL).bind(...bindings).first<{ total: number }>();
const total = countResult?.total ?? 0;

      // Data query
      const offset = (page - 1) * pageSize;
      const dataSQL = `SELECT name, abbr, group_name, issn, eissn, if_2025, five_year_jif, quartile, jif_rank FROM journals ${whereClause} ORDER BY ${orderClauses.join(', ')} LIMIT ? OFFSET ?`;
      const dataBindings = [...bindings, pageSize, offset];
      const dataResult = await env.DB.prepare(dataSQL).bind(...dataBindings).all<JournalRow>();

      const data = (dataResult.results ?? []).map(row => ({
        name: row.name,
        abbr: row.abbr,
        group: row.group_name,
        issn: row.issn,
        eissn: row.eissn,
        if_2025: row.if_2025,
        five_year_jif: row.five_year_jif,
        quartile: row.quartile,
        jif_rank: row.jif_rank,
      }));

      return jsonResponse({
        data,
        total,
        page,
        pageSize,
        totalPages: Math.ceil(total / pageSize),
      });
    } catch (err:unknown) {
      const message = err instanceof Error ? err.message : 'Unknown error';
      return jsonResponse({ error: message }, 500);
    }
},
};
