-- Three roles, so no running service holds more power than it needs.
-- Run once as the PostgreSQL superuser:
--
--   sudo -u postgres psql -v app_pw="'...'" -v owner_pw="'...'" -v backup_pw="'...'" \
--     -f deploy/postgresql/roles.sql
--
-- (generate each password with `openssl rand -base64 24`; they never appear in
-- this file or in shell history because psql substitutes them from -v.)
--
--   df_owner   owns the schema; used ONLY for `npm run account-api:migrate`
--   df_app     what the account API runs as: data changes, no schema changes
--   df_backup  pg_dump: read-only

CREATE ROLE df_owner LOGIN PASSWORD :owner_pw;
CREATE ROLE df_app LOGIN PASSWORD :app_pw;
CREATE ROLE df_backup LOGIN PASSWORD :backup_pw;
-- A role a hijacked service could use to tie up the server is bounded.
ALTER ROLE df_app CONNECTION LIMIT 25;
ALTER ROLE df_backup CONNECTION LIMIT 3;

CREATE DATABASE deltafront OWNER df_owner ENCODING 'UTF8';
REVOKE ALL ON DATABASE deltafront FROM PUBLIC;
GRANT CONNECT ON DATABASE deltafront TO df_app, df_backup;

\connect deltafront

-- Migrations create the citext extension. It is a trusted extension, so the
-- database owner can create it; nothing here needs a superuser at runtime.
REVOKE ALL ON SCHEMA public FROM PUBLIC;
GRANT USAGE ON SCHEMA public TO df_app, df_backup;
GRANT CREATE ON SCHEMA public TO df_owner;

-- Everything df_owner creates later (each migration) is usable by the others.
ALTER DEFAULT PRIVILEGES FOR ROLE df_owner IN SCHEMA public
  GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO df_app;
ALTER DEFAULT PRIVILEGES FOR ROLE df_owner IN SCHEMA public
  GRANT USAGE, SELECT ON SEQUENCES TO df_app;
ALTER DEFAULT PRIVILEGES FOR ROLE df_owner IN SCHEMA public
  GRANT SELECT ON TABLES TO df_backup;
ALTER DEFAULT PRIVILEGES FOR ROLE df_owner IN SCHEMA public
  GRANT SELECT ON SEQUENCES TO df_backup;
