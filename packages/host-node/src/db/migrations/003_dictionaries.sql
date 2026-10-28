-- Local Yomitan v3 dictionaries (spec: kotori_dictionary_design_proposal §4).
-- `status = 'importing'` rows are invisible to lookups and purged on startup;
-- blue-green updates import under a fresh id and swap in one transaction.
CREATE TABLE dictionaries (
  id TEXT PRIMARY KEY,
  title TEXT NOT NULL,
  revision TEXT NOT NULL DEFAULT '',
  kind TEXT NOT NULL DEFAULT 'term',
  status TEXT NOT NULL DEFAULT 'importing',
  priority INTEGER NOT NULL DEFAULT 0,
  enabled INTEGER NOT NULL DEFAULT 1,
  term_count INTEGER NOT NULL DEFAULT 0,
  meta_count INTEGER NOT NULL DEFAULT 0,
  attribution TEXT,
  source_url TEXT,
  index_url TEXT,
  imported_at INTEGER NOT NULL
);

CREATE INDEX idx_dictionaries_status ON dictionaries (status, priority);

-- One compacted `term_bank` row (senses already reduced to `CompactSense[]`).
CREATE TABLE dict_terms (
  dict_id TEXT NOT NULL REFERENCES dictionaries (id) ON DELETE CASCADE,
  seq INTEGER NOT NULL,
  expression TEXT NOT NULL,
  reading TEXT NOT NULL DEFAULT '',
  def_tags TEXT NOT NULL DEFAULT '',
  rules TEXT NOT NULL DEFAULT '',
  score INTEGER NOT NULL DEFAULT 0,
  sequence_id INTEGER NOT NULL DEFAULT 0,
  redirect_to TEXT,
  senses_json TEXT NOT NULL DEFAULT '[]',
  PRIMARY KEY (dict_id, seq)
);

CREATE INDEX idx_dict_terms_expr ON dict_terms (expression);
CREATE INDEX idx_dict_terms_reading ON dict_terms (reading) WHERE reading != '';

-- All `term_meta_bank` rows of one (dict, expression, mode) merged into one JSON array.
CREATE TABLE dict_meta (
  dict_id TEXT NOT NULL REFERENCES dictionaries (id) ON DELETE CASCADE,
  expression TEXT NOT NULL,
  mode TEXT NOT NULL,
  data_json TEXT NOT NULL,
  PRIMARY KEY (dict_id, expression, mode)
);

CREATE INDEX idx_dict_meta_lookup ON dict_meta (expression, mode);
