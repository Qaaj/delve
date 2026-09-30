/**
 * Search query builder for Postgres FTS over `emails.search_vector`.
 *
 * Ported from spot's core/search.js — same strategy, same reasoning:
 * plainto/websearch_to_tsquery is great for natural language but bad at
 * partial words, which matters a lot for a live "search as you type" box:
 *   - "invo" won't match "invoice" — to_tsquery looks for the exact
 *     stemmed token, no prefix support
 * So:
 *   SHORT (1-2 chars):  ILIKE only — FTS is useless at this length
 *   ONE WORD:           FTS prefix match (to_tsquery 'word:*') + ILIKE fallback
 *   MULTI-WORD:         websearch_to_tsquery for the full phrase, last token
 *                       gets prefix matching appended
 */

function escapeLike(str) {
  return str.replace(/\\/g, '\\\\').replace(/%/g, '\\%').replace(/_/g, '\\_');
}

/**
 * "invoice conf" → "invoice & conf:*" — all tokens but the last get exact
 * match, the last gets prefix match. Used both for the WHERE condition and
 * (separately) to build the ts_headline snippet.
 */
function toTsqueryPrefix(query) {
  const tokens = query
    .trim()
    .toLowerCase()
    .replace(/[^\w\s-]/g, ' ')
    .split(/\s+/)
    .filter(Boolean);

  if (tokens.length === 0) return null;

  const parts = tokens.map((t, i) => (i < tokens.length - 1 ? t : `${t}:*`));
  return parts.join(' & ');
}

function buildSearchCondition(query, vecCol, likeColumns, paramOffset = 0, dateCol = 'email_date') {
  const q = query.trim();
  const n = (i) => `$${paramOffset + i}`;

  if (q.length <= 2) {
    const pattern = `%${escapeLike(q)}%`;
    const conditions = likeColumns.map((col, i) => `${col} ILIKE ${n(i + 1)}`);
    return {
      where: `(${conditions.join(' OR ')})`,
      orderBy: `${dateCol} DESC NULLS LAST`,
      params: likeColumns.map(() => pattern),
      strategy: 'ilike',
    };
  }

  const tokens = q.split(/\s+/).filter(Boolean);
  const tsquery = toTsqueryPrefix(q);

  if (tokens.length === 1) {
    const pattern = `%${escapeLike(q)}%`;
    const likeOr = likeColumns.map((col, i) => `${col} ILIKE ${n(i + 2)}`);
    return {
      where: tsquery
        ? `(${vecCol} @@ to_tsquery('english', ${n(1)}) OR ${likeOr.join(' OR ')})`
        : `(${likeOr.join(' OR ')})`,
      orderBy: tsquery
        ? `CASE WHEN ${vecCol} @@ to_tsquery('english', ${n(1)}) THEN 0 ELSE 1 END, ${dateCol} DESC NULLS LAST`
        : `${dateCol} DESC NULLS LAST`,
      params: tsquery ? [tsquery, ...likeColumns.map(() => pattern)] : likeColumns.map(() => pattern),
      strategy: 'fts_prefix',
    };
  }

  const prefixTs = toTsqueryPrefix(q);
  const pattern = `%${escapeLike(q)}%`;
  const likeOr = likeColumns.map((col, i) => `${col} ILIKE ${n(i + 3)}`);
  return {
    where: `(${vecCol} @@ websearch_to_tsquery('english', ${n(1)}) OR (${vecCol} @@ to_tsquery('english', ${n(2)})) OR ${likeOr.join(' OR ')})`,
    orderBy: `CASE WHEN ${vecCol} @@ websearch_to_tsquery('english', ${n(1)}) OR ${vecCol} @@ to_tsquery('english', ${n(2)}) THEN ts_rank(${vecCol}, websearch_to_tsquery('english', ${n(1)})) ELSE 0 END DESC, ${dateCol} DESC NULLS LAST`,
    params: [q, prefixTs, ...likeColumns.map(() => pattern)],
    strategy: 'fts+prefix+ilike',
  };
}

module.exports = { buildSearchCondition, toTsqueryPrefix, escapeLike };
