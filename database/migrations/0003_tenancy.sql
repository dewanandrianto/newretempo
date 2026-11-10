-- 0003_tenancy: organizations and memberships.

CREATE TABLE organizations (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  name            TEXT NOT NULL CHECK (length(name) BETWEEN 2 AND 80),
  slug            TEXT NOT NULL CHECK (slug ~ '^[a-z0-9][a-z0-9-]{1,38}[a-z0-9]$'),
  website         TEXT,
  industry        TEXT NOT NULL,
  country         TEXT NOT NULL,
  status          TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'archived')),
  created_by      UUID NOT NULL REFERENCES users (id),
  invoice_counter BIGINT NOT NULL DEFAULT 0 CHECK (invoice_counter >= 0),  -- gapless invoice numbers
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX organizations_slug_key ON organizations (slug);

CREATE TABLE memberships (
  id         UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id     UUID NOT NULL REFERENCES organizations (id) ON DELETE CASCADE,
  user_id    UUID NOT NULL REFERENCES users (id) ON DELETE CASCADE,
  role       TEXT NOT NULL CHECK (role IN ('owner', 'admin', 'member')),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (org_id, user_id)
);
CREATE INDEX memberships_user_idx ON memberships (user_id);

-- An organization can never be left without an owner (unless the org itself is being deleted).
CREATE OR REPLACE FUNCTION memberships_keep_owner() RETURNS trigger AS $$
BEGIN
  IF OLD.role = 'owner' AND (TG_OP = 'DELETE' OR NEW.role <> 'owner')
     AND EXISTS (SELECT 1 FROM organizations WHERE id = OLD.org_id)
     AND NOT EXISTS (
       SELECT 1 FROM memberships
       WHERE org_id = OLD.org_id AND role = 'owner' AND id <> OLD.id
     ) THEN
    RAISE EXCEPTION 'organization must keep at least one owner' USING ERRCODE = '23514';
  END IF;
  RETURN CASE WHEN TG_OP = 'DELETE' THEN OLD ELSE NEW END;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER memberships_keep_owner_trg BEFORE UPDATE OR DELETE ON memberships
  FOR EACH ROW EXECUTE FUNCTION memberships_keep_owner();
CREATE TRIGGER organizations_updated BEFORE UPDATE ON organizations FOR EACH ROW EXECUTE FUNCTION set_updated_at();
CREATE TRIGGER memberships_updated BEFORE UPDATE ON memberships FOR EACH ROW EXECUTE FUNCTION set_updated_at();
