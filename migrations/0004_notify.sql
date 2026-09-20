-- Not başına bildirim tercihi: kesin saat ve sabit tekrar aralığı.
-- Boş bırakılırsa liste ayarındaki kademeli kural işler.
ALTER TABLE todos ADD COLUMN notify_at INTEGER;
ALTER TABLE todos ADD COLUMN notify_every_h INTEGER;
