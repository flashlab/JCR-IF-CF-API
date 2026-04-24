import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const JCR_INPUT     = join(__dirname, '..', 'Clinicalscientists_JIF2024.csv');
const MEDLINE_INPUT = join(__dirname, '..', 'J_Medline.txt');

/** RFC-4180 CSV parser that handles quoted fields containing commas / newlines. */
function parseCSV(raw: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let field = '';
  let inQuotes = false;
  for (let i = 0; i < raw.length; i++) {
    const ch = raw[i];
    if (inQuotes) {
      if (ch === '"') {
        if (raw[i + 1] === '"') { field += '"'; i++; }
        else inQuotes = false;
      } else field += ch;
    } else {
      if (ch === '"') inQuotes = true;
      else if (ch === ',') { row.push(field); field = ''; }
      else if (ch === '\r') { /* skip */ }
      else if (ch === '\n') { row.push(field); field = ''; rows.push(row); row = []; }
      else field += ch;
    }
  }
  if (field.length > 0 || row.length > 0) { row.push(field); rows.push(row); }
  return rows.filter(r => r.length > 1 || (r.length === 1 && r[0] !== ''));
}

function readCsvAsObjects(path: string): Record<string, string>[] {
  const raw = readFileSync(path, 'utf8').replace(/^﻿/, '');
  const table = parseCSV(raw);
  const header = table[0];
  return table.slice(1).map(r => {
    const o: Record<string, string> = {};
    header.forEach((h, i) => { o[h] = r[i] ?? ''; });
    return o;
  });
}

type MedlineRecord = {
  jrId: string;
  title: string;
  medAbbr: string;
  issnPrint: string;
  issnOnline: string;
  nlmId: string;
};

/** Parse the NLM J_Medline.txt record format. Records are separated by a dashed line. */
function parseMedline(path: string): MedlineRecord[] {
  const raw = readFileSync(path, 'utf8').replace(/^﻿/, '');
  const lines = raw.split(/\r?\n/);
  const records: MedlineRecord[] = [];
  let cur: Partial<MedlineRecord> = {};
  const flush = () => {
    if (cur.jrId !== undefined) records.push({
      jrId: cur.jrId ?? '',
      title: cur.title ?? '',
      medAbbr: cur.medAbbr ?? '',
      issnPrint: cur.issnPrint ?? '',
      issnOnline: cur.issnOnline ?? '',
      nlmId: cur.nlmId ?? '',
    });
    cur = {};
  };
  for (const line of lines) {
    if (/^-{5,}$/.test(line)) { flush(); continue; }
    const m = line.match(/^([^:]+):\s?(.*)$/);
    if (!m) continue;
    const key = m[1].trim();
    const val = m[2];
    switch (key) {
      case 'JrId': cur.jrId = val; break;
      case 'JournalTitle': cur.title = val; break;
      case 'MedAbbr': cur.medAbbr = val; break;
      case 'ISSN (Print)': cur.issnPrint = val; break;
      case 'ISSN (Online)': cur.issnOnline = val; break;
      case 'NlmId': cur.nlmId = val; break;
    }
  }
  flush();
  return records;
}

const norm = (s: string) => (s ?? '').trim().toUpperCase();
const normName = (s: string) => norm(s).replace(/\s+/g, ' ');
const isValidIssn = (s: string) => /^\d{4}-\d{3}[\dX]$/.test(norm(s));

const jcr = readCsvAsObjects(JCR_INPUT);
const medline = parseMedline(MEDLINE_INPUT);

// Index medline by both ISSN (Print) and ISSN (Online).
const medByPrint  = new Map<string, MedlineRecord[]>();
const medByOnline = new Map<string, MedlineRecord[]>();
for (const r of medline) {
  const p = norm(r.issnPrint);
  const o = norm(r.issnOnline);
  if (isValidIssn(p))  { if (!medByPrint.has(p))   medByPrint.set(p,  []); medByPrint.get(p)!.push(r); }
  if (isValidIssn(o))  { if (!medByOnline.has(o))  medByOnline.set(o, []); medByOnline.get(o)!.push(r); }
}

type Mismatch = {
  via: string;
  code: string;
  jcrName: string;
  medlineTitle: string;
  nlmId: string;
};

const mismatches: Mismatch[] = [];
let pairs = { 'JCR.ISSN→Print': 0, 'JCR.ISSN→Online': 0, 'JCR.EISSN→Online': 0, 'JCR.EISSN→Print': 0 } as Record<string, number>;
let matchedJcr = 0;

for (const j of jcr) {
  const jIssn = norm(j.ISSN);
  const jEissn = norm(j.EISSN);
  const jName = normName(j.Name);

  const candidates: Array<{ via: string; code: string; rows: MedlineRecord[] }> = [];
  if (isValidIssn(jIssn)) {
    if (medByPrint.has(jIssn))   candidates.push({ via: 'JCR.ISSN→Print',  code: jIssn, rows: medByPrint.get(jIssn)!  });
    if (medByOnline.has(jIssn))  candidates.push({ via: 'JCR.ISSN→Online', code: jIssn, rows: medByOnline.get(jIssn)! });
  }
  if (isValidIssn(jEissn)) {
    if (medByOnline.has(jEissn)) candidates.push({ via: 'JCR.EISSN→Online', code: jEissn, rows: medByOnline.get(jEissn)! });
    if (medByPrint.has(jEissn))  candidates.push({ via: 'JCR.EISSN→Print',  code: jEissn, rows: medByPrint.get(jEissn)!  });
  }

  const seen = new Set<MedlineRecord>();
  let matched = false;
  for (const cand of candidates) {
    for (const f of cand.rows) {
      if (seen.has(f)) continue;
      seen.add(f);
      matched = true;
      pairs[cand.via] = (pairs[cand.via] ?? 0) + 1;
      const fName = normName(f.title);
      if (fName !== jName) {
        mismatches.push({
          via: cand.via,
          code: cand.code,
          jcrName: j.Name,
          medlineTitle: f.title,
          nlmId: f.nlmId,
        });
      }
    }
  }
  if (matched) matchedJcr++;
}

console.log(`JCR rows total:               ${jcr.length}`);
console.log(`Medline records total:        ${medline.length}`);
console.log(`JCR rows with any match:      ${matchedJcr}`);
for (const [k, v] of Object.entries(pairs)) console.log(`Pairs ${k.padEnd(18)} ${v}`);
console.log(`Name mismatches:              ${mismatches.length}`);
console.log('');
console.log('--- first 30 mismatches ---');
for (const m of mismatches.slice(0, 30)) {
  console.log(`[${m.via} ${m.code}  nlm=${m.nlmId}]`);
  console.log(`  JCR:     ${m.jcrName}`);
  console.log(`  Medline: ${m.medlineTitle}`);
}

const tsv = ['via\tcode\tnlm_id\tjcr_name\tmedline_title',
  ...mismatches.map(m => `${m.via}\t${m.code}\t${m.nlmId}\t${m.jcrName}\t${m.medlineTitle}`)].join('\n');
writeFileSync(join(__dirname, '..', 'medline_name_mismatches.tsv'), tsv, 'utf8');
console.log('');
console.log(`Full list written to medline_name_mismatches.tsv`);
