import { readFileSync, writeFileSync } from 'fs';
import { join } from 'path';

const INPUT = join(__dirname, '..', '2024_JCR_full.txt');
const OUTPUT = join(__dirname, '..', 'seed.sql');
const BATCH_SIZE = 500;

function escapeSQL(s: string): string {
  return s.replace(/'/g, "''");
}

function parseIF(raw: string): string {
  const v = raw.trim();
  if (v === '' || v === undefined) return 'NULL';
if (v === '<0.1') return '0.05';
  const n = parseFloat(v);
  return isNaN(n) ? 'NULL' : String(n);
}

function stripQuotes(s: string): string {
  const t = s.trim();
  if (t.startsWith('"') && t.endsWith('"')) {
    return t.slice(1, -1);
  }
  return t;
}

function main() {
  const raw = readFileSync(INPUT, 'utf-8');
  const lines = raw.split(/\r?\n/).filter(l => l.trim() !== '');

  const dataLines = lines.slice(1);
  console.log(`Parsed ${dataLines.length} data rows`);

const values: string[] = [];

  for (const line of dataLines) {
    const cols = line.split('\t');
    if (cols.length < 3) continue;

    const name = escapeSQL(cols[0]?.trim() ?? '');
const abbr = escapeSQL(cols[1]?.trim() ?? '');
    const group = escapeSQL(stripQuotes(cols[2] ?? ''));
    const issn = escapeSQL(cols[3]?.trim() ?? '');
    const eissn = escapeSQL(cols[4]?.trim() ?? '');
    const if2025 = parseIF(cols[5] ?? '');
    const fiveYearJIF = parseIF(cols[6] ?? '');
const quartile = escapeSQL(cols[7]?.trim() ??'');
    const jifRank = escapeSQL(cols[8]?.trim() ?? '');

    values.push(
      `('${name}','${abbr}','${group}','${issn}','${eissn}',${if2025},${fiveYearJIF},'${quartile}','${jifRank}')`
    );
  }

  const statements: string[] = [];
  for (let i = 0; i < values.length; i+= BATCH_SIZE) {
    const batch = values.slice(i, i + BATCH_SIZE);
    statements.push(
      `INSERT INTO journals (name, abbr, group_name, issn, eissn, if_2025, five_year_jif, quartile, jif_rank) VALUES\n${batch.join(',\n')};`
    );
  }

  writeFileSync(OUTPUT, statements.join('\n\n') + '\n', 'utf-8');
  console.log(`Generated ${OUTPUT} with ${statements.length} INSERT statements (${values.length} rows)`);
}

main();
