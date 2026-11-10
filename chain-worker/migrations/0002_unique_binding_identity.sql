-- A charge may back one invoice and one payment, never multiple records of either kind.
-- Fail migration rather than silently choose an identity if historical duplicates exist.
CREATE UNIQUE INDEX bindings_one_record_per_key_kind ON bindings(kind,binding_key);
