-- The access log is append-only at the database level, not only in application
-- code: a role that can reach the table still cannot rewrite or erase an entry.
-- Combined with the keyed hash chain, altering history needs both write access
-- and the key held by the secret manager.

CREATE OR REPLACE FUNCTION access_log_is_append_only() RETURNS trigger AS $$
BEGIN
    RAISE EXCEPTION 'access_log_entries is append-only: % is refused', TG_OP
        USING ERRCODE = 'restrict_violation';
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER access_log_entries_no_update
    BEFORE UPDATE ON "access_log_entries"
    FOR EACH ROW EXECUTE FUNCTION access_log_is_append_only();

CREATE TRIGGER access_log_entries_no_delete
    BEFORE DELETE ON "access_log_entries"
    FOR EACH ROW EXECUTE FUNCTION access_log_is_append_only();

CREATE TRIGGER access_log_entries_no_truncate
    BEFORE TRUNCATE ON "access_log_entries"
    FOR EACH STATEMENT EXECUTE FUNCTION access_log_is_append_only();

-- Sequence numbers are handed out by the database, so two concurrent requests
-- cannot land on the same position in the chain.
CREATE SEQUENCE access_log_sequence AS BIGINT START WITH 1 INCREMENT BY 1;
