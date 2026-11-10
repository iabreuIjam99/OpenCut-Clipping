CREATE TABLE IF NOT EXISTS quota_counters (
  ip_hash TEXT NOT NULL,
  day TEXT NOT NULL,
  count INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (ip_hash, day)
)