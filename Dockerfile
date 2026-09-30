# Runs the app only — Postgres is a separate service in docker-compose.yml.
# Proton Bridge is NOT part of this image: it's a native per-OS app the user
# installs and logs into themselves (see README's Docker section for why that
# can't and shouldn't be automated away). This container just needs network
# access to Bridge's local IMAP/SMTP ports on the host machine.
FROM node:20-alpine

WORKDIR /app

COPY package.json package-lock.json ./
RUN npm ci --omit=dev

COPY . .
RUN chmod +x docker-entrypoint.sh

# Where the first-run setup wizard writes IMAP credentials, and where
# attachment blobs live — both point into /app/data, which docker-compose.yml
# mounts as a named volume so they survive image upgrades/container recreation.
ENV ENV_FILE_PATH=/app/data/.env
ENV ATTACHMENTS_DIR=/app/data/attachments

EXPOSE 4310

ENTRYPOINT ["./docker-entrypoint.sh"]
CMD ["node", "server.js"]
