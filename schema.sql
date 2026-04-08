DROP TABLE IF EXISTS journals;

CREATE TABLE journals (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  name          TEXT NOT NULL,
  abbr          TEXT NOT NULL,
  group_name    TEXT NOT NULL,
  issn          TEXT DEFAULT '',
  eissn         TEXT DEFAULT '',
  if_2025       REAL,
  five_year_jif REAL,
  quartile      TEXT DEFAULT '',
  jif_rank      TEXT DEFAULT ''
);

CREATE INDEX idx_name ON journals (name COLLATE NOCASE);
CREATE INDEX idx_abbr ON journals (abbr COLLATE NOCASE);
CREATE INDEX idx_group ON journals (group_name COLLATE NOCASE);
CREATE INDEX idx_if ON journals (if_2025);
CREATE INDEX idx_quartile ON journals (quartile);
