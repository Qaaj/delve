#!/bin/sh
# Applies the schema on every boot (idempotent — db/schema.sql is entirely
# CREATE ... IF NOT EXISTS) before starting whatever CMD was given. Doesn't
# touch IMAP config at all: schema setup only needs DATABASE_URL, which
# docker-compose.yml always sets to the db service — unlike Bridge
# credentials, there's nothing here for a first-run user to configure.
set -e

mkdir -p "$(dirname "$ENV_FILE_PATH")" "$ATTACHMENTS_DIR"

node scripts/setup-db.js

exec "$@"
