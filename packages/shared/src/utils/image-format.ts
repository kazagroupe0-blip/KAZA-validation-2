export type DetectedImageMime = 'image/jpeg' | 'image/png' | 'image/webp';

/**
 * Détecte le format réel d'une image à partir de ses octets (signatures
 * JPEG, PNG, WEBP). Une extension, `file.type` ou un `contentType` fourni par
 * le client ne prouvent jamais le format binaire : seul ce résultat fait foi.
 * Retourne null pour tout autre contenu (HEIC, GIF, PDF, fichier tronqué...).
 */
export function detectImageMime(bytes: Uint8Array): DetectedImageMime | null {
  if (bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) {
    return 'image/jpeg';
  }

  if (
    bytes.length >= 8 &&
    bytes[0] === 0x89 &&
    bytes[1] === 0x50 &&
    bytes[2] === 0x4e &&
    bytes[3] === 0x47 &&
    bytes[4] === 0x0d &&
    bytes[5] === 0x0a &&
    bytes[6] === 0x1a &&
    bytes[7] === 0x0a
  ) {
    return 'image/png';
  }

  if (
    bytes.length >= 12 &&
    bytes[0] === 0x52 &&
    bytes[1] === 0x49 &&
    bytes[2] === 0x46 &&
    bytes[3] === 0x46 &&
    bytes[8] === 0x57 &&
    bytes[9] === 0x45 &&
    bytes[10] === 0x42 &&
    bytes[11] === 0x50
  ) {
    return 'image/webp';
  }

  return null;
}

export const IMAGE_EXTENSION_BY_MIME: Record<DetectedImageMime, string> = {
  'image/jpeg': 'jpg',
  'image/png': 'png',
  'image/webp': 'webp',
};
