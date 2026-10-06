PRAGMA foreign_keys = ON;
CREATE TABLE app_state (
  id INTEGER PRIMARY KEY CHECK(id = 1),
  revision INTEGER NOT NULL DEFAULT 1,
  cache_epoch INTEGER NOT NULL DEFAULT 1
);
INSERT INTO app_state(id) VALUES(1);
CREATE TABLE entities (
  id TEXT PRIMARY KEY,
  kind TEXT NOT NULL CHECK(kind IN ('sub','col','file')),
  name TEXT NOT NULL,
  data TEXT NOT NULL CHECK(json_valid(data)),
  version INTEGER NOT NULL DEFAULT 1,
  sort_order INTEGER NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  UNIQUE(kind,name)
);
CREATE INDEX entities_kind_order ON entities(kind,sort_order,id);
CREATE TABLE collection_members (
  collection_id TEXT NOT NULL REFERENCES entities(id) ON DELETE CASCADE,
  subscription_id TEXT NOT NULL REFERENCES entities(id) ON DELETE CASCADE,
  position INTEGER NOT NULL,
  PRIMARY KEY(collection_id,subscription_id)
);
CREATE INDEX collection_members_sub ON collection_members(subscription_id);
CREATE TABLE settings (
  key TEXT PRIMARY KEY,
  data TEXT NOT NULL CHECK(json_valid(data)),
  version INTEGER NOT NULL DEFAULT 1
);
INSERT INTO settings(key,data) VALUES('settings','{}');
CREATE TABLE share_tokens (
  token TEXT PRIMARY KEY,
  target_id TEXT NOT NULL REFERENCES entities(id) ON DELETE CASCADE,
  type TEXT NOT NULL CHECK(type IN ('sub','col','file')),
  data TEXT NOT NULL CHECK(json_valid(data)),
  exp INTEGER,
  max_count INTEGER CHECK(max_count IS NULL OR max_count > 0),
  used_count INTEGER NOT NULL DEFAULT 0 CHECK(used_count >= 0),
  sort_order INTEGER NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL
);
CREATE INDEX share_tokens_target ON share_tokens(target_id,sort_order);
CREATE TABLE admin_sessions (
  token_hash TEXT PRIMARY KEY,
  expires_at INTEGER NOT NULL
);
CREATE INDEX admin_sessions_expiry ON admin_sessions(expires_at);
CREATE TABLE login_attempts (
  ip_hash TEXT PRIMARY KEY,
  window_start INTEGER NOT NULL,
  count INTEGER NOT NULL
);
CREATE TABLE resource_cache (
  key TEXT PRIMARY KEY,
  epoch INTEGER NOT NULL,
  body TEXT NOT NULL,
  flow TEXT,
  expires_at INTEGER NOT NULL,
  created_at INTEGER NOT NULL
);
CREATE INDEX resource_cache_expiry ON resource_cache(expires_at);
CREATE TABLE logs (
  id TEXT PRIMARY KEY,
  time INTEGER NOT NULL,
  level TEXT NOT NULL,
  message TEXT NOT NULL
);
CREATE INDEX logs_time ON logs(time);
-- Guards exist only inside an atomic batch and are removed before its commit.
CREATE TABLE mutation_guards (
  request_id TEXT PRIMARY KEY,
  expected_revision INTEGER NOT NULL,
  valid INTEGER NOT NULL CHECK(valid = 1)
);
CREATE TRIGGER mutation_revision_guard BEFORE INSERT ON mutation_guards
WHEN NEW.expected_revision != (SELECT revision FROM app_state WHERE id = 1)
BEGIN SELECT RAISE(ABORT,'VERSION_CONFLICT'); END;

