# delve

Proton Mail's own search doesn't index message bodies. This project pulls every
email out of Proton (via Proton Bridge/IMAP) into Postgres with real full-text
search over subject, sender, **and body** — plus Google-style search operators,
an attachment grid, optional local-LLM categorization, thread grouping, and a
compose/reply UI. It's a single-user, self-hosted Gmail-style overlay on top of
your own Proton account.

## Two-tier design

The project is deliberately split so it works with or without a local LLM:

- **Core (Postgres + IMAP only)** — sync, full-text search, attachments,
  threading, compose/reply/forward. No external dependency beyond Proton
  Bridge and Postgres.
- **Optional AI layer** (`lib/categorize.js` + `scripts/categorize.js`) — a
  separate batch job that talks to a local [LM Studio](https://lmstudio.ai)
  server to tag each email with a domain/subcategory, extract structured
  facts (amount, currency, reference number, company), and summarize it.
  **Never triggered automatically** by `server.js` — you run it by hand.

The frontend detects at runtime whether *any* row has ever been categorized
(`GET /api/categories`) and hides all category UI if not — so the exact same
codebase works for someone who never touches the AI layer at all.

## Installation

Two paths, depending on who you are.

### Docker (recommended — no terminal skills needed after this)

Requires **macOS + [Docker Desktop](https://www.docker.com/products/docker-desktop/)**
(other platforms aren't supported by this path yet — see
[Docker packaging notes](#docker-packaging-notes)) and
**[Proton Mail Bridge](https://proton.me/mail/bridge)**, installed and logged
into your real Proton account (Bridge handles that login itself — nothing
here ever sees your real Proton password).

```bash
git clone https://github.com/Qaaj/delve.git && cd delve
./install.sh
```

That builds the app, starts it alongside its own Postgres container, and
opens `http://localhost:4310` in your browser. You'll land on a short setup
page asking for the local username/password Bridge shows under your account →
"Mailbox configuration" — paste those in, and the app restarts itself into
the full search UI and starts syncing automatically. No `.env` file, no
terminal commands beyond the one above. The AI categorization layer isn't
part of this path — see [Two-tier design](#two-tier-design) if you want it
later, that's a separate manual step regardless of which install path you use.

### Manual (for development, or non-macOS)

**Start Proton Bridge** and make sure your account is added. Open Bridge →
your account → "Mailbox configuration" and note the host/port/username/
password it shows (a Bridge-generated local password, not your real Proton
password — Bridge also exposes local SMTP on the same host, used for sending).

```bash
git clone https://github.com/Qaaj/delve.git && cd delve
npm install
cp .env.example .env
```

Edit `.env` — fill in `IMAP_USER`/`IMAP_PASSWORD` from Bridge. `DATABASE_URL`
should already point at a Postgres database you've created. See
[Configuration](#configuration) below for every variable this project reads.

Then create/update the schema (idempotent, safe to re-run anytime — every
statement is `CREATE ... IF NOT EXISTS` / `ADD COLUMN IF NOT EXISTS`):

```bash
npm run setup-db
```

Import your mail (Proton Bridge must be running and unlocked):

```bash
nohup node scripts/import.js > /dev/null 2>&1 &
tail -f logs/import-*.log
```

This walks every mailbox Bridge exposes, fetches each unique message's full
body exactly once no matter how many labels/folders it lives under, and skips
anything already imported. Safe to Ctrl‑C and resume later — see
[How sync works](#how-sync-works).

Then run the app:

```bash
npm start
```

Opens on `http://localhost:4310` (or `$PORT`). `server.js` runs a sync
immediately on startup and then every 5 minutes for as long as it's running —
see [How sync works](#how-sync-works) for exactly what that does.

## Docker packaging notes

The Docker path (`Dockerfile`, `docker-compose.yml`, `docker-entrypoint.sh`,
`install.sh`, `public/setup.html`) was built and verified end-to-end
2026-09-30: a fresh container with no config correctly serves only the setup
wizard (`GET /api/setup` gated by whether `IMAP_USER`/`IMAP_PASSWORD` are
set — see the top of `server.js`); bad credentials are rejected live via a
real IMAP connect/logout test before anything is written to disk; good
credentials get written to a Docker-volume-persisted `.env`
(`ENV_FILE_PATH=/app/data/.env`), after which the process exits and Docker's
`restart: unless-stopped` policy brings it back up already configured — no
manual restart step for the user. Verified the restarted container actually
reaches Bridge and starts syncing.

What's real today vs. what "one curl command" implies but isn't built yet:

- **Proton Bridge itself is never inside Docker and never will be** — it's a
  native per-OS app that needs an interactive login to your real Proton
  account (2FA included), which is exactly the kind of thing you don't want a
  random install script doing on your behalf. "Install our app" and "install
  Bridge" stay two separate steps by design, not an oversight.
- **There's no published Docker image yet** — `install.sh` builds the image
  locally from source (`docker compose up -d --build`), which means the repo
  has to be cloned first. A true `curl -sSL https://.../install.sh | bash`
  that needs no local clone would mean: (1) this project living somewhere
  with a real public/private URL, and (2) a CI job that builds and pushes an
  image to a registry (Docker Hub or GHCR) on release, with `docker-compose.yml`
  changed from `build: .` to `image: <published tag>`. Neither exists yet —
  worth doing once this is ready to hand to an actual non-technical person.
- **Only macOS + Docker Desktop is supported.** `host.docker.internal`
  (how the container reaches Bridge running on the host) is automatic there;
  plain Docker Engine on Linux needs an explicit
  `extra_hosts: ["host.docker.internal:host-gateway"]` entry, and Bridge's
  Linux install path (deb/rpm/AppImage) differs from macOS/Windows. Untested,
  not documented, on purpose — scoped out for the first version.

## How sync works

Two independent scripts, both incremental/resumable, sharing their actual
scan/fetch/insert logic via `lib/emailImport.js`:

- **`scripts/import.js`** — the primary importer. Tracks a per-mailbox IMAP UID
  watermark in `import_state`, so a re-run only asks Bridge about UIDs it
  hasn't seen before. Efficient for the bulk 20-year-archive case.
- **`scripts/catchup-recent.js`** — a stateless safety net. Every run
  re-examines the last `CATCHUP_WINDOW` messages (default 1000) in every
  mailbox from scratch and imports whatever isn't already in Postgres by
  Message-ID — no watermark, nothing persisted about "where it left off".
  This exists because Proton Bridge's local index has real, confirmed bugs
  (see below); a watermark that trusts "I've handled everything up to UID N"
  is vulnerable to Bridge briefly lying about what UID N actually is. Both
  scripts run back-to-back on `server.js`'s sync cycle and via the manual
  "Sync" button in the UI.

### Proton Bridge quirks this project works around

Confirmed empirically (2026-09-29), not assumptions:

- **UID↔content mapping can shift without a `UIDVALIDITY` change** (which the
  IMAP spec says should never happen) — the same UID number pointed at
  different message content minutes apart, on the same connection.
- **A single-UID fetch can return a neighboring UID's content**, honestly
  labeled as that neighbor — not corrupted data, just plain misrouting at the
  protocol level. `SEARCH` confirms the UID exists; every `FETCH` variant
  (flags, bodystructure, envelope, source) for it returns the wrong message.
- **A small batch fetch can silently drop one requested UID** while
  substituting an entirely unrequested one.

`ghost_uids` tracks any UID that failed to resolve, so it gets retried before
either script gives up on it. The two scripts use different give-up policies
on purpose:

- `import.js` still gives up after **1 hour** (`GHOST_RETRY_WINDOW_MS`) —
  it has to, because its watermark can't advance past an unresolved UID, so
  one permanently-dead historical UID would otherwise freeze all future
  import progress for that mailbox.
- `catchup-recent.js` **never gives up** — it's stateless, so there's no
  upside to expiring a ghost, only the downside of silently dropping real
  mail that can (confirmed) take Bridge several hours to stabilize on its
  own. It also explicitly re-attempts every previously-recorded ghost for a
  mailbox each run (capped by `GHOST_RETRY_BATCH_LIMIT`), not just ones
  inside its current scan window — otherwise a ghost that scrolled outside
  the window would never be retried again by anything.
- Both scripts insert via **content**, not UID trust: a message is only ever
  considered "handled" by matching its parsed `Message-ID` against what's
  already in Postgres, never by trusting an echoed UID at face value.

## Database schema

Full source: [db/schema.sql](db/schema.sql). Applied via `npm run setup-db`.

### `emails` — one row per unique `message_id`

Core fields:

| Column | Type | Notes |
|---|---|---|
| `id` | `BIGSERIAL PK` | |
| `message_id` | `TEXT UNIQUE NOT NULL` | RFC Message-ID; the identity every other table keys off of |
| `subject`, `from_address`, `from_name`, `to_address`, `cc` | `TEXT` | |
| `email_date` | `TIMESTAMPTZ` | Parsed via `lib/parseDate.js` (guards against missing/spoofed `Date` headers — never fabricated) |
| `body_text`, `body_html` | `TEXT` | Truncated at import (`IMPORT_MAX_BODY_CHARS`/`IMPORT_MAX_HTML_CHARS`) |
| `attachments` | `JSONB` | Raw attachment metadata captured at parse time (see also `email_attachments` below) |
| `labels` | `TEXT[]` | A message can live under several Proton folders/labels at once |
| `size_bytes` | `INTEGER` | |
| `pm_internal_id` | `TEXT` | Proton's own internal ID (from `X-Pm-Internal-Id`) — same ID Proton's web app uses in its URLs, so it can deep-link back into real Proton Mail |
| `search_vector` | `tsvector`, generated | Subject weight A, sender weight B, body weight C — GIN-indexed |

Threading/header fields (backfilled 2026-09-29, captured live for new mail):

| Column | Type | Notes |
|---|---|---|
| `in_reply_to` | `TEXT` | |
| `thread_references` | `TEXT[]` | Full `References` chain |
| `reply_to_address`, `reply_to_name` | `TEXT` | |
| `list_id` | `TEXT` | |
| `unsubscribe_url`, `unsubscribe_mailto`, `unsubscribe_one_click` | `TEXT`/`TEXT`/`BOOLEAN` | From `List-Unsubscribe`/`List-Unsubscribe-Post` |
| `importance` | `TEXT` | `'high'`\|`'normal'`\|`'low'`, or NULL |
| `headers_backfilled_at` | `TIMESTAMPTZ` | NULL = not checked yet; set (even with NULL fields) = checked, genuinely absent |
| `thread_key` | `TEXT` | Conversation grouping key — see [Threading](#threading) |

AI categorization fields (see [Two-tier design](#two-tier-design); all NULL until `scripts/categorize.js` runs):

| Column | Type | Notes |
|---|---|---|
| `domain`, `subcategory` | `TEXT` | Two-level taxonomy, see `lib/categorize.js` |
| `domain_confidence`, `subcategory_confidence`, `urgency`, `needs_reply`, `is_automated`, `unsubscribe_candidate`, `attachment_worth_keeping` | `REAL` | Raw model probabilities/expectations, not pre-thresholded — the query layer picks its own cutoff |
| `summary` | `TEXT` | |
| `amount`, `currency`, `reference_number`, `key_date` | `REAL`/`TEXT`/`TEXT`/`DATE` | Facts extracted at the same pass, no extra round trip |
| `company` | `TEXT` | Normalized brand name (e.g. "Amazon"), not a raw sender domain |
| `secondary_domains` | `TEXT[]` | |
| `categorize_version` | `TEXT` | Bumping `CATEGORY_VERSION` in `lib/categorize.js` re-queues every row for re-categorization, like a mailbox-wide `uid_validity` change |
| `categorized_at` | `TIMESTAMPTZ` | |

Tracking columns:

| Column | Type | Notes |
|---|---|---|
| `created_at` | `TIMESTAMPTZ` | Row insert time |
| `attachments_stored_at` | `TIMESTAMPTZ` | NULL = attachments not yet extracted to disk |

### `import_state` — per-mailbox IMAP UID watermark (used only by `import.js`)

| Column | Type |
|---|---|
| `mailbox` | `TEXT PK` |
| `uid_validity` | `TEXT` |
| `last_seen_uid` | `INTEGER` |
| `updated_at` | `TIMESTAMPTZ` |

### `ghost_uids` — UIDs that failed to fetch/verify, pending retry

| Column | Type |
|---|---|
| `mailbox`, `uid_validity`, `uid` | `TEXT`/`TEXT`/`INTEGER` — composite PK |
| `first_seen_at` | `TIMESTAMPTZ` |
| `attempts` | `INTEGER` |

See [Proton Bridge quirks](#proton-bridge-quirks-this-project-works-around) above.

### Attachment storage — content-addressed, shared by imported mail and compose

`attachment_blobs` (one row per unique file, by MD5):

| Column | Type |
|---|---|
| `md5` | `TEXT PK` |
| `ext`, `content_type` | `TEXT` |
| `size_bytes` | `INTEGER` |
| `created_at` | `TIMESTAMPTZ` |

Bytes live on disk at `{ATTACHMENTS_DIR}/{ext}/{md5}{ext}` (see
`lib/attachments.js`) — never in Postgres, and the path is never stored,
always recomputed, so relocating the folder needs no migration.

`email_attachments` (one row per email↔blob instance — same blob can back many
emails under different filenames, e.g. forwards):

| Column | Type |
|---|---|
| `id` | `BIGSERIAL PK` |
| `email_id` | `BIGINT` → `emails(id)` |
| `blob_md5` | `TEXT` → `attachment_blobs(md5)` |
| `filename`, `content_type` | `TEXT` |
| `size_bytes` | `INTEGER` |

### `saved_searches`

| Column | Type | Notes |
|---|---|---|
| `id` | `BIGSERIAL PK` | |
| `name` | `TEXT` | |
| `query` | `TEXT` | Stored exactly as typed — re-running it just replays the same `parseQuery()` path, so it benefits from any future operator for free |
| `created_at` | `TIMESTAMPTZ` | |

### `drafts` / `draft_attachments` — compose (new/reply/reply-all/forward)

| Column | Type | Notes |
|---|---|---|
| `id` | `BIGSERIAL PK` | |
| `in_reply_to_email_id` | `BIGINT` → `emails(id)` | NULL for a fresh compose |
| `mode` | `TEXT` | `'new'`\|`'reply'`\|`'reply_all'`\|`'forward'` |
| `to_addresses`, `cc_addresses`, `bcc_addresses` | `TEXT[]` | |
| `subject`, `body_html` | `TEXT` | |
| `in_reply_to`, `thread_references` | `TEXT`/`TEXT[]` | RFC threading headers, computed once from the source email |
| `created_at`, `updated_at` | `TIMESTAMPTZ` | |

No "sent" state: `POST /api/drafts/:id/send` deletes the row on success
instead of marking it sent — a draft only ever exists as "being composed" or
"gone". `draft_attachments` mirrors `email_attachments`' shape, pointing at
the same `attachment_blobs` store (a forwarded attachment is a new row
against the same blob, no file copy).

### Threading

`emails.thread_key` groups messages into conversations. Computed by
`scripts/compute-threads.js` — an in-memory Union-Find over the whole
mailbox's `message_id` ↔ `in_reply_to`/`thread_references` graph — and set to
the `message_id` of the **earliest real email** in each resulting group
(always a real, existing message-id; a message with no reply relationships
is its own thread of one). It's a full recompute every run, not incremental
(threading is a property of the whole graph, not any single row), but cheap
enough (~116k rows) to just re-run after any meaningful batch of new mail:

```bash
npm run compute-threads
```

## Search syntax

Free text goes through Postgres full-text search (prefix-matched,
`ts_headline` snippets). Operators, all combinable with free text and with
each other:

| Operator | Matches |
|---|---|
| `from:name` | `from_address` or `from_name`, substring |
| `to:name` | `to_address`, substring |
| `subject:word` | `subject`, substring |
| `has:attachment` | Has at least one row in `email_attachments` |
| `before:YYYY-MM-DD`, `after:YYYY-MM-DD` | `email_date` |
| `date:YYYY-MM-DD` or `date:YYYY-MM` | Exact day or month |
| `label:name` / `in:name` | Any entry in `labels` |
| `filename:word` | An attached file's name |
| `category:name` | `domain` **or** `subcategory` (only meaningful once the AI layer has run) |
| `company:name` | `company`, substring |
| `"exact phrase"` | Real substring match, not stemmed FTS |

## Configuration

Everything is read from `.env` (`cp .env.example .env` to start). Required:

- `DATABASE_URL` — Postgres connection string
- `IMAP_HOST`, `IMAP_PORT`, `IMAP_SECURE`, `IMAP_USER`, `IMAP_PASSWORD` — Bridge credentials
- `ATTACHMENTS_DIR` — where attachment blobs are stored on disk

Optional, with defaults shown:

```
PORT=4310
IMPORT_CHUNK_SIZE=150
IMPORT_MAX_BODY_CHARS=200000
IMPORT_MAX_HTML_CHARS=300000
IMPORT_MAX_ATTEMPTS=5
IMPORT_EXCLUDE_MAILBOXES=Spam,Trash
CATCHUP_WINDOW=1000
GHOST_RETRY_BATCH_LIMIT=300
THREADS_BATCH_SIZE=2000
BACKFILL_PROGRESS_EVERY=200

# SMTP send (Bridge's local port, same credentials as IMAP by default)
SMTP_HOST=<falls back to IMAP_HOST>
SMTP_PORT=1025

# Optional AI categorization layer (LM Studio)
LMSTUDIO_URL=http://localhost:1234
LMSTUDIO_MODEL=qwen/qwen3-vl-4b
LMSTUDIO_TIMEOUT_MS=30000
CATEGORIZE_CONCURRENCY=0
CATEGORIZE_MAX_ATTEMPTS=3
CATEGORIZE_ORDER=id
CATEGORIZE_LIMIT=<unset — no cap>
CATEGORIZE_PROGRESS_EVERY=200
```

## API reference

All under `/api`. Everything except `/api/drafts/:id/send` is either
read-only or scoped to local state (drafts, saved searches) — there is no
endpoint that modifies your real Proton mailbox other than sending.

| Method & path | Purpose |
|---|---|
| `GET /api/search` | Full-text + operator search (see above) |
| `GET /api/search/attachments` | Attachment-grid view of the current search |
| `GET /api/email/:id` | One email's full content, threading fields, attachments |
| `GET /api/thread/:key` | Every email in a conversation, oldest first |
| `GET /api/attachment/:id` | Streams an attachment's bytes |
| `POST /api/sync` | Kicks off `import.js` then `catchup-recent.js` |
| `GET /api/sync` | Current sync status (also polled by the UI) |
| `GET /api/categories` | Domain/subcategory taxonomy + whether the AI layer has ever run |
| `GET/POST/DELETE /api/saved-searches` | |
| `GET /api/me` | `{ email }` — your own address, for excluding yourself from Reply All |
| `GET /api/contacts?q=` | Address autocomplete, sourced from senders you've actually received mail from |
| `GET/POST /api/drafts`, `GET/PUT/DELETE /api/drafts/:id` | Compose draft CRUD, autosaved by the UI |
| `POST/DELETE /api/drafts/:id/attachments[/:attachmentId]` | Upload/remove a compose attachment |
| `GET /api/draft-attachment/:id` | Streams a draft attachment's bytes |
| `POST /api/drafts/:id/send` | Sends over Bridge's local SMTP, deletes the draft on success. Implemented and tested working, but not currently wired to the UI's Send button (see the comment above `composeSendBtn` in `public/index.html`) |

## npm scripts

| Command | What it does |
|---|---|
| `npm run setup-db` | Applies `db/schema.sql` (idempotent) |
| `npm run import` | Primary watermark-based importer |
| `npm run catchup-recent` | Stateless recent-mail safety net |
| `npm run import-attachments` | Extracts attachment blobs for already-imported mail |
| `npm run backfill-headers` | One-time backfill of threading/unsubscribe/importance headers onto pre-2026-09-29 mail |
| `npm run compute-threads` | Recomputes `thread_key` conversation grouping |
| `npm run categorize` | Runs the optional AI categorization layer (never automatic) |
| `npm run bench-categorize` | Scores whatever LM Studio model is loaded against a curated 10-email test set |
| `npm start` | Runs `server.js` — the web app, with sync on startup + every 5 minutes |

A couple of one-off utility scripts also live in `scripts/` outside this list
(`fix-dates.js`, `preview.js`) — see their own header comments.

## Project layout

```
server.js              Express app + API endpoints (also: the setup-wizard gate, see Docker section)
public/index.html       The entire frontend (no build step)
public/setup.html        Docker first-run setup wizard page
db/schema.sql            Full schema, applied by scripts/setup-db.js
Dockerfile                App image (Postgres is a separate service in docker-compose.yml)
docker-compose.yml         The two-container stack (app + db)
docker-entrypoint.sh         Applies schema, then execs the real CMD
install.sh                    Docker prereq checks + docker compose up
lib/
  db.js                  Postgres pool
  emailImport.js         Shared IMAP scan/fetch/insert/ghost-retry logic
  attachments.js         Content-addressed blob store
  categorize.js           AI taxonomy + LM Studio client
  queryParser.js           Search operator parsing
  search.js                 tsquery building
  parseDate.js               Robust Date-header parsing
scripts/                  Every batch job — see npm scripts above
attachments/               Attachment blobs on disk (content-addressed)
logs/                        Timestamped logs from every script run
```

## Not yet built

- Send isn't wired to the UI (the endpoint works, tested live — see above)
- Full inline "stacked" conversation view (currently: a conversation strip
  that switches between messages, not Gmail-style collapsed inline history)
- A published Docker image + a real `curl | bash` one-liner that needs no
  local clone — Docker packaging itself is done and verified (see
  [Docker packaging notes](#docker-packaging-notes)), but it currently builds
  from local source rather than pulling a prebuilt, registry-hosted image
- Windows/Linux support for the Docker install path (macOS + Docker Desktop
  only for now — see [Docker packaging notes](#docker-packaging-notes))
