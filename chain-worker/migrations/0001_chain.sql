CREATE TABLE bindings (org_id TEXT NOT NULL, kind TEXT NOT NULL, record_id TEXT NOT NULL, binding_key TEXT NOT NULL, identity TEXT NOT NULL, PRIMARY KEY(org_id,kind,record_id), UNIQUE(kind,binding_key,record_id));
CREATE TABLE key_owners (binding_key TEXT PRIMARY KEY, org_id TEXT NOT NULL, merchant TEXT NOT NULL, customer TEXT);
CREATE TABLE events (id TEXT PRIMARY KEY, block_number TEXT NOT NULL, body TEXT NOT NULL);
CREATE TRIGGER events_no_update BEFORE UPDATE ON events BEGIN SELECT RAISE(ABORT,'append only'); END;
CREATE TRIGGER events_no_delete BEFORE DELETE ON events BEGIN SELECT RAISE(ABORT,'append only'); END;
CREATE TRIGGER events_no_replace BEFORE INSERT ON events WHEN EXISTS(SELECT 1 FROM events WHERE id=NEW.id) BEGIN SELECT RAISE(ABORT,'append only'); END;
CREATE TABLE runtime (id INTEGER PRIMARY KEY CHECK(id=1), cursor TEXT, lease TEXT, lease_until INTEGER NOT NULL DEFAULT 0 CHECK(lease_until>=0), fingerprint TEXT, halted TEXT);
INSERT INTO runtime(id) VALUES(1);
