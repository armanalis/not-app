-- Kurtarma kodu: listeye yeni bir cihazdan geri dönmek için kalıcı kod.
ALTER TABLE lists ADD COLUMN recovery_code TEXT;
CREATE UNIQUE INDEX idx_lists_recovery ON lists(recovery_code) WHERE recovery_code IS NOT NULL;

-- Elle sıralama. Tarihli notlar zamana göre dizildiği için bu yalnızca tarihsizlerde etkili.
ALTER TABLE todos ADD COLUMN sort_order INTEGER NOT NULL DEFAULT 0;
UPDATE todos SET sort_order = created_at;

-- Temizlik taraması bu sütunu kullanır.
CREATE INDEX idx_devices_last_seen ON devices(last_seen_at);
