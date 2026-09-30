/**
 * Content-addressed attachment blob store.
 *
 * On disk: {ATTACHMENTS_DIR}/{ext}/{md5}{ext} — renamed to hash, grouped by
 * extension so one folder doesn't end up with hundreds of thousands of files.
 * The original filename only ever lives in the DB (email_attachments.filename),
 * never on disk — so there's no filename sanitization/collision problem, and
 * downloads just set Content-Disposition from the DB value.
 *
 * The path is never persisted anywhere — always {dir}/{ext}/{md5}{ext},
 * recomputed from the current ATTACHMENTS_DIR each time. Move the folder,
 * update the env var, done — no repair script needed.
 */

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const MIN_INLINE_SIZE = 20 * 1024; // below this, an inline/related image is almost certainly a logo or tracking pixel, not a real attachment

const EXT_BY_MIME = {
  'application/pdf': '.pdf',
  'image/jpeg': '.jpg', 'image/png': '.png', 'image/gif': '.gif', 'image/webp': '.webp', 'image/heic': '.heic',
  'application/msword': '.doc',
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document': '.docx',
  'application/vnd.ms-excel': '.xls',
  'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet': '.xlsx',
  'application/vnd.ms-powerpoint': '.ppt',
  'application/vnd.openxmlformats-officedocument.presentationml.presentation': '.pptx',
  'text/plain': '.txt',
  'text/calendar': '.ics',
  'application/zip': '.zip',
};

function md5(buf) {
  return crypto.createHash('md5').update(buf).digest('hex');
}

function extFor(filename, contentType) {
  const fromName = filename ? path.extname(filename).toLowerCase() : '';
  return fromName || EXT_BY_MIME[contentType] || '';
}

/** True for small inline images that are almost certainly UI chrome, not a
 * "real" attachment worth storing (email logos, tracking pixels, etc). */
function isNoise(attachment) {
  const isInlineRelated = attachment.contentDisposition === 'inline' && attachment.related;
  const isSmall = (attachment.size || attachment.content?.length || 0) < MIN_INLINE_SIZE;
  return isInlineRelated && isSmall;
}

function blobPath(attachmentsDir, hash, ext) {
  const extFolder = ext ? ext.replace(/^\./, '') : 'other';
  return path.join(attachmentsDir, extFolder, `${hash}${ext}`);
}

/**
 * Writes a buffer to the content-addressed store if it's not already there.
 * Returns { md5, ext, contentType, sizeBytes, isNew }.
 */
function store(attachmentsDir, buffer, filename, contentType) {
  const hash = md5(buffer);
  const ext = extFor(filename, contentType);
  const dest = blobPath(attachmentsDir, hash, ext);

  const isNew = !fs.existsSync(dest);
  if (isNew) {
    fs.mkdirSync(path.dirname(dest), { recursive: true });
    fs.writeFileSync(dest, buffer);
  }

  return {
    md5: hash,
    ext,
    contentType: contentType || 'application/octet-stream',
    sizeBytes: buffer.length,
    isNew,
  };
}

module.exports = { store, isNoise, blobPath, md5, extFor };
