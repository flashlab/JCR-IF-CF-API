import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const JCR_INPUT   = join(__dirname, '..', 'Clinicalscientists_JIF2024.csv');
const FENQU_INPUT = join(__dirname, '..', 'Fenqu_2026.csv');

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
        if (raw[i + 1] === '"') {
          field += '"';
          i++;
        } else {
          inQuotes = false;
        }
      } else {
        field += ch;
      }
    } else {
      if (ch === '"') {
        inQuotes = true;
      } else if (ch === ',') {
        row.push(field);
        field = '';
      } else if (ch === '\r') {
        // swallow; handled by \n
      } else if (ch === '\n') {
        row.push(field);
        field = '';
        rows.push(row);
        row = [];
      } else {
        field += ch;
      }
    }
  }
  if (field.length > 0 || row.length > 0) {
    row.push(field);
    rows.push(row);
  }
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

const norm = (s: string) => (s ?? '').trim().toUpperCase();
const normName = (s: string) => norm(s).replace(/\s+/g, ' ');
const isValidIssn = (s: string) => /^\d{4}-\d{3}[\dX]$/.test(norm(s));

const jcr = readCsvAsObjects(JCR_INPUT);
const fenqu = readCsvAsObjects(FENQU_INPUT);

const fenquByIssn = new Map<string, Record<string, string>[]>();
const fenquByEissn = new Map<string, Record<string, string>[]>();
for (const r of fenqu) {
  const issn = norm(r.ISSN);
  const eissn = norm(r.EISSN);
  if (isValidIssn(issn)) {
    if (!fenquByIssn.has(issn)) fenquByIssn.set(issn, []);
    fenquByIssn.get(issn)!.push(r);
  }
  if (isValidIssn(eissn)) {
    if (!fenquByEissn.has(eissn)) fenquByEissn.set(eissn, []);
    fenquByEissn.get(eissn)!.push(r);
  }
}

type Mismatch = {
  via: string;
  code: string;
  jcrName: string;
  fenquName: string;
};

const mismatches: Mismatch[] = [];
let issnPairs = 0;
let eissnPairs = 0;
let crossPairs = 0;
let totalMatchedJcr = 0;

for (const j of jcr) {
  const jIssn = norm(j.ISSN);
  const jEissn = norm(j.EISSN);
  const jName = normName(j.Name);

  const candidates: Array<{ via: string; code: string; rows: Record<string, string>[] }> = [];
  if (isValidIssn(jIssn)) {
    if (fenquByIssn.has(jIssn)) candidates.push({ via: 'ISSN→ISSN',   code: jIssn, rows: fenquByIssn.get(jIssn)! });
    if (fenquByEissn.has(jIssn)) candidates.push({ via: 'ISSN→EISSN',  code: jIssn, rows: fenquByEissn.get(jIssn)! });
  }
  if (isValidIssn(jEissn)) {
    if (fenquByEissn.has(jEissn)) candidates.push({ via: 'EISSN→EISSN', code: jEissn, rows: fenquByEissn.get(jEissn)! });
    if (fenquByIssn.has(jEissn))  candidates.push({ via: 'EISSN→ISSN',  code: jEissn, rows: fenquByIssn.get(jEissn)!  });
  }

  const seen = new Set<Record<string, string>>();
  let matched = false;
  for (const cand of candidates) {
    for (const f of cand.rows) {
      if (seen.has(f)) continue;
      seen.add(f);
      matched = true;
      if (cand.via === 'ISSN→ISSN') issnPairs++;
      else if (cand.via === 'EISSN→EISSN') eissnPairs++;
      else crossPairs++;
      const fName = normName(f.Name);
      if (fName !== jName) {
        mismatches.push({
          via: cand.via,
          code: cand.code,
          jcrName: j.Name,
          fenquName: f.Name,
        });
      }
    }
  }
  if (matched) totalMatchedJcr++;
}

console.log(`JCR rows total:           ${jcr.length}`);
console.log(`Fenqu rows total:         ${fenqu.length}`);
console.log(`JCR rows with any match:  ${totalMatchedJcr}`);
console.log(`Pairs ISSN  → ISSN:       ${issnPairs}`);
console.log(`Pairs EISSN → EISSN:      ${eissnPairs}`);
console.log(`Pairs cross-matched:      ${crossPairs}`);
console.log(`Name mismatches:          ${mismatches.length}`);
console.log('');
console.log('--- first 30 mismatches ---');
for (const m of mismatches.slice(0, 30)) {
  console.log(`[${m.via} ${m.code}]`);
  console.log(`  JCR:   ${m.jcrName}`);
  console.log(`  Fenqu: ${m.fenquName}`);
}

const tsv = ['via\tcode\tjcr_name\tfenqu_name', ...mismatches.map(m => `${m.via}\t${m.code}\t${m.jcrName}\t${m.fenquName}`)].join('\n');
writeFileSync(join(__dirname, '..', 'name_mismatches.tsv'), tsv, 'utf8');
console.log('');
console.log(`Full list written to name_mismatches.tsv`);
