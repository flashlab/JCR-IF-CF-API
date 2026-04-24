DROP TABLE IF EXISTS medline_fts;
DROP TABLE IF EXISTS medline;
DROP TABLE IF EXISTS journals_fts;
DROP TABLE IF EXISTS fenqu_fts;
DROP TABLE IF EXISTS fenqu;
DROP TABLE IF EXISTS journals;

-- Flat journals table: JCR + Fenqu fields merged at export time
-- (Clinicalscientists_JIF2024_integrated_Fenqu_2026.csv). fenqu_only rows
-- keep JCR columns empty; jcr_only rows keep Fenqu columns empty.
CREATE TABLE journals (
  id                     INTEGER PRIMARY KEY AUTOINCREMENT,
  rank                   INTEGER,
  name                   TEXT NOT NULL,
  abbr                   TEXT DEFAULT '',
  qname                  TEXT NOT NULL,
  qabbr                  TEXT DEFAULT '',
  publisher              TEXT DEFAULT '',
  issn                   TEXT DEFAULT '',
  eissn                  TEXT DEFAULT '',
  total_cites            INTEGER,
  total_articles         INTEGER,
  citable_items          INTEGER,
  cited_half_life        REAL,
  citing_half_life       REAL,
  jif_2024               REAL,
  five_year_jif          REAL,
  jif_without_self_cites REAL,
  jci                    REAL,
  jif_quartile           TEXT DEFAULT '',
  jif_rank               TEXT DEFAULT '',
  lang                   TEXT DEFAULT '',
  db_source              TEXT DEFAULT '',
  dalei_en               TEXT DEFAULT '',
  dalei_zh               TEXT DEFAULT '',
  fenqu                  TEXT DEFAULT '',
  is_top                 TEXT DEFAULT '',
  xiaolei_info           TEXT DEFAULT ''
);

-- idx_qname / idx_qabbr are covering indexes: leading column drives the
-- B-tree range/equality scan (exact and f=1 prefix), trailing columns carry
-- the default API projection (name, abbr, jif_2024, jif_quartile, fenqu,
-- is_top) so the planner can satisfy the hot path without a row lookup.
-- show_all=1 still falls back to a table read.
CREATE INDEX idx_qname ON journals (qname, name, abbr, jif_2024, jif_quartile, fenqu, is_top);
CREATE INDEX idx_qabbr ON journals (qabbr, name, abbr, jif_2024, jif_quartile, fenqu, is_top);
CREATE INDEX idx_issn  ON journals (issn);
CREATE INDEX idx_eissn ON journals (eissn);

-- Medline alias table sourced from J_Medline.txt. journals_id is pre-computed
-- at seed time via ISSN(Print) → EISSN → ISSN(Online)-vs-EISSN → ABBR priority;
-- NULL journals_id = orphan (record exists only in NLM list).
CREATE TABLE medline (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  journals_id INTEGER,
  name        TEXT NOT NULL,
  abbr        TEXT DEFAULT '',
  qname       TEXT NOT NULL,
  qabbr       TEXT DEFAULT '',
  issn        TEXT DEFAULT '',
  eissn       TEXT DEFAULT '',
  nlm_id      TEXT DEFAULT ''
);

CREATE INDEX idx_med_qname       ON medline (qname);
CREATE INDEX idx_med_qabbr       ON medline (qabbr);
CREATE INDEX idx_med_issn        ON medline (issn);
CREATE INDEX idx_med_eissn       ON medline (eissn);
CREATE INDEX idx_med_journals_id ON medline (journals_id);

-- Contentless FTS5 trigram indexes accelerate f=2 (substring) / f=3 (suffix)
-- searches. Two tables, one per base table. case_sensitive=0 lets MATCH tolerate
-- case differences against the uppercased qname/qabbr.
CREATE VIRTUAL TABLE journals_fts USING fts5(
  qname,
  qabbr,
  content='journals',
  content_rowid='id',
  tokenize="trigram case_sensitive 0"
);

CREATE VIRTUAL TABLE medline_fts USING fts5(
  qname,
  qabbr,
  content='medline',
  content_rowid='id',
  tokenize="trigram case_sensitive 0"
);
