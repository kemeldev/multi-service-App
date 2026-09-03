-- Optional. The services create their own tables at startup, so you do not
-- need this. Run it only if you want the schema to exist up front, or if the
-- app user is not allowed to CREATE TABLE.

CREATE TABLE IF NOT EXISTS py_heartbeat (
    id          BIGSERIAL PRIMARY KEY,
    service     TEXT        NOT NULL,
    host        TEXT        NOT NULL,
    message     TEXT        NOT NULL,
    created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS node_heartbeat (
    id          BIGSERIAL PRIMARY KEY,
    service     TEXT        NOT NULL,
    host        TEXT        NOT NULL,
    message     TEXT        NOT NULL,
    created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Handy checks once things are running:
--   SELECT COUNT(*), MAX(created_at) FROM py_heartbeat;
--   SELECT COUNT(*), MAX(created_at) FROM node_heartbeat;
