/**
 * mailparser's `parsed.date` silently falls back to `new Date()` (the
 * moment of parsing) whenever the Date header it picked doesn't parse —
 * and when a message has a duplicate Date header (seen in some vintage
 * Hotmail/MSN Messenger auto-notifications re-wrapped by Proton's Gmail
 * import), it picks the LAST one, which can be a non-standard format like
 * "23 Jan 2007 12:16:10 Pacific Standard Time" that fails to parse. The
 * result: an email from 2007 silently gets stamped with today's date.
 *
 * This walks the raw header lines directly and takes the first Date: value
 * that actually parses, ignoring mailparser's own (fallback-prone) verdict.
 * Returns null — not "now" — if nothing usable is found.
 */
function extractRealDate(parsed) {
  const dateLines = (parsed.headerLines || []).filter(h => h.key === 'date');
  for (const { line } of dateLines) {
    const value = line.replace(/^date:\s*/i, '').trim();
    const d = new Date(value);
    if (!isNaN(d.getTime())) return d;
  }
  return null;
}

module.exports = { extractRealDate };
