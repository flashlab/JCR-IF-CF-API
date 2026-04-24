import { readFileSync, writeFileSync } from 'fs';
import { join } from 'path';

const INTEGRATED_INPUT = join(__dirname, '..', 'Clinicalscientists_JIF2024_integrated_Fenqu_2026.csv');
const MEDLINE_INPUT    = join(__dirname, '..', 'J_Medline.txt');
const OUTPUT           = join(__dirname, '..', 'seed.sql');
const BATCH_SIZE       = 50;

const ISSN_RE = /^\d{4}-\d{3}[\dX]$/;

// CSVs use "N/A" for unknown; collapse to empty so downstream ''-default columns stay consistent.
function normalizeCell(raw: string): string {
  const v = (raw ?? '').trim();
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

/** RFC-4180-compatible CSV row parser (single-line; integrated CSV has no embedded newlines in quoted fields). */
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

type JournalRow = {
  id: number;
  issn: string;   // uppercased
  eissn: string;  // uppercased
  qabbr: string;  // uppercased
};

function seedJournals(): { stmts: string[]; rows: JournalRow[] } {
  const raw = readFileSync(INTEGRATED_INPUT, 'utf-8').replace(/^﻿/, '');
  const lines = raw.split(/\r?\n/).filter(l => l.trim() !== '');
  const dataLines = lines.slice(1); // skip header
  console.log(`journals: ${dataLines.length} rows`);

  const values: string[] = [];
  const rows: JournalRow[] = [];
  let rowId = 0;
  for (const line of dataLines) {
    const c = parseCSVRow(line);
    // Integrated CSV header has 28 columns; require at least up to Xiaolei_Info (index 25).
    if (c.length < 26) continue;

    rowId++;
    // 0 Rank 1 Name 2 JCR_Year(skip) 3 Abbr 4 Publisher 5 ISSN 6 EISSN
    // 7 Total_Cites 8 Total_Articles 9 Citable_Items 10 Cited_Half_life 11 Citing_Half_life
    // 12 JIF_2024 13 Five_Year_JIF 14 JIF_Without_Self_cites 15 JCI 16 JIF_Quartile 17 JIF_Rank
    // 18 Fenqu_No(skip) 19 Lang 20 Database 21 Dalei_En 22 Dalei_Zh
    // 23 Fenqu 24 Is_Top 25 Xiaolei_Info 26 Merge_Status(skip) 27 Merge_Match_By(skip)
    const rank       = parseInt2(c[0]);
    const nameRaw    = normalizeCell(c[1]);
    const abbrRaw    = normalizeCell(c[3]);
    const name       = escapeSQL(nameRaw);
    const qnameRaw   = nameRaw.toUpperCase();
    const qname      = escapeSQL(qnameRaw);
    const abbr       = escapeSQL(abbrRaw);
    const qabbrRaw   = abbrRaw.toUpperCase();
    const qabbr      = escapeSQL(qabbrRaw);
    const publisher  = escapeSQL(c[4]);
    const issnRaw    = normalizeCell(c[5]).toUpperCase();
    const eissnRaw   = normalizeCell(c[6]).toUpperCase();
    const issn       = escapeSQL(issnRaw);
    const eissn      = escapeSQL(eissnRaw);
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
    const lang       = escapeSQL(c[19]);
    const dbSource   = escapeSQL(c[20]);
    const daleiEn    = escapeSQL(c[21]);
    const daleiZh    = escapeSQL(c[22]);
    const fenqu      = escapeSQL(c[23]);
    const isTop      = escapeSQL(c[24]);
    const xiaolei    = escapeSQL(c[25]);

    values.push(
      `(${rank},'${name}','${abbr}','${qname}','${qabbr}','${publisher}','${issn}','${eissn}',` +
      `${totalCites},${totalArts},${citableIt},${citedHL},${citingHL},` +
      `${jif2024},${fiveYrJIF},${jifNoSelf},${jci},'${jifQ}','${jifRank}',` +
      `'${lang}','${dbSource}','${daleiEn}','${daleiZh}','${fenqu}','${isTop}','${xiaolei}')`
    );
    rows.push({ id: rowId, issn: issnRaw, eissn: eissnRaw, qabbr: qabbrRaw });
  }

  const stmts = batchInserts(
    'journals',
    'rank,name,abbr,qname,qabbr,publisher,issn,eissn,' +
    'total_cites,total_articles,citable_items,cited_half_life,citing_half_life,' +
    'jif_2024,five_year_jif,jif_without_self_cites,jci,jif_quartile,jif_rank,' +
    'lang,db_source,dalei_en,dalei_zh,fenqu,is_top,xiaolei_info',
    values
  );
  return { stmts, rows };
}

type MedlineRecord = {
  title: string;       // JournalTitle
  medAbbr: string;     // MedAbbr
  issnPrint: string;   // ISSN (Print)
  issnOnline: string;  // ISSN (Online)
  nlmId: string;       // NlmId
};

/** NLM J_Medline.txt: records separated by dashed lines; key/value lines. */
function parseMedline(path: string): MedlineRecord[] {
  const raw = readFileSync(path, 'utf8').replace(/^﻿/, '');
  const lines = raw.split(/\r?\n/);
  const records: MedlineRecord[] = [];
  let cur: Partial<MedlineRecord> = {};
  const flush = () => {
    if (Object.keys(cur).length > 0) {
      records.push({
        title:      cur.title      ?? '',
        medAbbr:    cur.medAbbr    ?? '',
        issnPrint:  cur.issnPrint  ?? '',
        issnOnline: cur.issnOnline ?? '',
        nlmId:      cur.nlmId      ?? '',
      });
    }
    cur = {};
  };
  for (const line of lines) {
    if (/^-{5,}$/.test(line)) { flush(); continue; }
    const m = line.match(/^([^:]+):\s?(.*)$/);
    if (!m) continue;
    const key = m[1].trim();
    const val = m[2];
    switch (key) {
      case 'JournalTitle':  cur.title      = val; break;
      case 'MedAbbr':       cur.medAbbr    = val; break;
      case 'ISSN (Print)':  cur.issnPrint  = val; break;
      case 'ISSN (Online)': cur.issnOnline = val; break;
      case 'NlmId':         cur.nlmId      = val; break;
    }
  }
  flush();
  // The last record in the file has a trailing `-----` which triggers flush;
  // filter records that lack both title and ids (stray empty flushes).
  return records.filter(r => r.title !== '' || r.nlmId !== '');
}

function seedMedline(journals: JournalRow[]): string[] {
  const records = parseMedline(MEDLINE_INPUT);
  console.log(`medline: ${records.length} records`);

  // journals lookup tables for journals_id resolution (first row wins on collision).
  const byIssn  = new Map<string, number>();
  const byEissn = new Map<string, number>();
  const byQabbr = new Map<string, number>();
  for (const r of journals) {
    if (r.issn  && ISSN_RE.test(r.issn)  && !byIssn.has(r.issn))   byIssn.set(r.issn, r.id);
    if (r.eissn && ISSN_RE.test(r.eissn) && !byEissn.has(r.eissn)) byEissn.set(r.eissn, r.id);
    if (r.qabbr && !byQabbr.has(r.qabbr))                           byQabbr.set(r.qabbr, r.id);
  }

  const values: string[] = [];
  let linked = 0;
  for (const rec of records) {
    const title      = normalizeCell(rec.title);
    if (title === '') continue;
    const medAbbr    = normalizeCell(rec.medAbbr);
    const issnPrint  = normalizeCell(rec.issnPrint).toUpperCase();
    const issnOnline = normalizeCell(rec.issnOnline).toUpperCase();
    const nlmId      = normalizeCell(rec.nlmId);
    const qnameRaw   = title.toUpperCase();
    const qabbrRaw   = medAbbr.toUpperCase();

    // Priority: Medline.ISSN(Print)→journals.issn → journals.eissn →
    //           Medline.ISSN(Online)→journals.issn → journals.eissn →
    //           Medline.MedAbbr→journals.qabbr
    let jid: number | null = null;
    if (ISSN_RE.test(issnPrint)) {
      jid = byIssn.get(issnPrint)  ?? byEissn.get(issnPrint) ?? null;
    }
    if (jid === null && ISSN_RE.test(issnOnline)) {
      jid = byIssn.get(issnOnline) ?? byEissn.get(issnOnline) ?? null;
    }
    if (jid === null && qabbrRaw !== '') {
      jid = byQabbr.get(qabbrRaw) ?? null;
    }
    if (jid !== null) linked++;

    const journalsId = jid === null ? 'NULL' : String(jid);
    values.push(
      `(${journalsId},'${escapeSQL(title)}','${escapeSQL(medAbbr)}',` +
      `'${escapeSQL(qnameRaw)}','${escapeSQL(qabbrRaw)}',` +
      `'${escapeSQL(issnPrint)}','${escapeSQL(issnOnline)}','${escapeSQL(nlmId)}')`
    );
  }
  console.log(`medline: ${linked}/${values.length} linked to journals`);

  return batchInserts(
    'medline',
    'journals_id,name,abbr,qname,qabbr,issn,eissn,nlm_id',
    values
  );
}

function main() {
  const { stmts: journalStmts, rows } = seedJournals();
  const medlineStmts = seedMedline(rows);
  const ftsRebuild = [
    `INSERT INTO journals_fts(journals_fts) VALUES('rebuild');`,
    `INSERT INTO medline_fts(medline_fts) VALUES('rebuild');`,
  ];
  const all = [...journalStmts, ...medlineStmts, ...ftsRebuild];
  writeFileSync(OUTPUT, all.join('\n\n') + '\n', 'utf-8');
  console.log(`Generated ${OUTPUT} (${journalStmts.length} journal batches, ${medlineStmts.length} medline batches, FTS rebuild appended)`);
}

main();
