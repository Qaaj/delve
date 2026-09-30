#!/usr/bin/env node
/**
 * Repeatable, scored benchmark: runs categorizeEmail() on a curated set of
 * 10 emails with known expected answers (picked from real failures/wins
 * observed this session, see EXPECTED comments) and prints a pass/fail
 * scorecard, not just raw output — built specifically so different models
 * (Qwen, Gemma, whatever's loaded next) can be compared objectively against
 * the same ground truth instead of re-judging each one by hand every time.
 *
 * A few cases have more than one acceptable answer where the "correct"
 * category is genuinely debatable (see inline notes) — those score as a
 * pass on any listed option.
 *
 * Usage: node scripts/bench-categorize.js [id1,id2,...]
 * Passing custom ids skips scoring (no expected answer known) and just
 * prints raw output/timing, same as before.
 */

require('dotenv').config();
const db = require('../lib/db');
const { categorizeEmail, LMSTUDIO_URL, LMSTUDIO_MODEL, CATEGORY_VERSION } = require('../lib/categorize');

// domain/subcategory pairs are "domain/subcategory"; an entry can list
// several acceptable pairs when more than one is defensible.
const CURATED = [
  { id: 96420, note: 'OTP for a booking change — is the "real" category the flight or the security code?',
    expected: ['travel/flight_booking', 'tech_accounts/account_security'] },
  { id: 105522, note: 'a home-services quote — the case that broke every model\'s freelance_platform pick',
    expected: ['freelance_work/proposal_quote', 'housing_rental/contractor_quote'] },
  { id: 108336, note: 'a game publisher\'s broadcast email — promo vs. event announcement',
    expected: ['marketing_newsletter/marketing_promo', 'marketing_newsletter/event_announcement'] },
  { id: 11061, note: 'a corporate-sender email that actually reads as personal club/group correspondence',
    expected: ['personal_social/personal_correspondence'] },
  { id: 56019, note: 'a medical appointment confirmation — not insurance',
    expected: ['health_medical/appointment_scheduling'] },
  { id: 60498, note: '"Newsletter #46" — self-labeled, should not become marketing_promo',
    expected: ['marketing_newsletter/newsletter'] },
  { id: 70956, note: 'a retailer\'s "Sale" email — a genuine one-off promo',
    expected: ['marketing_newsletter/marketing_promo'] },
  { id: 64183, note: 'a specific flight\'s boarding pass — not a general itinerary',
    expected: ['travel/flight_booking'] },
  { id: 16897, note: 'a music-app playlist notification — an app notification, not marketing',
    expected: ['automated_notification/social_media_notification', 'automated_notification/system_alert_misc', 'tech_accounts/service_notification'] },
  { id: 22372, note: 'a hobby-community meetup invite — has a date/time, so an event announcement',
    expected: ['marketing_newsletter/event_announcement'] },
];

const customIds = process.argv[2] ? process.argv[2].split(',').map(Number) : null;
const cases = customIds ? customIds.map(id => ({ id, expected: null })) : CURATED;

async function main() {
  console.log(`LM Studio ${LMSTUDIO_URL}, model "${LMSTUDIO_MODEL}", taxonomy ${CATEGORY_VERSION}`);
  console.log(`Benchmarking ${cases.length} email(s): ${cases.map(c => c.id).join(', ')}\n`);

  const times = [];
  let correct = 0, scored = 0;

  for (const { id, note, expected } of cases) {
    const { rows } = await db.query(
      `SELECT id, subject, from_address, from_name, body_text, body_html, attachments FROM emails WHERE id = $1`,
      [id]
    );
    const email = rows[0];
    if (!email) { console.log(`id=${id}: not found\n`); continue; }

    const t0 = Date.now();
    const result = await categorizeEmail(email);
    const ms = Date.now() - t0;
    times.push(ms);

    const got = `${result.domain}/${result.subcategory}`;
    let mark = '';
    if (expected) {
      scored++;
      const pass = expected.includes(got);
      if (pass) correct++;
      mark = pass ? '✅' : `❌ (expected: ${expected.join(' or ')})`;
    }

    console.log(`id=${id}  "${(email.subject || '').slice(0, 55)}"  (${email.from_address})`);
    if (note) console.log(`  note: ${note}`);
    console.log(`  ${ms} ms | ${got} ${mark}`);
    console.log(`  company: ${result.company} | amount: ${result.amount} ${result.currency} | ref: ${result.referenceNumber} | secondary: ${JSON.stringify(result.secondaryDomains)}`);
    console.log(`  summary: ${result.summary}\n`);
  }

  if (times.length > 0) {
    const total = times.reduce((a, b) => a + b, 0);
    const avg = total / times.length;
    console.log(`TOTAL: ${total} ms over ${times.length} email(s), avg ${avg.toFixed(0)} ms/email`);
  }
  if (scored > 0) {
    console.log(`SCORE: ${correct}/${scored} correct`);
  }

  await db.end();
}

main().catch(err => { console.error('FAILED:', err.message); process.exit(1); });
