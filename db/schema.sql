-- delve — email store
-- Goal for v1: get every email out of Proton (via Proton Bridge/IMAP) into
-- Postgres with full-text search over subject, sender AND body — which is
-- exactly what Proton Mail's own search can't do.

CREATE TABLE IF NOT EXISTS emails (
  id            BIGSERIAL PRIMARY KEY,
  message_id    TEXT NOT NULL UNIQUE,
  subject       TEXT NOT NULL DEFAULT '',
  from_address  TEXT NOT NULL DEFAULT '',
  from_name     TEXT NOT NULL DEFAULT '',
  to_address    TEXT NOT NULL DEFAULT '',
  cc            TEXT NOT NULL DEFAULT '',
  email_date    TIMESTAMPTZ,
  body_text     TEXT,
  body_html     TEXT,
  attachments   JSONB NOT NULL DEFAULT '[]',
  labels        TEXT[] NOT NULL DEFAULT '{}',
  size_bytes    INTEGER,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Proton's own internal message ID, lifted from the X-Pm-Internal-Id header
-- Bridge attaches to every message. This is the same ID Proton's web app uses
-- in its URLs (https://mail.proton.me/u/<n>/<folder>/<id>), so it's what lets
-- a search result link straight back into the real Proton Mail app/web UI —
-- useful for attachments, which this database only stores metadata for.
ALTER TABLE emails ADD COLUMN IF NOT EXISTS pm_internal_id TEXT;
CREATE INDEX IF NOT EXISTS emails_pm_internal_id_idx ON emails(pm_internal_id);

-- Full-text search vector. Subject/sender rank highest, body text is included
-- (weight C) so it's always searchable even though it ranks lower — this is
-- the whole point of this project since Proton doesn't index body text at all.
ALTER TABLE emails ADD COLUMN IF NOT EXISTS search_vector tsvector
  GENERATED ALWAYS AS (
    setweight(to_tsvector('english', coalesce(subject, '')), 'A') ||
    setweight(to_tsvector('english', coalesce(from_address, '') || ' ' || coalesce(from_name, '')), 'B') ||
    setweight(to_tsvector('english', coalesce(body_text, '')), 'C')
  ) STORED;

CREATE INDEX IF NOT EXISTS emails_search_idx  ON emails USING GIN(search_vector);
CREATE INDEX IF NOT EXISTS emails_date_idx    ON emails(email_date DESC);
CREATE INDEX IF NOT EXISTS emails_from_idx    ON emails(lower(from_address));
CREATE INDEX IF NOT EXISTS emails_labels_idx  ON emails USING GIN(labels);

-- Per-mailbox (Proton label/folder) import progress, so re-runs only fetch
-- envelopes for UIDs added since the last run instead of re-scanning everything.
CREATE TABLE IF NOT EXISTS import_state (
  mailbox        TEXT PRIMARY KEY,
  uid_validity   TEXT,
  last_seen_uid  INTEGER NOT NULL DEFAULT 0,
  updated_at     TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Tracks "ghost" UIDs (IMAP SEARCH/envelope-scan sees the UID but FETCH fails
-- for it, or returns a DIFFERENT UID's content entirely — both are confirmed
-- real Bridge bugs, not client-side flakiness) so they get retried before
-- anything gives up on them. Discovered 2026-09-29: a ghost UID was
-- previously folded into the watermark and permanently skipped on its very
-- first occurrence, which is right for a genuinely, permanently corrupted
-- historical UID (the original reason this existed) but silently and
-- permanently dropped legitimate brand-new mail that was merely momentarily
-- unfetchable due to Bridge's own indexing lag — a real data loss bug, not a
-- one-off.
--
-- Two different give-up policies share this same table, by design:
--   - scripts/import.js still gives up after GHOST_RETRY_WINDOW_MS (1h) —
--     it HAS to, because its UID watermark can't advance past an unresolved
--     UID, so one permanently-dead historical UID would otherwise freeze ALL
--     future import progress for that mailbox forever.
--   - scripts/catchup-recent.js never gives up (triageGhostUids' neverExpire
--     option) — it's stateless, nothing is ever blocked waiting on a ghost,
--     so there's no upside to expiring one, only the downside of silently
--     dropping real mail that (confirmed 2026-09-29) can take Bridge several
--     hours to stabilize. Costs one extra fetch attempt per sync cycle for
--     whatever's still stuck; cheap, and never wrong.
CREATE TABLE IF NOT EXISTS ghost_uids (
  mailbox        TEXT NOT NULL,
  uid_validity   TEXT NOT NULL,
  uid            INTEGER NOT NULL,
  first_seen_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  attempts       INTEGER NOT NULL DEFAULT 1,
  PRIMARY KEY (mailbox, uid_validity, uid)
);

-- Marks which emails have had their attachments extracted to disk, so the
-- attachment importer can resume by just re-querying for NULL rather than
-- tracking its own IMAP UID watermark.
ALTER TABLE emails ADD COLUMN IF NOT EXISTS attachments_stored_at TIMESTAMPTZ;
CREATE INDEX IF NOT EXISTS emails_pending_attachments_idx ON emails (id)
  WHERE attachments_stored_at IS NULL AND jsonb_array_length(attachments) > 0;

-- ─── Attachment blob store ───────────────────────────────────────────────────
-- One row per unique file (content-addressed by md5). The actual bytes live on
-- disk at {ATTACHMENTS_DIR}/{ext}/{md5}{ext} — never in Postgres, and the path
-- is never stored here either (it's always computed from md5+ext+the current
-- ATTACHMENTS_DIR config), so relocating the attachments folder later needs
-- no DB migration or repair pass.
CREATE TABLE IF NOT EXISTS attachment_blobs (
  md5           TEXT PRIMARY KEY,
  ext           TEXT NOT NULL DEFAULT '',
  content_type  TEXT NOT NULL DEFAULT 'application/octet-stream',
  size_bytes    INTEGER NOT NULL DEFAULT 0,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- One row per (email, attachment) instance — the same blob can be attached
-- to many emails (forwarded files, reused newsletter images) under different
-- filenames, which is why this is separate from attachment_blobs.
CREATE TABLE IF NOT EXISTS email_attachments (
  id            BIGSERIAL PRIMARY KEY,
  email_id      BIGINT NOT NULL REFERENCES emails(id) ON DELETE CASCADE,
  blob_md5      TEXT NOT NULL REFERENCES attachment_blobs(md5),
  filename      TEXT NOT NULL DEFAULT '',
  content_type  TEXT NOT NULL DEFAULT 'application/octet-stream',
  size_bytes    INTEGER NOT NULL DEFAULT 0,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS email_attachments_email_idx ON email_attachments(email_id);
CREATE INDEX IF NOT EXISTS email_attachments_blob_idx  ON email_attachments(blob_md5);

-- ─── AI categorization (Ollaya) ──────────────────────────────────────────────
-- Populated by scripts/categorize.js, a separate job from the IMAP import/sync
-- (see lib/categorize.js) — it runs a local Ollaya decision model over every
-- email and writes back a two-level category plus a few yes/no/score signals.
--
-- Every field stores the model's raw probability/expectation (0-1 for the
-- noul fields, the confidence Ollaya returns for the two choice fields, the
-- weighted 0..N-1 expectation for urgency) rather than a pre-thresholded
-- boolean — same reasoning as storing the raw parsed email_date instead of a
-- derived value: the query layer decides its own cutoff later, and nothing
-- has to be re-run just because a threshold changes.
--
-- categorize_version lets the taxonomy in lib/categorize.js change later
-- (new/renamed categories, reworded criteria) without a migration: bump
-- CATEGORY_VERSION there and every row whose categorize_version doesn't match
-- is picked up for re-categorization on the next run, exactly like
-- uid_validity changing forces a mailbox re-scan in import.js.
ALTER TABLE emails ADD COLUMN IF NOT EXISTS domain                     TEXT;
ALTER TABLE emails ADD COLUMN IF NOT EXISTS domain_confidence          REAL;
ALTER TABLE emails ADD COLUMN IF NOT EXISTS subcategory                TEXT;
ALTER TABLE emails ADD COLUMN IF NOT EXISTS subcategory_confidence     REAL;
ALTER TABLE emails ADD COLUMN IF NOT EXISTS urgency                    REAL;
ALTER TABLE emails ADD COLUMN IF NOT EXISTS needs_reply                REAL;
ALTER TABLE emails ADD COLUMN IF NOT EXISTS is_automated               REAL;
ALTER TABLE emails ADD COLUMN IF NOT EXISTS unsubscribe_candidate      REAL;
ALTER TABLE emails ADD COLUMN IF NOT EXISTS attachment_worth_keeping   REAL;
ALTER TABLE emails ADD COLUMN IF NOT EXISTS summary                    TEXT;
-- v4: facts extracted alongside the classification, at no extra round trip
-- cost (same stage-1 call). key_date is a date mentioned IN THE BODY (a
-- deadline, an event) — not email_date, which is when the message was sent.
ALTER TABLE emails ADD COLUMN IF NOT EXISTS amount                     REAL;
ALTER TABLE emails ADD COLUMN IF NOT EXISTS currency                   TEXT;
ALTER TABLE emails ADD COLUMN IF NOT EXISTS reference_number           TEXT;
ALTER TABLE emails ADD COLUMN IF NOT EXISTS key_date                   DATE;
-- company is a normalized brand/sender name (e.g. "Amazon", "Lufthansa"),
-- not a raw domain — lets a future UI/search do "everything from Amazon"
-- without string-matching against inconsistent real sender addresses.
ALTER TABLE emails ADD COLUMN IF NOT EXISTS company                    TEXT;
ALTER TABLE emails ADD COLUMN IF NOT EXISTS secondary_domains          TEXT[] NOT NULL DEFAULT '{}';
ALTER TABLE emails ADD COLUMN IF NOT EXISTS categorize_version         TEXT;
ALTER TABLE emails ADD COLUMN IF NOT EXISTS categorized_at             TIMESTAMPTZ;

CREATE INDEX IF NOT EXISTS emails_domain_idx           ON emails(domain);
CREATE INDEX IF NOT EXISTS emails_subcategory_idx      ON emails(subcategory);
CREATE INDEX IF NOT EXISTS emails_reference_number_idx ON emails(reference_number) WHERE reference_number IS NOT NULL;
CREATE INDEX IF NOT EXISTS emails_key_date_idx         ON emails(key_date) WHERE key_date IS NOT NULL;
CREATE INDEX IF NOT EXISTS emails_company_idx          ON emails(lower(company)) WHERE company IS NOT NULL;
-- Partial index for the job's own "what's left to do" query. Only covers the
-- never-categorized case (not a future version bump, which is a rarer, one-off
-- full re-scan) — same trade-off as emails_pending_attachments_idx above.
CREATE INDEX IF NOT EXISTS emails_pending_categorize_idx ON emails (id)
  WHERE categorized_at IS NULL;

-- ─── Saved searches ──────────────────────────────────────────────────────────
-- `query` is stored exactly as typed/built in the search box (free text +
-- operators, e.g. `category:finance_banking is_automated:true`) — re-running
-- a saved search just feeds this string back through the same parseQuery()
-- path as a normal search, so it automatically benefits from any future
-- operator additions with no migration needed.
CREATE TABLE IF NOT EXISTS saved_searches (
  id          BIGSERIAL PRIMARY KEY,
  name        TEXT NOT NULL,
  query       TEXT NOT NULL,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- ─── Extra headers (threading, unsubscribe, list-id, reply-to, importance) ──
-- All parsed from headers every email already carries — we just discarded
-- them after parsing until 2026-09-29. `headers_backfilled_at` distinguishes
-- "checked, this field is genuinely absent on this email" (NULL fields, but
-- this column IS set) from "not checked yet" (this column is NULL) — the
-- same pattern as attachments_stored_at, so scripts/backfill-headers.js can
-- resume cleanly and doesn't re-check rows forever just because a header was
-- legitimately missing.
ALTER TABLE emails ADD COLUMN IF NOT EXISTS in_reply_to             TEXT;
ALTER TABLE emails ADD COLUMN IF NOT EXISTS thread_references       TEXT[] NOT NULL DEFAULT '{}';
ALTER TABLE emails ADD COLUMN IF NOT EXISTS reply_to_address        TEXT;
ALTER TABLE emails ADD COLUMN IF NOT EXISTS reply_to_name           TEXT;
ALTER TABLE emails ADD COLUMN IF NOT EXISTS list_id                 TEXT;
ALTER TABLE emails ADD COLUMN IF NOT EXISTS unsubscribe_url         TEXT;
ALTER TABLE emails ADD COLUMN IF NOT EXISTS unsubscribe_mailto      TEXT;
ALTER TABLE emails ADD COLUMN IF NOT EXISTS unsubscribe_one_click   BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE emails ADD COLUMN IF NOT EXISTS importance              TEXT; -- 'high' | 'normal' | 'low', or NULL if absent
ALTER TABLE emails ADD COLUMN IF NOT EXISTS headers_backfilled_at   TIMESTAMPTZ;

CREATE INDEX IF NOT EXISTS emails_in_reply_to_idx ON emails(in_reply_to) WHERE in_reply_to IS NOT NULL;
CREATE INDEX IF NOT EXISTS emails_thread_references_idx ON emails USING GIN(thread_references);
CREATE INDEX IF NOT EXISTS emails_list_id_idx ON emails(list_id) WHERE list_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS emails_pending_headers_backfill_idx ON emails (id)
  WHERE headers_backfilled_at IS NULL;

-- ─── Compose drafts ──────────────────────────────────────────────────────────
-- Supports new/reply/reply-all/forward composing with autosave. Deliberately
-- has no "sent" state or send timestamp — POST /api/drafts/:id/send (Bridge's
-- local SMTP) deletes the row on success instead of marking it sent, so a
-- draft only ever exists in "being composed" or "gone" — the frontend
-- currently doesn't call that endpoint (see the comment above composeSendBtn
-- in public/index.html), but the row shape doesn't need to change either way.
-- in_reply_to/thread_references are the RFC headers a send needs (mirrors
-- emails.in_reply_to/thread_references), computed once at compose time from
-- the source email rather than re-derived later.
CREATE TABLE IF NOT EXISTS drafts (
  id                    BIGSERIAL PRIMARY KEY,
  in_reply_to_email_id  BIGINT REFERENCES emails(id) ON DELETE SET NULL,
  mode                  TEXT NOT NULL DEFAULT 'new', -- 'new' | 'reply' | 'reply_all' | 'forward'
  to_addresses          TEXT[] NOT NULL DEFAULT '{}',
  cc_addresses          TEXT[] NOT NULL DEFAULT '{}',
  bcc_addresses         TEXT[] NOT NULL DEFAULT '{}',
  subject               TEXT NOT NULL DEFAULT '',
  body_html             TEXT NOT NULL DEFAULT '',
  in_reply_to           TEXT,
  thread_references     TEXT[] NOT NULL DEFAULT '{}',
  created_at            TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at            TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Reuses the same content-addressed attachment_blobs store emails already use
-- (see lib/attachments.js) — a forwarded attachment is just a new row
-- pointing at the same blob_md5, no file copy, and a freshly uploaded
-- compose attachment is stored exactly like an imported one.
CREATE TABLE IF NOT EXISTS draft_attachments (
  id            BIGSERIAL PRIMARY KEY,
  draft_id      BIGINT NOT NULL REFERENCES drafts(id) ON DELETE CASCADE,
  blob_md5      TEXT NOT NULL REFERENCES attachment_blobs(md5),
  filename      TEXT NOT NULL DEFAULT '',
  content_type  TEXT NOT NULL DEFAULT 'application/octet-stream',
  size_bytes    INTEGER NOT NULL DEFAULT 0,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS drafts_updated_idx ON drafts(updated_at DESC);
CREATE INDEX IF NOT EXISTS draft_attachments_draft_idx ON draft_attachments(draft_id);

-- ─── Thread/conversation grouping ────────────────────────────────────────────
-- thread_key groups emails into conversations by connecting message_id <->
-- in_reply_to/thread_references edges (scripts/compute-threads.js, a
-- Union-Find over the whole mailbox) and is the message_id of the earliest
-- real email in each resulting group — always a real, existing message_id,
-- never a synthetic id, so it doubles as a stable, human-inspectable key with
-- no separate threads table needed. A message with no reply relationships at
-- all is its own thread of one, keyed by its own message_id.
--
-- Not populated incrementally like headers_backfilled_at/categorized_at —
-- threading is a property of the whole reply graph, not any single row in
-- isolation (a new email can change which group an old one belongs to), so
-- this is a full recompute every run rather than a per-row "pending" queue.
-- Cheap enough (~116k rows, in-memory Union-Find) to just rerun after any
-- meaningful batch of new mail.
ALTER TABLE emails ADD COLUMN IF NOT EXISTS thread_key TEXT;
CREATE INDEX IF NOT EXISTS emails_thread_key_idx ON emails(thread_key);
