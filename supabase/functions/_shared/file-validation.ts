export const MIN_VALIDATED_FILE_SIZE_BYTES = 12;
// Plafond fonctionnel F05 : 5 MiB par fichier (aligne sur [storage] file_size_limit = "5MiB").
export const MAX_VALIDATED_FILE_SIZE_BYTES = 5 * 1024 * 1024;

export type AllowedUploadType = 'JPEG' | 'PNG' | 'PDF' | 'WEBP';

export function detectAllowedUploadType(bytes: Uint8Array): AllowedUploadType | null {
  if (
    bytes.length < MIN_VALIDATED_FILE_SIZE_BYTES ||
    bytes.length > MAX_VALIDATED_FILE_SIZE_BYTES
  ) {
    return null;
  }

  if (bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) return 'JPEG';

  if (
    bytes[0] === 0x89 &&
    bytes[1] === 0x50 &&
    bytes[2] === 0x4e &&
    bytes[3] === 0x47 &&
    bytes[4] === 0x0d &&
    bytes[5] === 0x0a &&
    bytes[6] === 0x1a &&
    bytes[7] === 0x0a
  ) {
    return 'PNG';
  }

  if (
    bytes[0] === 0x25 &&
    bytes[1] === 0x50 &&
    bytes[2] === 0x44 &&
    bytes[3] === 0x46
  ) {
    return 'PDF';
  }

  if (
    bytes[0] === 0x52 &&
    bytes[1] === 0x49 &&
    bytes[2] === 0x46 &&
    bytes[3] === 0x46 &&
    bytes[8] === 0x57 &&
    bytes[9] === 0x45 &&
    bytes[10] === 0x42 &&
    bytes[11] === 0x50
  ) {
    return 'WEBP';
  }

  return null;
}

export type UploadBucket = 'residence-photos' | 'chat-files';

export const UPLOAD_BUCKETS: readonly UploadBucket[] = ['residence-photos', 'chat-files'];

export const MIME_BY_UPLOAD_TYPE: Record<AllowedUploadType, string> = {
  JPEG: 'image/jpeg',
  PNG: 'image/png',
  WEBP: 'image/webp',
  PDF: 'application/pdf',
};

/**
 * Contrat par bucket (doit rester identique à public._guard_storage_upload) :
 * - residence-photos : images uniquement ;
 * - chat-files : images et PDF.
 */
export const ALLOWED_TYPES_BY_BUCKET: Record<UploadBucket, readonly AllowedUploadType[]> = {
  'residence-photos': ['JPEG', 'PNG', 'WEBP'],
  'chat-files': ['JPEG', 'PNG', 'WEBP', 'PDF'],
};

export function isUploadBucket(bucket: unknown): bucket is UploadBucket {
  return typeof bucket === 'string' && (UPLOAD_BUCKETS as readonly string[]).includes(bucket);
}

export type UploadContentVerdict =
  | { ok: true; type: AllowedUploadType; mime: string }
  | { ok: false; reason: string };

/**
 * Confronte les octets réels, le MIME déclaré et le bucket. Le MIME déclaré
 * seul n'est jamais une preuve : il doit correspondre au format détecté.
 */
export function validateUploadContent(input: {
  bucket: UploadBucket;
  declaredMime: unknown;
  bytes: Uint8Array;
}): UploadContentVerdict {
  const { bucket, bytes } = input;

  if (bytes.length < MIN_VALIDATED_FILE_SIZE_BYTES) {
    return { ok: false, reason: `file too small (${bytes.length} bytes)` };
  }
  if (bytes.length > MAX_VALIDATED_FILE_SIZE_BYTES) {
    return { ok: false, reason: `file too large (${bytes.length} bytes)` };
  }

  const type = detectAllowedUploadType(bytes);
  if (!type) {
    return { ok: false, reason: 'invalid magic bytes' };
  }

  if (!ALLOWED_TYPES_BY_BUCKET[bucket].includes(type)) {
    return { ok: false, reason: `file type ${type} not allowed in bucket ${bucket}` };
  }

  const declared =
    typeof input.declaredMime === 'string' ? input.declaredMime.trim().toLowerCase() : '';
  const mime = MIME_BY_UPLOAD_TYPE[type];

  if (declared !== mime) {
    return { ok: false, reason: 'declared MIME does not match detected file content' };
  }

  return { ok: true, type, mime };
}
