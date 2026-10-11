import { detectImageMime, IMAGE_EXTENSION_BY_MIME, type DetectedImageMime } from '@kaza/shared';
import { supabase } from '@/lib/supabase';

export interface PreparedImage {
  bytes: ArrayBuffer;
  mime: DetectedImageMime;
  extension: string;
}

/**
 * Lit l'image sélectionnée et détermine son format RÉEL à partir des octets.
 * Aucun contentType n'est déduit de l'extension, de blob.type ou du picker.
 * Les formats non pris en charge (HEIC, GIF...) sont refusés explicitement.
 */
export async function prepareImageForUpload(uri: string): Promise<PreparedImage> {
  const response = await fetch(uri);
  if (!response.ok) {
    throw new Error("Impossible de lire l'image sélectionnée.");
  }

  const bytes = await response.arrayBuffer();
  const mime = detectImageMime(new Uint8Array(bytes));
  if (!mime) {
    throw new Error("Format d'image non pris en charge (JPEG, PNG ou WEBP requis).");
  }

  return { bytes, mime, extension: IMAGE_EXTENSION_BY_MIME[mime] };
}

/**
 * Le Storage refuse la lecture d'un objet tant que sa validation serveur n'est
 * pas terminée : l'obtention d'une URL signée prouve que l'objet est validé.
 * Retourne null si la validation n'est pas confirmée dans le délai imparti.
 */
export async function waitForValidatedSignedUrl(
  bucket: 'chat-files' | 'residence-photos',
  path: string,
  attempts = 12,
  delayMs = 500,
): Promise<string | null> {
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    const { data, error } = await supabase.storage.from(bucket).createSignedUrl(path, 3600);
    if (!error && data?.signedUrl) return data.signedUrl;
    if (attempt < attempts - 1) {
      await new Promise<void>((resolve) => setTimeout(resolve, delayMs));
    }
  }
  return null;
}
