-- Admission is serialized inside D1, not a race-prone read/count followed by insert.
-- Existing over-capacity tenants are not rewritten; their snapshots remain explicitly unavailable.
CREATE TRIGGER bindings_capacity BEFORE INSERT ON bindings BEGIN
  SELECT CASE WHEN (SELECT COUNT(*) FROM bindings WHERE org_id=NEW.org_id) >= 32
    THEN RAISE(ABORT,'Binding capacity exceeded') END;
  SELECT CASE WHEN (
    WITH proposed AS (
      SELECT kind,identity FROM bindings WHERE org_id=NEW.org_id
      UNION ALL SELECT NEW.kind,NEW.identity
    ), getters AS (
      SELECT DISTINCT value FROM proposed, json_each(CASE kind
        WHEN 'plan' THEN json_array('plan:' || json_extract(identity,'$.key'))
        WHEN 'subscription' THEN json_array('plan:' || json_extract(identity,'$.planKey'),
          'subscription:' || json_extract(identity,'$.key'), 'mandate:' || json_extract(identity,'$.key'))
        WHEN 'escrow' THEN json_array('escrow:' || json_extract(identity,'$.key'),
          'balance:' || json_extract(identity,'$.key'), 'claimable:' || json_extract(identity,'$.key'))
        ELSE json_array() END)
    ) SELECT COUNT(*) FROM getters
  ) > 26 THEN RAISE(ABORT,'Binding capacity exceeded') END;
END;
