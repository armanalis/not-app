CREATE TABLE devices (
  id TEXT PRIMARY KEY,
  tz TEXT NOT NULL DEFAULT 'UTC',
  subscription TEXT,
  created_at INTEGER NOT NULL,
  last_seen_at INTEGER NOT NULL
);

CREATE TABLE todos (
  id TEXT PRIMARY KEY,
  device_id TEXT NOT NULL REFERENCES devices(id) ON DELETE CASCADE,
  title TEXT NOT NULL,
  deadline INTEGER,
  done INTEGER NOT NULL DEFAULT 0,
  next_notify_at INTEGER,
  last_notified_at INTEGER,
  created_at INTEGER NOT NULL
);

CREATE INDEX idx_todos_device ON todos(device_id);
CREATE INDEX idx_todos_due ON todos(done, next_notify_at);
