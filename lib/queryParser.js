/**
 * Parses Google-style search syntax out of the raw search box text:
 *   "exact phrase"        -> literal substring match (not stemmed FTS —
 *                            real "exact" means real exact)
 *   from:name  to:name     -> ILIKE against from/to
 *   subject:word            -> ILIKE against subject
 *   has:attachment           -> only emails with attachments
 *   before:YYYY-MM-DD
 *   after:YYYY-MM-DD
 *   date:YYYY-MM-DD or YYYY-MM
 *   label:name  in:name     -> label/folder filter (labels array)
 *   filename:word            -> matches an attached file's name
 *   category:name            -> exact match against emails.domain (from
 *                               lib/categorize.js's AI categorization)
 *   company:name              -> substring match against emails.company
 *
 * Whatever's left after stripping all of the above is free text, which still
 * goes through the normal prefix-matching FTS path in lib/search.js.
 */

const OPERATOR_KEYS = ['from', 'to', 'subject', 'has', 'before', 'after', 'date', 'label', 'in', 'filename', 'category', 'company'];
const DATE_RE = /^\d{4}-\d{2}(-\d{2})?$/;

function parseQuery(raw) {
  let text = raw;
  const phrases = [];

  // Quoted phrases first, so nothing inside them is later mistaken for an operator.
  text = text.replace(/"([^"]+)"/g, (_, phrase) => {
    const trimmed = phrase.trim();
    if (trimmed) phrases.push(trimmed);
    return ' ';
  });

  const filters = {};
  const opPattern = new RegExp(`\\b(${OPERATOR_KEYS.join('|')}):(\\S+)`, 'gi');
  text = text.replace(opPattern, (_, rawKey, rawValue) => {
    const key = rawKey.toLowerCase() === 'in' ? 'label' : rawKey.toLowerCase();
    const value = rawValue.trim();
    if (!value) return ' ';

    if (key === 'has') {
      if (value.toLowerCase() === 'attachment') filters.hasAttachment = true;
    } else if (key === 'before' || key === 'after' || key === 'date') {
      if (DATE_RE.test(value)) filters[key] = value;
    } else {
      filters[key] = value;
    }
    return ' ';
  });

  const freeText = text.replace(/\s+/g, ' ').trim();

  return { freeText, phrases, filters };
}

module.exports = { parseQuery, OPERATOR_KEYS };
