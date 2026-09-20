-- Listeler: bir listeyi birden fazla cihaz paylaşabilir (eşleştirme).
CREATE TABLE lists (
  id TEXT PRIMARY KEY,
  tz TEXT NOT NULL DEFAULT 'UTC',
  quiet_start INTEGER NOT NULL DEFAULT 23,
  quiet_end INTEGER NOT NULL DEFAULT 8,
  intensity TEXT NOT NULL DEFAULT 'normal',
  created_at INTEGER NOT NULL
);

ALTER TABLE devices ADD COLUMN list_id TEXT;
ALTER TABLE todos ADD COLUMN list_id TEXT;
ALTER TABLE todos ADD COLUMN repeat TEXT;

-- Her cihaz kendi listesiyle başlar.
INSERT INTO lists (id, tz, quiet_start, quiet_end, intensity, created_at)
  SELECT id, tz, 23, 8, 'normal', created_at FROM devices;
UPDATE devices SET list_id = id;
UPDATE todos SET list_id = device_id;

-- Eşleştirme kodları (kısa ömürlü).
CREATE TABLE pair_codes (
  code TEXT PRIMARY KEY,
  list_id TEXT NOT NULL,
  expires_at INTEGER NOT NULL
);

CREATE INDEX idx_todos_list ON todos(list_id, done);
CREATE INDEX idx_devices_list ON devices(list_id);
