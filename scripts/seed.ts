import { readFileSync, writeFileSync } from 'fs';
import { join } from 'path';

const JCR_INPUT   = join(__dirname, '..', 'Clinicalscientists_JIF2024.csv');
const FENQU_INPUT = join(__dirname, '..', 'Fenqu_2026.csv');
const OUTPUT      = join(__dirname, '..', 'seed.sql');
const BATCH_SIZE  = 50;

// CSVs use "N/A" for unknown; collapse to empty so downstream ''-default columns stay consistent.
function normalizeCell(raw: string): string {
  const v = raw.trim();
  return v.toUpperCase() === 'N/A' ? '' : v;
}

function escapeSQL(s: string): string {
  return normalizeCell(s).replace(/'/g, "''");
}

function parseNum(raw: string): string {
  const v = normalizeCell(raw);
  if (v === '') return 'NULL';
  if (v === '<0.1') return '0.05';
  const n = parseFloat(v);
  return isNaN(n) ? 'NULL' : String(n);
}

function parseInt2(raw: string): string {
  const v = normalizeCell(raw);
  if (v === '') return 'NULL';
  const n = parseInt(v, 10);
  return isNaN(n) ? 'NULL' : String(n);
}

/** RFC-4180-compatible CSV row parser */
function parseCSVRow(line: string): string[] {
  const fields: string[] = [];
  let current = '';
  let inQuotes = false;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (ch === '"') {
      if (inQuotes && line[i + 1] === '"') {
        current += '"';
        i++;
      } else {
        inQuotes = !inQuotes;
      }
    } else if (ch === ',' && !inQuotes) {
      fields.push(current);
      current = '';
    } else {
      current += ch;
    }
  }
  fields.push(current);
  return fields;
}

function batchInserts(table: string, columns: string, values: string[]): string[] {
  const stmts: string[] = [];
  for (let i = 0; i < values.length; i += BATCH_SIZE) {
    const batch = values.slice(i, i + BATCH_SIZE);
    stmts.push(`INSERT INTO ${table} (${columns}) VALUES\n${batch.join(',\n')};`);
  }
  return stmts;
}

function seedJournals(): string[] {
  const raw = readFileSync(JCR_INPUT, 'utf-8');
  const lines = raw.split(/\r?\n/).filter(l => l.trim() !== '');
  const dataLines = lines.slice(1); // skip header
  console.log(`journals: ${dataLines.length} rows`);

  const values: string[] = [];
  for (const line of dataLines) {
    const c = parseCSVRow(line);
    if (c.length < 18) continue;

    // Rank,Name,JCR_Year,Abbr,Publisher,ISSN,EISSN,Total_Cites,Total_Articles,
    // Citable_Items,Cited_Half_life,Citing_Half_life,JIF_2024,Five_Year_JIF,
    // JIF_Without_Self_cites,JCI,JIF_Quartile,JIF_Rank
    const rank       = parseInt2(c[0]);
    const nameRaw    = normalizeCell(c[1]);
    const abbrRaw    = normalizeCell(c[3]);
    const name       = escapeSQL(nameRaw);
    const qname      = escapeSQL(nameRaw.toUpperCase());
    // c[2] = JCR_Year — skipped
    const abbr       = escapeSQL(abbrRaw);
    const qabbr      = escapeSQL(abbrRaw.toUpperCase());
    const publisher  = escapeSQL(c[4]);
    const issn       = escapeSQL(normalizeCell(c[5]).toUpperCase());
    const eissn      = escapeSQL(normalizeCell(c[6]).toUpperCase());
    const totalCites = parseInt2(c[7]);
    const totalArts  = parseInt2(c[8]);
    const citableIt  = parseInt2(c[9]);
    const citedHL    = parseNum(c[10]);
    const citingHL   = parseNum(c[11]);
    const jif2024    = parseNum(c[12]);
    const fiveYrJIF  = parseNum(c[13]);
    const jifNoSelf  = parseNum(c[14]);
    const jci        = parseNum(c[15]);
    const jifQ       = escapeSQL(c[16]);
    const jifRank    = escapeSQL(c[17]);

    values.push(
      `(${rank},'${name}','${abbr}','${qname}','${qabbr}','${publisher}','${issn}','${eissn}',` +
      `${totalCites},${totalArts},${citableIt},${citedHL},${citingHL},` +
      `${jif2024},${fiveYrJIF},${jifNoSelf},${jci},'${jifQ}','${jifRank}')`
    );
  }

  return batchInserts(
    'journals',
    'rank,name,abbr,qname,qabbr,publisher,issn,eissn,total_cites,total_articles,citable_items,' +
    'cited_half_life,citing_half_life,jif_2024,five_year_jif,jif_without_self_cites,' +
    'jci,jif_quartile,jif_rank',
    values
  );
}

function seedFenqu(): string[] {
  const raw = readFileSync(FENQU_INPUT, 'utf-8');
  const lines = raw.split(/\r?\n/).filter(l => l.trim() !== '');
  const dataLines = lines.slice(1); // skip header
  console.log(`fenqu: ${dataLines.length} rows`);

  const values: string[] = [];
  for (const line of dataLines) {
    const c = parseCSVRow(line);
    if (c.length < 12) continue;

    // No,Name,ISSN,EISSN,Lang,Publisher,Database,Dalei_En,Dalei_Zh,Fenqu,Is_Top,Xiaolei_Info
    // c[0] = No — skipped
    const nameRaw    = normalizeCell(c[1]);
    const name       = escapeSQL(nameRaw);
    const qname      = escapeSQL(nameRaw.toUpperCase());
    const issn       = escapeSQL(normalizeCell(c[2]).toUpperCase());
    const eissn      = escapeSQL(normalizeCell(c[3]).toUpperCase());
    const lang       = escapeSQL(c[4]);
    const publisher  = escapeSQL(c[5]);
    const dbSource   = escapeSQL(c[6]);
    const daleiEn    = escapeSQL(c[7]);
    const daleiZh    = escapeSQL(c[8]);
    const fenqu      = escapeSQL(c[9]);
    const isTop      = escapeSQL(c[10]);
    const xiaolei    = escapeSQL(c[11]);

    values.push(
      `('${name}','${qname}','${issn}','${eissn}','${lang}','${publisher}','${dbSource}',` +
      `'${daleiEn}','${daleiZh}','${fenqu}','${isTop}','${xiaolei}')`
    );
  }

  return batchInserts(
    'fenqu',
    'name,qname,issn,eissn,lang,publisher,db_source,dalei_en,dalei_zh,fenqu,is_top,xiaolei_info',
    values
  );
}

// Pre-compute journals.fenqu_id using the ISSN → EISSN → qname priority that
// used to run as a per-query COALESCE subquery. Executed after both tables are
// populated; must precede the FTS rebuild since FTS is independent of this column.
const FENQU_ID_BACKFILL =
`UPDATE journals SET fenqu_id = (
  COALESCE(
    (SELECT f2.id FROM fenqu f2 WHERE journals.issn  != '' AND f2.issn  = journals.issn  LIMIT 1),
    (SELECT f2.id FROM fenqu f2 WHERE journals.eissn != '' AND f2.eissn = journals.eissn LIMIT 1),
    (SELECT f2.id FROM fenqu f2 WHERE f2.qname = journals.qname LIMIT 1)
  )
);`;

function main() {
  const journalStmts = seedJournals();
  const fenquStmts   = seedFenqu();
  const ftsRebuild = [
    `INSERT INTO journals_fts(journals_fts) VALUES('rebuild');`,
    `INSERT INTO fenqu_fts(fenqu_fts) VALUES('rebuild');`,
  ];
  const all = [...journalStmts, ...fenquStmts, FENQU_ID_BACKFILL, ...ftsRebuild];
  writeFileSync(OUTPUT, all.join('\n\n') + '\n', 'utf-8');
  console.log(`Generated ${OUTPUT} (${journalStmts.length} journal batches, ${fenquStmts.length} fenqu batches, fenqu_id backfill + FTS rebuild appended)`);
}

main();
