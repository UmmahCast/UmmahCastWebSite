// Image upload pipeline for org logos.
// Security model:
//   - Multer keeps files in memory (no disk write before validation)
//   - Sharp parses the image and re-encodes to PNG, which:
//       * rejects non-image bytes (sharp throws on invalid input)
//       * strips EXIF / GPS / arbitrary metadata
//       * neutralizes SVG (we never emit SVG; sharp re-encodes raster)
//   - Filename is the SHA-256 of the processed bytes — deterministic, no
//     user input in the path, no collision risk
//   - Files are NOT live until a superadmin approves them (separate column)
//
// Path layout (under RECORDINGS_DIR for volume reuse):
//   {recordingsDir}/_uploads/{hash}.png   <-- the file on disk
//   /uploads/{hash}.png                    <-- the public URL (mounted as static)

const path = require('path');
const fs = require('fs');
const crypto = require('crypto');
const sharp = require('sharp');
const multer = require('multer');

// 5 MB raw upload cap; processed PNG will be much smaller.
const MAX_UPLOAD_BYTES = 5 * 1024 * 1024;
// Final image dimensions — square crop to 512.
const TARGET_SIZE = 512;
const ALLOWED_MIMES = new Set(['image/jpeg', 'image/png', 'image/webp']);

function uploadsDir(recordingsDir) {
  const d = path.join(recordingsDir, '_uploads');
  if (!fs.existsSync(d)) fs.mkdirSync(d, { recursive: true });
  return d;
}

const memUpload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: MAX_UPLOAD_BYTES, files: 1, fields: 0 },
  fileFilter: (req, file, cb) => {
    // First-pass mime check from the multipart envelope. Sharp will catch any
    // mime/content mismatch by failing to decode; this just rejects obvious junk early.
    if (!ALLOWED_MIMES.has(file.mimetype)) {
      return cb(new Error('Only JPEG, PNG, or WebP images are allowed'));
    }
    cb(null, true);
  },
});

// Process an in-memory image buffer:
//   - resize to fit 512x512 (cover)
//   - strip metadata
//   - re-encode as PNG
// Returns { hash, filename, size, publicUrl } on success.
async function processAndStore(buffer, recordingsDir) {
  // sharp throws if the buffer isn't a real image — this is our authoritative validation
  const meta = await sharp(buffer).metadata();
  if (!meta.format || !['jpeg', 'png', 'webp'].includes(meta.format)) {
    throw new Error('Unsupported image format');
  }
  // Reject zero-dim or absurdly small (likely tracking pixels)
  if (!meta.width || !meta.height || meta.width < 32 || meta.height < 32) {
    throw new Error('Image too small');
  }

  const processed = await sharp(buffer, { failOn: 'error' })
    .rotate() // honor EXIF orientation BEFORE stripping it
    .resize(TARGET_SIZE, TARGET_SIZE, { fit: 'cover', position: 'centre' })
    .png({ compressionLevel: 9, palette: false })
    .toBuffer();

  const hash = crypto.createHash('sha256').update(processed).digest('hex').slice(0, 32);
  const filename = `${hash}.png`;
  const dir = uploadsDir(recordingsDir);
  const fullPath = path.join(dir, filename);
  if (!fs.existsSync(fullPath)) fs.writeFileSync(fullPath, processed, { mode: 0o644 });

  return {
    hash,
    filename,
    size: processed.length,
    publicUrl: `/uploads/${filename}`,
  };
}

function deleteUpload(recordingsDir, publicUrl) {
  if (!publicUrl || typeof publicUrl !== 'string') return;
  // Only delete files we own (must be /uploads/{hash}.png). Refuses anything else
  // — guards against deleting external URLs or path traversal attempts.
  const m = publicUrl.match(/^\/uploads\/([a-f0-9]{32})\.png$/);
  if (!m) return;
  const filePath = path.join(recordingsDir, '_uploads', m[1] + '.png');
  // Resolve guard: ensure the resolved path is still inside the uploads dir
  const dir = path.resolve(uploadsDir(recordingsDir)) + path.sep;
  if (!path.resolve(filePath).startsWith(dir)) return;
  try { fs.unlinkSync(filePath); } catch {}
}

module.exports = { memUpload, processAndStore, deleteUpload, uploadsDir, MAX_UPLOAD_BYTES };
