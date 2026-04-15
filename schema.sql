DROP TABLE IF EXISTS fenqu_fts;
DROP TABLE IF EXISTS journals_fts;
DROP TABLE IF EXISTS fenqu;
DROP TABLE IF EXISTS journals;

CREATE TABLE journals (
  id                     INTEGER PRIMARY KEY AUTOINCREMENT,
  rank                   INTEGER,
  name                   TEXT NOT NULL,
  abbr                   TEXT NOT NULL,
  qname                  TEXT NOT NULL,
  qabbr                  TEXT NOT NULL,
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
  -- Denormalized pointer into fenqu.id (ISSN → EISSN → qname priority).
  -- Populated once at seed time; replaces the 3-branch COALESCE at query time.
  fenqu_id               INTEGER
);

CREATE INDEX idx_qname  ON journals (qname);
CREATE INDEX idx_qabbr  ON journals (qabbr);
CREATE INDEX idx_issn   ON journals (issn);
CREATE INDEX idx_eissn  ON journals (eissn);

CREATE TABLE fenqu (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  name         TEXT NOT NULL,
  qname        TEXT NOT NULL,
  issn         TEXT DEFAULT '',
  eissn        TEXT DEFAULT '',
  lang         TEXT DEFAULT '',
  publisher    TEXT DEFAULT '',
  db_source    TEXT DEFAULT '',
  dalei_en     TEXT DEFAULT '',
  dalei_zh     TEXT DEFAULT '',
  fenqu        TEXT DEFAULT '',
  is_top       TEXT DEFAULT '',
  xiaolei_info TEXT DEFAULT ''
);

CREATE INDEX idx_fenqu_qname ON fenqu (qname);
CREATE INDEX idx_fenqu_issn  ON fenqu (issn);
CREATE INDEX idx_fenqu_eissn ON fenqu (eissn);

-- FTS5 trigram indexes accelerate substring (f=2) and suffix (f=3) searches.
-- content=/content_rowid= binds the FTS to the base-table rowid so no text is duplicated;
-- case_sensitive=0 lets MATCH tolerate case differences against the uppercased qname/qabbr.
CREATE VIRTUAL TABLE journals_fts USING fts5(
  qname,
  qabbr,
  content='journals',
  content_rowid='id',
  tokenize="trigram case_sensitive 0"
);

CREATE VIRTUAL TABLE fenqu_fts USING fts5(
  qname,
  content='fenqu',
  content_rowid='id',
  tokenize="trigram case_sensitive 0"
);
