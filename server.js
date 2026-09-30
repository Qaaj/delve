#!/usr/bin/env node
/**
 * The actual point of this whole project: one search box, real full-text
 * search (including body text, which Proton itself can't search) — plus
 * Google-style operators (from:, to:, subject:, has:attachment, before:/
 * after:/date:, label:, filename:), "exact phrase" matching, and a grid view
 * of the attachments (images/PDFs) belonging to the current search results.
 */

const fs = require('fs');
const path = require('path');

// Overridable so the Docker image can persist this on a volume (see
// Dockerfile/docker-compose.yml) instead of baking credentials into the
// image or losing them on container recreation. Defaults to the same
// cwd-relative .env every script here has always used, so nothing changes
// for a non-Docker install.
const ENV_FILE_PATH = process.env.ENV_FILE_PATH || path.join(__dirname, '.env');
require('dotenv').config({ path: ENV_FILE_PATH });

const PORT = parseInt(process.env.PORT || '4310', 10);

// No IMAP credentials yet — the Docker image ships without any (see
// docker-compose.yml), so a fresh install always lands here first. Serves
// only the setup wizard instead of the real app: nothing below this block
// (search, sync, compose, etc.) can do anything useful without Bridge
// credentials anyway, and trying would just mean confusing crash loops
// instead of one clear "let's get you set up" page.
const IMAP_CONFIGURED = !!(process.env.IMAP_USER && process.env.IMAP_PASSWORD);
if (!IMAP_CONFIGURED) {
  const express = require('express');
  const { ImapFlow } = require('imapflow');

  const setupApp = express();
  setupApp.use(express.json());
  // Must come before express.static below — static's default index.html
  // fallback would otherwise serve the REAL app's page for "/" (since
  // public/index.html exists), before this route ever got a chance to run,
  // and that page would just fail confusingly against a setup-only server
  // with none of its real API routes mounted.
  setupApp.get('/', (req, res) => res.sendFile(path.join(__dirname, 'public', 'setup.html')));
  setupApp.use(express.static(path.join(__dirname, 'public')));

  setupApp.post('/api/setup', async (req, res) => {
    const host = (req.body.host || '').trim();
    const port = parseInt(req.body.port, 10);
    const secure = !!req.body.secure;
    const user = (req.body.user || '').trim();
    const password = (req.body.password || '').toString();

    if (!host || !Number.isInteger(port) || !user || !password) {
      return res.status(400).json({ error: 'host, port, user, and password are all required' });
    }

    // Fail loudly here, before writing anything — a bad password saved to
    // disk would otherwise just crash-loop the container with no clear
    // signal back to whoever's looking at this form.
    const client = new ImapFlow({
      host, port, secure,
      auth: { user, pass: password },
      logger: false,
      tls: { rejectUnauthorized: false },
      connectionTimeout: 8000,
      greetingTimeout: 8000,
    });
    try {
      await client.connect();
      await client.logout();
    } catch (err) {
      return res.status(400).json({ error: `Couldn't connect with those details: ${err.message}` });
    }

    const envContents = [
      `IMAP_HOST=${host}`,
      `IMAP_PORT=${port}`,
      `IMAP_SECURE=${secure}`,
      `IMAP_USER=${user}`,
      `IMAP_PASSWORD=${password}`,
      '',
    ].join('\n');
    fs.mkdirSync(path.dirname(ENV_FILE_PATH), { recursive: true });
    fs.writeFileSync(ENV_FILE_PATH, envContents);

    res.json({ ok: true });
    // The rest of this file (the real app) only runs on a fresh process
    // start, since IMAP_CONFIGURED above is decided once at boot — exiting
    // and letting Docker's `restart: unless-stopped` bring the container
    // back up is what actually applies the newly-written config. A short
    // delay just makes sure the response above finishes flushing first.
    setTimeout(() => process.exit(0), 250);
  });

  setupApp.listen(PORT, () => {
    console.log(`better-proton setup wizard listening on http://localhost:${PORT} — no IMAP credentials configured yet`);
  });
  return;
}

const { spawn } = require('child_process');
const express = require('express');
const multer = require('multer');
const nodemailer = require('nodemailer');
const db = require('./lib/db');
const { buildSearchCondition, toTsqueryPrefix, escapeLike } = require('./lib/search');
const { parseQuery } = require('./lib/queryParser');
const { store, blobPath } = require('./lib/attachments');
const { DOMAINS, ALL_SUBCATEGORIES, SUBCATEGORY_TO_DOMAIN } = require('./lib/categorize');

const RESULT_LIMIT = 50;
const ATTACHMENTS_DIR = process.env.ATTACHMENTS_DIR || path.join(__dirname, 'attachments');

const app = express();
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

// In-memory — attachments go straight into the same content-addressed store
// as imported ones (lib/attachments.js's store()) before anything touches disk.
const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 25 * 1024 * 1024 } });

// Proton Bridge's local SMTP submission port — same host/credentials as the
// IMAP connection above, confirmed reachable on 127.0.0.1:1025. STARTTLS
// against Bridge's self-signed local cert, same rejectUnauthorized:false
// pattern already used for its IMAP connections elsewhere in this project.
const mailTransport = nodemailer.createTransport({
  host: process.env.SMTP_HOST || process.env.IMAP_HOST || '127.0.0.1',
  port: parseInt(process.env.SMTP_PORT || '1025', 10),
  secure: false,
  requireTLS: true,
  auth: { user: process.env.IMAP_USER, pass: process.env.IMAP_PASSWORD },
  tls: { rejectUnauthorized: false },
});

// ─── Sync ────────────────────────────────────────────────────────────────────
// scripts/import.js is already incremental (per-mailbox IMAP UID watermarks
// mean a rerun only fetches what's new since last time), so "sync" here is
// just running that same script on demand and reporting back what happened —
// no separate "quick sync" logic needed. Runs once on server startup, then on
// a 5-minute timer, in addition to the manual button.

const SYNC_INTERVAL_MS = 5 * 60 * 1000;

let syncState = {
  running: false,
  startedAt: null,
  currentMailbox: null,   // live progress while running — which mailbox it's on right now (either phase)
  currentPhase: null,     // 'import' or 'catchup' — which script is running right now
  finishedAt: null,       // when the last run (both phases) completed
  insertedCount: null,    // last completed import phase's genuinely-new-email count
  lastSummary: null,      // last completed import phase's full TOTAL breakdown
  lastCatchupSummary: null, // last completed catch-up phase's TOTAL breakdown — kept
  // separate from lastSummary rather than merged: "seen" means something
  // different in each (import's is only-since-watermark, catchup's is a
  // fixed re-check window every time), so adding them together would be
  // misleading, not just redundant.
  error: null,
};

/** Runs one script to completion, capturing its stdout/stderr tail for
 * currentMailbox progress and parsing its final TOTAL line — shared by both
 * the import and catch-up phases below. */
function runSyncScript(scriptPath) {
  return new Promise((resolve) => {
    // Absolute path to node, not the bare command — when this server runs
    // under launchd (see ~/Library/LaunchAgents/com.betterproton.server.plist),
    // launchd gives it a minimal PATH that doesn't include /usr/local/bin,
    // so spawn('node', ...) silently can't find the binary. process.execPath
    // is always the exact node binary currently running this process, so it
    // works regardless of how/where server.js itself was launched.
    const child = spawn(process.execPath, [scriptPath], { cwd: __dirname });

    let tail = '';
    const capture = (chunk) => {
      tail = (tail + chunk.toString()).slice(-4000);
      const lines = tail.trim().split('\n');
      for (let i = lines.length - 1; i >= 0; i--) {
        const m = lines[i].match(/processing "([^"]+)"/);
        if (m) { syncState.currentMailbox = m[1]; break; }
      }
    };
    child.stdout.on('data', capture);
    child.stderr.on('data', capture);

    const finish = (errorMessage) => {
      const match = tail.match(/TOTAL: seen=(\d+) inserted=(\d+) labeled=(\d+) skipped=(\d+) failed=(\d+)/);
      const summary = match ? {
        seen: parseInt(match[1], 10), inserted: parseInt(match[2], 10), labeled: parseInt(match[3], 10),
        skipped: parseInt(match[4], 10), failed: parseInt(match[5], 10),
      } : null;
      resolve({ summary, error: summary ? null : errorMessage });
    };

    child.on('close', (code) => finish(code !== 0 ? `exited with code ${code}` : null));
    child.on('error', (err) => finish(err.message));
  });
}

/** Returns true if a run was actually started, false if one was already in progress. */
function startSync() {
  if (syncState.running) return false;

  syncState = { ...syncState, running: true, startedAt: new Date().toISOString(), currentMailbox: null, error: null };

  (async () => {
    syncState.currentPhase = 'import';
    const importResult = await runSyncScript('scripts/import.js');
    if (importResult.summary) {
      syncState.insertedCount = importResult.summary.inserted;
      syncState.lastSummary = importResult.summary;
    }

    // Runs regardless of whether import.js found an error — a stateless
    // catch-up pass doesn't depend on import.js having succeeded, and is
    // cheap enough (~10s for this mailbox size) to always run right after.
    syncState.currentPhase = 'catchup';
    syncState.currentMailbox = null;
    const catchupResult = await runSyncScript('scripts/catchup-recent.js');
    if (catchupResult.summary) syncState.lastCatchupSummary = catchupResult.summary;

    syncState.error = importResult.error || catchupResult.error || null;
    syncState.running = false;
    syncState.currentPhase = null;
    syncState.currentMailbox = null;
    syncState.finishedAt = new Date().toISOString();
  })();

  return true;
}

app.post('/api/sync', (req, res) => {
  const started = startSync();
  res.status(started ? 200 : 409).json(syncState);
});

app.get('/api/sync', (req, res) => res.json(syncState));

// The category dropdown's option list, plus whether category features
// should show up in the UI at all — `enabled` is a real runtime check
// (any row ever categorized?), not a config flag, so the same codebase
// works unmodified whether or not the optional AI layer (scripts/categorize.js
// + lib/categorize.js, the only two files that need LM Studio) has ever been
// run. A pure-Postgres user's `emails` rows just never populate the AI
// columns, so this naturally comes back false and the frontend hides
// everything category-related — no build flag, no separate "lite" version
// to maintain.
let categorizationEnabledCache = null; // cached after first true result — once populated, it stays populated
app.get('/api/categories', async (req, res) => {
  try {
    if (!categorizationEnabledCache) {
      const { rows } = await db.query('SELECT EXISTS(SELECT 1 FROM emails WHERE categorize_version IS NOT NULL) AS enabled');
      categorizationEnabledCache = rows[0].enabled;
    }
    res.json({
      domains: DOMAINS,
      subcategories: Object.keys(ALL_SUBCATEGORIES),
      subcategoryToDomain: SUBCATEGORY_TO_DOMAIN,
      enabled: categorizationEnabledCache,
    });
  } catch (err) {
    console.error('[categories]', err);
    res.json({ domains: DOMAINS, subcategories: [], subcategoryToDomain: {}, enabled: false });
  }
});

// ─── Saved searches ──────────────────────────────────────────────────────────

app.get('/api/saved-searches', async (req, res) => {
  const { rows } = await db.query('SELECT id, name, query FROM saved_searches ORDER BY created_at ASC');
  res.json({ results: rows });
});

app.post('/api/saved-searches', async (req, res) => {
  const name = (req.body.name || '').toString().trim();
  const query = (req.body.query || '').toString().trim();
  if (!name) return res.status(400).json({ error: 'name is required' });
  const { rows } = await db.query(
    'INSERT INTO saved_searches (name, query) VALUES ($1, $2) RETURNING id, name, query',
    [name, query]
  );
  res.status(201).json(rows[0]);
});

app.delete('/api/saved-searches/:id', async (req, res) => {
  const id = parseInt(req.params.id, 10);
  if (!Number.isInteger(id)) return res.status(400).json({ error: 'invalid id' });
  await db.query('DELETE FROM saved_searches WHERE id = $1', [id]);
  res.status(204).end();
});

// ─── Compose (drafts only — no send path) ────────────────────────────────────
// Everything here reads/writes drafts and their attachments. There is
// deliberately no endpoint that submits a message anywhere — "Send" in the
// frontend just finalizes the autosaved draft. Wiring an actual SMTP
// submission (Proton Bridge exposes one locally, confirmed reachable on
// 127.0.0.1:1025) is a separate, not-yet-taken step.

app.get('/api/me', (req, res) => {
  res.json({ email: (process.env.IMAP_USER || '').toLowerCase() });
});

// Address autocomplete for the To/Cc/Bcc chip inputs, sourced from senders
// already in the mailbox — "someone I've actually received mail from" is a
// reasonable proxy for a contact list without maintaining a separate one.
app.get('/api/contacts', async (req, res) => {
  const q = (req.query.q || '').toString().trim();
  if (!q) return res.json({ results: [] });
  const { rows } = await db.query(`
    SELECT from_address, from_name, MAX(email_date) AS last_seen
    FROM emails
    WHERE from_address ILIKE $1 OR from_name ILIKE $1
    GROUP BY from_address, from_name
    ORDER BY last_seen DESC
    LIMIT 10
  `, [`%${escapeLike(q)}%`]);
  res.json({ results: rows });
});

async function getDraftAttachments(draftId) {
  const { rows } = await db.query(
    'SELECT id, filename, content_type, size_bytes FROM draft_attachments WHERE draft_id = $1 ORDER BY id',
    [draftId]
  );
  return rows;
}

app.get('/api/drafts', async (req, res) => {
  const { rows } = await db.query(`
    SELECT id, mode, to_addresses, subject, updated_at
    FROM drafts ORDER BY updated_at DESC LIMIT 100
  `);
  res.json({ results: rows });
});

app.get('/api/drafts/:id', async (req, res) => {
  const id = parseInt(req.params.id, 10);
  if (!Number.isInteger(id)) return res.status(400).json({ error: 'invalid id' });
  const { rows } = await db.query('SELECT * FROM drafts WHERE id = $1', [id]);
  if (rows.length === 0) return res.status(404).json({ error: 'not found' });
  res.json({ ...rows[0], attachments: await getDraftAttachments(id) });
});

// Creates a draft, optionally pre-filled from a source email (reply/reply-all/
// forward all go through this) — carryAttachmentsFromEmailId copies the
// source email's attachment rows by reference (same blob_md5, no file copy),
// same as how one blob can already back multiple emails.
app.post('/api/drafts', async (req, res) => {
  const {
    mode, inReplyToEmailId, toAddresses, ccAddresses, bccAddresses,
    subject, bodyHtml, inReplyTo, threadReferences, carryAttachmentsFromEmailId,
  } = req.body || {};

  const { rows } = await db.query(`
    INSERT INTO drafts (mode, in_reply_to_email_id, to_addresses, cc_addresses, bcc_addresses,
                         subject, body_html, in_reply_to, thread_references)
    VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
    RETURNING *
  `, [
    mode || 'new',
    inReplyToEmailId || null,
    toAddresses || [],
    ccAddresses || [],
    bccAddresses || [],
    subject || '',
    bodyHtml || '',
    inReplyTo || null,
    threadReferences || [],
  ]);
  const draft = rows[0];

  if (carryAttachmentsFromEmailId) {
    await db.query(`
      INSERT INTO draft_attachments (draft_id, blob_md5, filename, content_type, size_bytes)
      SELECT $1, blob_md5, filename, content_type, size_bytes
      FROM email_attachments WHERE email_id = $2
    `, [draft.id, carryAttachmentsFromEmailId]);
  }

  res.status(201).json({ ...draft, attachments: await getDraftAttachments(draft.id) });
});

// Partial update, driven by the compose UI's autosave — a caller always sends
// its full current field value (never a partial string), so COALESCE against
// NULL/omitted keys is only there to tolerate a caller that skips a field
// entirely, not to support clearing one to empty (empty string isn't NULL).
app.put('/api/drafts/:id', async (req, res) => {
  const id = parseInt(req.params.id, 10);
  if (!Number.isInteger(id)) return res.status(400).json({ error: 'invalid id' });
  const { toAddresses, ccAddresses, bccAddresses, subject, bodyHtml } = req.body || {};
  const { rows } = await db.query(`
    UPDATE drafts SET
      to_addresses = COALESCE($2, to_addresses),
      cc_addresses = COALESCE($3, cc_addresses),
      bcc_addresses = COALESCE($4, bcc_addresses),
      subject = COALESCE($5, subject),
      body_html = COALESCE($6, body_html),
      updated_at = NOW()
    WHERE id = $1
    RETURNING *
  `, [id, toAddresses ?? null, ccAddresses ?? null, bccAddresses ?? null, subject ?? null, bodyHtml ?? null]);
  if (rows.length === 0) return res.status(404).json({ error: 'not found' });
  res.json({ ...rows[0], attachments: await getDraftAttachments(id) });
});

app.delete('/api/drafts/:id', async (req, res) => {
  const id = parseInt(req.params.id, 10);
  if (!Number.isInteger(id)) return res.status(400).json({ error: 'invalid id' });
  await db.query('DELETE FROM drafts WHERE id = $1', [id]);
  res.status(204).end();
});

app.post('/api/drafts/:id/attachments', upload.array('files', 10), async (req, res) => {
  const id = parseInt(req.params.id, 10);
  if (!Number.isInteger(id)) return res.status(400).json({ error: 'invalid id' });

  const results = [];
  for (const file of req.files || []) {
    const stored = store(ATTACHMENTS_DIR, file.buffer, file.originalname, file.mimetype);

    // store() only writes the blob to disk — the attachment_blobs row (which
    // draft_attachments.blob_md5 references) has to be inserted separately,
    // same as scripts/import-attachments.js does for imported mail.
    await db.query(`
      INSERT INTO attachment_blobs (md5, ext, content_type, size_bytes)
      VALUES ($1, $2, $3, $4)
      ON CONFLICT (md5) DO NOTHING
    `, [stored.md5, stored.ext, stored.contentType, stored.sizeBytes]);

    const { rows } = await db.query(`
      INSERT INTO draft_attachments (draft_id, blob_md5, filename, content_type, size_bytes)
      VALUES ($1, $2, $3, $4, $5)
      RETURNING id, filename, content_type, size_bytes
    `, [id, stored.md5, file.originalname, stored.contentType, stored.sizeBytes]);
    results.push(rows[0]);
  }
  res.status(201).json({ results });
});

app.delete('/api/drafts/:id/attachments/:attachmentId', async (req, res) => {
  const attachmentId = parseInt(req.params.attachmentId, 10);
  if (!Number.isInteger(attachmentId)) return res.status(400).json({ error: 'invalid id' });
  await db.query('DELETE FROM draft_attachments WHERE id = $1', [attachmentId]);
  res.status(204).end();
});

// Submits a draft over Bridge's local SMTP and deletes it on success — the
// one endpoint this file's earlier comments said didn't exist yet. Attachment
// files are streamed straight from the content-addressed blob store, same
// path resolution as /api/draft-attachment/:id.
app.post('/api/drafts/:id/send', async (req, res) => {
  const id = parseInt(req.params.id, 10);
  if (!Number.isInteger(id)) return res.status(400).json({ error: 'invalid id' });

  const { rows } = await db.query('SELECT * FROM drafts WHERE id = $1', [id]);
  if (rows.length === 0) return res.status(404).json({ error: 'not found' });
  const draft = rows[0];

  if ((draft.to_addresses || []).length === 0) {
    return res.status(400).json({ error: 'add at least one recipient' });
  }

  const { rows: attRows } = await db.query(`
    SELECT da.filename, da.content_type, ab.md5, ab.ext
    FROM draft_attachments da JOIN attachment_blobs ab ON ab.md5 = da.blob_md5
    WHERE da.draft_id = $1
  `, [id]);

  try {
    await mailTransport.sendMail({
      from: process.env.IMAP_USER,
      to: draft.to_addresses.join(', '),
      cc: draft.cc_addresses.length ? draft.cc_addresses.join(', ') : undefined,
      bcc: draft.bcc_addresses.length ? draft.bcc_addresses.join(', ') : undefined,
      subject: draft.subject || '(no subject)',
      html: draft.body_html || '',
      inReplyTo: draft.in_reply_to || undefined,
      references: draft.thread_references.length ? draft.thread_references.join(' ') : undefined,
      attachments: attRows.map(a => ({
        filename: a.filename,
        path: blobPath(ATTACHMENTS_DIR, a.md5, a.ext),
        contentType: a.content_type,
      })),
    });
  } catch (err) {
    console.error('[send]', err);
    return res.status(500).json({ error: err.message });
  }

  await db.query('DELETE FROM drafts WHERE id = $1', [id]);
  res.json({ ok: true });
});

// Shared by /api/attachment/:id and /api/draft-attachment/:id below — same
// content-addressed blob, just looked up via a different owning table.
function streamBlob(res, filename, contentType, md5, ext) {
  const filePath = blobPath(ATTACHMENTS_DIR, md5, ext);
  if (!fs.existsSync(filePath)) return res.status(404).end();
  const safeName = (filename || 'attachment').replace(/[\r\n"]/g, '_');
  res.setHeader('Content-Type', contentType || 'application/octet-stream');
  res.setHeader('Content-Disposition', `inline; filename="${safeName}"; filename*=UTF-8''${encodeURIComponent(filename || 'attachment')}`);
  fs.createReadStream(filePath).pipe(res);
}

app.get('/api/draft-attachment/:id', async (req, res) => {
  const id = parseInt(req.params.id, 10);
  if (!Number.isInteger(id)) return res.status(400).end();
  const { rows } = await db.query(`
    SELECT da.filename, da.content_type, ab.md5, ab.ext
    FROM draft_attachments da JOIN attachment_blobs ab ON ab.md5 = da.blob_md5
    WHERE da.id = $1
  `, [id]);
  if (rows.length === 0) return res.status(404).end();
  const { filename, content_type, md5, ext } = rows[0];
  streamBlob(res, filename, content_type, md5, ext);
});

// ─── Shared search-filter builder ────────────────────────────────────────────
// Parses operators/phrases/free text into SQL conditions against the `emails`
// table (unaliased — callers that join other tables must alias those instead).
// Used by both /api/search and /api/search/attachments so the two views of
// "the current search" never drift out of sync with each other.

function buildEmailFilter(q) {
  const { freeText, phrases, filters } = parseQuery(q);

  const conditions = [];
  const params = [];
  const highlightTerms = [];
  const push = (val) => { params.push(val); return params.length; };

  // "exact phrase" — real substring match, not stemmed FTS. Real "exact"
  // means real exact: tsquery phrase search still matches on stemmed
  // lexemes ("invoices" would match a quoted "invoice"), which isn't what
  // someone asking for an exact phrase wants.
  for (const phrase of phrases) {
    const idx = push(`%${escapeLike(phrase)}%`);
    conditions.push(`(subject ILIKE $${idx} OR from_name ILIKE $${idx} OR from_address ILIKE $${idx} OR body_text ILIKE $${idx})`);
    highlightTerms.push(phrase);
  }

  if (filters.from) {
    const idx = push(`%${escapeLike(filters.from)}%`);
    conditions.push(`(from_address ILIKE $${idx} OR from_name ILIKE $${idx})`);
    highlightTerms.push(filters.from);
  }
  if (filters.to) {
    const idx = push(`%${escapeLike(filters.to)}%`);
    conditions.push(`to_address ILIKE $${idx}`);
    highlightTerms.push(filters.to);
  }
  if (filters.subject) {
    const idx = push(`%${escapeLike(filters.subject)}%`);
    conditions.push(`subject ILIKE $${idx}`);
    highlightTerms.push(filters.subject);
  }
  if (filters.hasAttachment) {
    conditions.push(`jsonb_array_length(attachments) > 0`);
  }
  if (filters.before) {
    const idx = push(filters.before);
    conditions.push(`email_date < $${idx}`);
  }
  if (filters.after) {
    const idx = push(filters.after);
    conditions.push(`email_date >= $${idx}`);
  }
  if (filters.date) {
    const isMonth = filters.date.length === 7;
    const start = isMonth ? `${filters.date}-01` : filters.date;
    const idx = push(start);
    conditions.push(`email_date >= $${idx} AND email_date < ($${idx}::date + interval '1 ${isMonth ? 'month' : 'day'}')`);
  }
  if (filters.label) {
    const idx = push(`%${escapeLike(filters.label)}%`);
    conditions.push(`EXISTS (SELECT 1 FROM unnest(labels) l WHERE l ILIKE $${idx})`);
  }
  if (filters.filename) {
    const idx = push(`%${escapeLike(filters.filename)}%`);
    conditions.push(`EXISTS (SELECT 1 FROM email_attachments ea WHERE ea.email_id = emails.id AND ea.filename ILIKE $${idx})`);
    highlightTerms.push(filters.filename);
  }
  if (filters.category) {
    const idx = push(filters.category.toLowerCase());
    conditions.push(`(lower(domain) = $${idx} OR lower(subcategory) = $${idx})`);
  }
  if (filters.company) {
    const idx = push(`%${escapeLike(filters.company)}%`);
    conditions.push(`company ILIKE $${idx}`);
    highlightTerms.push(filters.company);
  }

  let orderBy = 'email_date DESC NULLS LAST';
  if (freeText) {
    const built = buildSearchCondition(freeText, 'search_vector', ['subject', 'from_address', 'from_name'], params.length, 'email_date');
    conditions.push(built.where);
    params.push(...built.params);
    orderBy = built.orderBy;
    highlightTerms.push(...freeText.split(/\s+/).filter(Boolean));
  }

  return { conditions, params, highlightTerms, orderBy, freeText, phrases, filters };
}

app.get('/api/search', async (req, res) => {
  const q = (req.query.q || '').toString().trim();

  if (!q) {
    // No query yet — show the latest mail, same as opening an inbox.
    const { rows } = await db.query(`
      SELECT id, subject, from_address, from_name, email_date, labels,
             domain, subcategory, company, thread_key,
             (SELECT count(*) FROM emails e2 WHERE e2.thread_key = emails.thread_key)::int AS thread_count,
             left(coalesce(body_text, ''), 200) AS snippet
      FROM emails
      ORDER BY email_date DESC NULLS LAST
      LIMIT ${RESULT_LIMIT}
    `);
    return res.json({ terms: [], results: rows });
  }

  try {
    const { conditions, params, highlightTerms, orderBy, freeText, phrases, filters } = buildEmailFilter(q);
    if (conditions.length === 0) return res.json({ terms: [], results: [] });

    // Snippet: prefer a real ts_headline fragment (smart selection out of up
    // to 200k chars of body) when we have free text to build a tsquery from;
    // otherwise fall back to a plain window around whatever the most
    // specific exact term was.
    const prefixTs = freeText ? toTsqueryPrefix(freeText) : null;
    let snippetExpr;
    const snippetParams = [...params];
    if (prefixTs) {
      snippetParams.push(prefixTs);
      const idx = snippetParams.length;
      snippetExpr = `ts_headline('english', coalesce(body_text, ''), to_tsquery('english', $${idx}),
        'StartSel=<<M>>,StopSel=<<M>>,MaxFragments=2,MaxWords=22,MinWords=8,ShortWord=3')`;
    } else {
      const fallbackTerm = phrases[0] || filters.subject || filters.from || '';
      if (fallbackTerm) {
        snippetParams.push(fallbackTerm);
        const idx = snippetParams.length;
        snippetExpr = `
          CASE WHEN position(lower($${idx}) in lower(coalesce(body_text, ''))) > 0
            THEN substring(body_text from greatest(1, position(lower($${idx}) in lower(body_text)) - 80) for 240)
            ELSE left(coalesce(body_text, ''), 200)
          END`;
      } else {
        snippetExpr = `left(coalesce(body_text, ''), 200)`;
      }
    }

    const { rows } = await db.query(`
      SELECT id, subject, from_address, from_name, email_date, labels,
             domain, subcategory, company, thread_key,
             (SELECT count(*) FROM emails e2 WHERE e2.thread_key = emails.thread_key)::int AS thread_count,
             regexp_replace(${snippetExpr}, '<<M>>', '', 'g') AS snippet
      FROM emails
      WHERE ${conditions.join(' AND ')}
      ORDER BY ${orderBy}
      LIMIT ${RESULT_LIMIT}
    `, snippetParams);

    res.json({ terms: highlightTerms, results: rows });
  } catch (err) {
    console.error('[search]', err);
    res.status(500).json({ error: err.message });
  }
});

// The attachment-grid view: every attachment belonging to an email that
// matches the current search, newest email first.
app.get('/api/search/attachments', async (req, res) => {
  const q = (req.query.q || '').toString().trim();

  try {
    let where = 'true';
    let params = [];
    let orderBy = 'emails.email_date DESC NULLS LAST';

    if (q) {
      const built = buildEmailFilter(q);
      if (built.conditions.length === 0) return res.json({ results: [] });
      where = built.conditions.join(' AND ');
      params = built.params;
      orderBy = built.orderBy;
    }

    const { rows } = await db.query(`
      SELECT ea.id, ea.filename, ea.content_type, ea.size_bytes,
             emails.id AS email_id, emails.subject AS email_subject, emails.email_date
      FROM email_attachments ea
      JOIN emails ON emails.id = ea.email_id
      WHERE ${where}
      ORDER BY ${orderBy}
      LIMIT 200
    `, params);

    res.json({ results: rows });
  } catch (err) {
    console.error('[search/attachments]', err);
    res.status(500).json({ error: err.message });
  }
});

app.get('/api/email/:id', async (req, res) => {
  const id = parseInt(req.params.id, 10);
  if (!Number.isInteger(id)) return res.status(400).json({ error: 'invalid id' });

  // message_id/in_reply_to/thread_references/reply_to_* are what Reply/
  // Reply All/Forward need to build correct RFC threading headers and pick a
  // reply target — see openCompose() in public/index.html. attachments is
  // included here (not a separate round trip) so Forward can offer to carry
  // them over without a second fetch.
  const { rows } = await db.query(`
    SELECT e.id, e.subject, e.from_address, e.from_name, e.to_address, e.cc, e.email_date,
           e.body_html, e.body_text, e.labels, e.thread_key,
           e.message_id, e.in_reply_to, e.thread_references, e.reply_to_address, e.reply_to_name,
           COALESCE(
             (SELECT json_agg(json_build_object(
                'id', ea.id, 'filename', ea.filename,
                'content_type', ea.content_type, 'size_bytes', ea.size_bytes
              ) ORDER BY ea.id)
              FROM email_attachments ea WHERE ea.email_id = e.id),
             '[]'
           ) AS attachments
    FROM emails e WHERE e.id = $1
  `, [id]);

  if (rows.length === 0) return res.status(404).json({ error: 'not found' });
  res.json(rows[0]);
});

// Every email in one conversation (scripts/compute-threads.js's thread_key
// grouping), oldest first — the natural reading order for a thread. Reuses
// the same row shape /api/search returns so the frontend's existing render
// helpers work unmodified on it.
app.get('/api/thread/:key', async (req, res) => {
  const key = (req.params.key || '').toString().trim();
  if (!key) return res.status(400).json({ error: 'invalid thread key' });

  const { rows } = await db.query(`
    SELECT id, subject, from_address, from_name, email_date, labels,
           domain, subcategory, company, thread_key,
           left(coalesce(body_text, ''), 200) AS snippet
    FROM emails
    WHERE thread_key = $1
    ORDER BY email_date ASC NULLS LAST
  `, [key]);

  res.json({ results: rows });
});

// Streams the raw attachment file — used for both grid thumbnails (images)
// and the fullscreen preview modal (images inline, PDFs via the browser's
// native PDF viewer since Content-Disposition is "inline").
app.get('/api/attachment/:id', async (req, res) => {
  const id = parseInt(req.params.id, 10);
  if (!Number.isInteger(id)) return res.status(400).end();

  const { rows } = await db.query(`
    SELECT ea.filename, ea.content_type, ab.md5, ab.ext
    FROM email_attachments ea JOIN attachment_blobs ab ON ab.md5 = ea.blob_md5
    WHERE ea.id = $1
  `, [id]);
  if (rows.length === 0) return res.status(404).end();

  const { filename, content_type, md5, ext } = rows[0];
  streamBlob(res, filename, content_type, md5, ext);
});

app.listen(PORT, () => {
  console.log(`better-proton listening on http://localhost:${PORT}`);
  startSync(); // catch up immediately on startup
  setInterval(startSync, SYNC_INTERVAL_MS); // and keep catching up every 5 minutes
});
