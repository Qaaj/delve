#!/usr/bin/env node
/**
 * Super basic sanity check: dumps the last 10 emails that have a captured
 * pm_internal_id into a static HTML page with clickable "open in Proton"
 * links, so we can confirm the deep-link approach actually works from a
 * real logged-in browser.
 */

require('dotenv').config();
const fs = require('fs');
const path = require('path');
const db = require('../lib/db');

const ACCOUNT_INDEX = process.env.PROTON_ACCOUNT_INDEX || '0';

const FOLDER_SLUGS = {
  'INBOX': 'inbox',
  'Sent': 'sent',
  'Archive': 'archive',
  'Drafts': 'drafts',
  'Trash': 'trash',
  'Spam': 'spam',
  'Starred': 'starred',
  'All Mail': 'all-mail',
};

function protonUrl(pmInternalId, labels) {
  if (!pmInternalId) return null;
  const primaryLabel = (labels || [])[0];
  const slug = FOLDER_SLUGS[primaryLabel] || 'all-mail';
  return `https://mail.proton.me/u/${ACCOUNT_INDEX}/${slug}/${pmInternalId}`;
}

function esc(str) {
  return String(str ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

async function main() {
  const { rows } = await db.query(`
    SELECT subject, from_address, from_name, email_date, labels, pm_internal_id
    FROM emails
    ORDER BY id DESC
    LIMIT 10
  `);

  const rowsHtml = rows.map(r => {
    const url = protonUrl(r.pm_internal_id, r.labels);
    return `
      <tr>
        <td>${esc(r.email_date ? new Date(r.email_date).toLocaleString() : '')}</td>
        <td>${esc(r.from_name || r.from_address)}</td>
        <td>${esc(r.subject)}</td>
        <td>${esc((r.labels || []).join(', '))}</td>
        <td>${url ? `<a href="${esc(url)}" target="_blank">open in Proton</a>` : '<em>no pm_internal_id yet</em>'}</td>
      </tr>`;
  }).join('\n');

  const html = `<!DOCTYPE html>
<html>
<head>
<meta charset="utf-8">
<title>better-proton preview</title>
<style>
  body { font-family: -apple-system, sans-serif; margin: 2rem; }
  table { border-collapse: collapse; width: 100%; }
  th, td { border: 1px solid #ccc; padding: 6px 10px; text-align: left; font-size: 14px; }
  th { background: #f0f0f0; }
</style>
</head>
<body>
  <h2>Last 10 imported emails</h2>
  <p>Click "open in Proton" — needs your real logged-in browser session.</p>
  <table>
    <tr><th>Date</th><th>From</th><th>Subject</th><th>Labels</th><th>Link</th></tr>
    ${rowsHtml}
  </table>
</body>
</html>`;

  const outPath = path.join(__dirname, '..', 'preview.html');
  fs.writeFileSync(outPath, html);
  console.log('wrote', outPath);
  await db.end();
}

main().catch(err => { console.error(err); process.exit(1); });
