import { readFileSync, writeFileSync, existsSync } from 'fs';
import { join } from 'path';

const INTEGRATED_INPUT = join(__dirname, '..', 'JCR2025_integrated_Fenqu2026_JIF2024.csv');
const MEDLINE_INPUT    = join(__dirname, '..', 'J_Medline_202606.txt');
const OUTPUT           = join(__dirname, '..', 'seed.sql');
const ORPHAN_REPORT    = join(__dirname, '..', 'medline_orphans.csv');
// Auto diagnostic of abbr-only links, regenerated each seed. The human-reviewed
// copy (with a verdict column) lives in medline_abbr_matched.csv and is NOT written
// here — its review decisions are captured in medline_patch.json.
const ABBR_REPORT      = join(__dirname, '..', 'medline_abbr_matched_auto.csv');
// Manual corrections applied AFTER auto journals_id computation (see file header).
const PATCH_INPUT      = join(__dirname, '..', 'medline_patch.json');
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

/** CSV field escaping for report output. */
function csvCell(raw: string): string {
  const v = raw ?? '';
  return /[",\r\n]/.test(v) ? `"${v.replace(/"/g, '""')}"` : v;
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

// journals INSERT column list — order MUST match the VALUES tuple below.
const JOURNAL_COLS =
  'rank,name,abbr,qname,qabbr,publisher,issn,eissn,' +
  'categories,editions,jcr_year,' +
  'jif_2025,five_year_jif,jif_without_self_cites,jif_quartile,jif_percentile,jif_rank,' +
  'jci,jci_quartile,jci_percentile,jci_rank,' +
  'total_cites,total_articles,citable_items,pct_articles_citable,pct_oa_gold,' +
  'immediacy_index,eigenfactor,normalized_eigenfactor,article_influence_score,ais_quartile,ais_rank,' +
  'cited_half_life,citing_half_life,category_quartiles_json,' +
  'jif_2024,jci_2024,jif_quartile_2024,total_cites_2024,total_articles_2024,' +
  'lang,db_source,dalei_en,dalei_zh,fenqu,is_top,xiaolei_info';

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
    // Integrated CSV header has 45 columns (JCR2025 33 + carry2024 5 + Fenqu 7).
    if (c.length < 45) continue;

    rowId++;
    // 0 Rank 1 Journal name 2 Abbreviated journal 3 Publisher 4 ISSN 5 eISSN
    // 6 Categories 7 Editions 8 JCR year
    // 9 2025 JIF 10 5-year JIF 11 JIF without self cites 12 JIF quartile 13 JIF percentile 14 JIF rank
    // 15 JCI 16 JCI quartile 17 JCI percentile 18 JCI rank
    // 19 Total citations 20 Total articles 21 Citable items 22 % articles in citable items 23 % OA gold
    // 24 Immediacy index 25 Eigenfactor 26 Normalized eigenfactor 27 Article influence score 28 AIS quartile 29 AIS rank
    // 30 Cited half-life 31 Citing half-life 32 Category quartiles JSON
    // 33 JIF_2024 34 JCI_2024 35 JIF_Quartile_2024 36 Total_Cites_2024 37 Total_Articles_2024
    // 38 FQ_Lang 39 FQ_Database 40 FQ_Dalei_En 41 FQ_Dalei_Zh 42 Fenqu 43 FQ_Is_Top 44 FQ_Xiaolei_Info
    const nameRaw  = normalizeCell(c[1]);
    const abbrRaw  = normalizeCell(c[2]);
    const issnRaw  = normalizeCell(c[4]).toUpperCase();
    const eissnRaw = normalizeCell(c[5]).toUpperCase();
    const qnameRaw = nameRaw.toUpperCase();
    const qabbrRaw = abbrRaw.toUpperCase();

    const rank      = parseInt2(c[0]);
    const name      = escapeSQL(nameRaw);
    const abbr      = escapeSQL(abbrRaw);
    const qname     = escapeSQL(qnameRaw);
    const qabbr     = escapeSQL(qabbrRaw);
    const publisher = escapeSQL(c[3]);
    const issn      = escapeSQL(issnRaw);
    const eissn     = escapeSQL(eissnRaw);

    const categories  = escapeSQL(c[6]);
    const editions    = escapeSQL(c[7]);
    const jcrYear     = escapeSQL(c[8]);
    const jif2025     = parseNum(c[9]);
    const fiveYrJIF   = parseNum(c[10]);
    const jifNoSelf   = parseNum(c[11]);
    const jifQ        = escapeSQL(c[12]);
    const jifPct      = parseNum(c[13]);
    const jifRank     = escapeSQL(c[14]);
    const jci         = parseNum(c[15]);
    const jciQ        = escapeSQL(c[16]);
    const jciPct      = parseNum(c[17]);
    const jciRank     = escapeSQL(c[18]);
    const totalCites  = parseInt2(c[19]);
    const totalArts   = parseInt2(c[20]);
    const citableIt   = parseInt2(c[21]);
    const pctArtsCit  = parseNum(c[22]);
    const pctOAGold   = parseNum(c[23]);
    const immediacy   = parseNum(c[24]);
    const eigen       = parseNum(c[25]);
    const normEigen   = parseNum(c[26]);
    const ais         = parseNum(c[27]);
    const aisQ        = escapeSQL(c[28]);
    const aisRank     = escapeSQL(c[29]);
    const citedHL     = parseNum(c[30]);
    const citingHL    = parseNum(c[31]);
    const catJson     = escapeSQL(c[32]);
    const jif2024     = parseNum(c[33]);
    const jci2024     = parseNum(c[34]);
    const jifQ2024    = escapeSQL(c[35]);
    const cites2024   = parseInt2(c[36]);
    const arts2024    = parseInt2(c[37]);
    const lang        = escapeSQL(c[38]);
    const dbSource    = escapeSQL(c[39]);
    const daleiEn     = escapeSQL(c[40]);
    const daleiZh     = escapeSQL(c[41]);
    const fenqu       = escapeSQL(c[42]);
    const isTop       = escapeSQL(c[43]);
    const xiaolei     = escapeSQL(c[44]);

    values.push(
      `(${rank},'${name}','${abbr}','${qname}','${qabbr}','${publisher}','${issn}','${eissn}',` +
      `'${categories}','${editions}','${jcrYear}',` +
      `${jif2025},${fiveYrJIF},${jifNoSelf},'${jifQ}',${jifPct},'${jifRank}',` +
      `${jci},'${jciQ}',${jciPct},'${jciRank}',` +
      `${totalCites},${totalArts},${citableIt},${pctArtsCit},${pctOAGold},` +
      `${immediacy},${eigen},${normEigen},${ais},'${aisQ}','${aisRank}',` +
      `${citedHL},${citingHL},'${catJson}',` +
      `${jif2024},${jci2024},'${jifQ2024}',${cites2024},${arts2024},` +
      `'${lang}','${dbSource}','${daleiEn}','${daleiZh}','${fenqu}','${isTop}','${xiaolei}')`
    );
    rows.push({ id: rowId, issn: issnRaw, eissn: eissnRaw, qabbr: qabbrRaw });
  }

  const stmts = batchInserts('journals', JOURNAL_COLS, values);
  return { stmts, rows };
}

type MedlineRecord = {
  title: string;       // JournalTitle
  medAbbr: string;     // MedAbbr
  issnPrint: string;   // ISSN (Print)
  issnOnline: string;  // ISSN (Online)
  nlmId: string;       // NlmId
};

/** NLM J_Medline file: records separated by dashed lines; key/value lines. */
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

// 'issn' = matched on a real ISSN equality (Print or Online); 'abbr' = matched
// only via MedAbbr→qabbr (weaker, name-based); 'none' = orphan (no journals row).
type MatchType = 'issn' | 'abbr' | 'none';

type AliasPatch = {
  journal_name: string;   // alias display name (also qname source)
  resolve_issn: string;   // a journals-side ISSN used to resolve journals_id
  issn: string;           // Fenqu-side ISSN to make searchable (may be '')
  eissn: string;          // Fenqu-side EISSN to make searchable (may be '')
  abbr: string;
  nlm_id: string;         // carried from the journal's existing NLM record, else ''
};
type MedlinePatch = {
  null_journals_id: { nlm_id: string }[];   // abbr-collision links to unlink
  append_aliases: AliasPatch[];             // extra ISSN aliases to append
};

function loadPatch(): MedlinePatch {
  if (!existsSync(PATCH_INPUT)) {
    console.warn(`WARN: ${PATCH_INPUT} not found — no medline corrections applied`);
    return { null_journals_id: [], append_aliases: [] };
  }
  const p = JSON.parse(readFileSync(PATCH_INPUT, 'utf-8')) as Partial<MedlinePatch>;
  return { null_journals_id: p.null_journals_id ?? [], append_aliases: p.append_aliases ?? [] };
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

  const patch = loadPatch();
  const nullSet = new Set(patch.null_journals_id.map(e => e.nlm_id.trim()));

  const values: string[] = [];
  const orphans: string[] = [];   // CSV lines: no journals match at all
  const abbrOnly: string[] = [];  // CSV lines: matched only via MedAbbr
  let issnLinked = 0, abbrLinked = 0, patchedNull = 0;

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
    let how: MatchType = 'none';
    if (ISSN_RE.test(issnPrint)) {
      jid = byIssn.get(issnPrint)  ?? byEissn.get(issnPrint) ?? null;
      if (jid !== null) how = 'issn';
    }
    if (jid === null && ISSN_RE.test(issnOnline)) {
      jid = byIssn.get(issnOnline) ?? byEissn.get(issnOnline) ?? null;
      if (jid !== null) how = 'issn';
    }
    if (jid === null && qabbrRaw !== '') {
      jid = byQabbr.get(qabbrRaw) ?? null;
      if (jid !== null) how = 'abbr';
    }

    // Patch: unlink abbr-collision false positives (verdict=mismatch in review).
    // `how` is kept for the diagnostic report; only the emitted journals_id is nulled.
    const patched = jid !== null && nullSet.has(nlmId);
    if (patched) { jid = null; patchedNull++; }

    if (how === 'issn') issnLinked++;
    else if (how === 'abbr') {
      abbrLinked++;
      abbrOnly.push([nlmId, title, medAbbr, issnPrint, issnOnline, patched ? '' : String(jid), patched ? 'nulled' : ''].map(csvCell).join(','));
    } else {
      orphans.push([nlmId, title, medAbbr, issnPrint, issnOnline].map(csvCell).join(','));
    }

    const journalsId = jid === null ? 'NULL' : String(jid);
    values.push(
      `(${journalsId},'${escapeSQL(title)}','${escapeSQL(medAbbr)}',` +
      `'${escapeSQL(qnameRaw)}','${escapeSQL(qabbrRaw)}',` +
      `'${escapeSQL(issnPrint)}','${escapeSQL(issnOnline)}','${escapeSQL(nlmId)}')`
    );
  }

  // Append Fenqu-side ISSN aliases: their journals base row kept the JCR ISSN, so
  // the Fenqu ISSN is otherwise unsearchable. Each alias points at the same journal
  // (journals_id resolved from resolve_issn) and carries the journal's NLM id if any.
  let appended = 0;
  for (const a of patch.append_aliases) {
    const ri = a.resolve_issn.trim().toUpperCase();
    const jid = byIssn.get(ri) ?? byEissn.get(ri) ?? null;
    if (jid === null) { console.warn(`WARN: alias '${a.journal_name}' resolve_issn ${ri} not found in journals — skipped`); continue; }
    const name  = normalizeCell(a.journal_name);
    const abbr  = normalizeCell(a.abbr);
    const issn  = normalizeCell(a.issn).toUpperCase();
    const eissn = normalizeCell(a.eissn).toUpperCase();
    values.push(
      `(${jid},'${escapeSQL(name)}','${escapeSQL(abbr)}',` +
      `'${escapeSQL(name.toUpperCase())}','${escapeSQL(abbr.toUpperCase())}',` +
      `'${escapeSQL(issn)}','${escapeSQL(eissn)}','${escapeSQL(a.nlm_id)}')`
    );
    appended++;
  }

  console.log(`medline: ${issnLinked + abbrLinked - patchedNull}/${records.length} linked (${issnLinked} by ISSN, ${abbrLinked - patchedNull} by abbr-only after patch; ${patchedNull} abbr links nulled), ${orphans.length} orphans, +${appended} ISSN aliases appended`);

  writeFileSync(ORPHAN_REPORT,
    'nlm_id,title,med_abbr,issn_print,issn_online\n' + orphans.join('\n') + '\n', 'utf-8');
  writeFileSync(ABBR_REPORT,
    'nlm_id,title,med_abbr,issn_print,issn_online,journals_id,patched\n' + abbrOnly.join('\n') + '\n', 'utf-8');
  console.log(`Wrote ${ORPHAN_REPORT} (${orphans.length}) and ${ABBR_REPORT} (${abbrOnly.length})`);

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
