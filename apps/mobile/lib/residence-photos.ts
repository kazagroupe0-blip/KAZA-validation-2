import { supabase } from './supabase';

function storagePathFromPhotoRef(value: string): string | null {
  let decoded: string;
  try {
    decoded = decodeURIComponent(value);
  } catch {
    return null;
  }
  const withoutQuery = decoded.split('?')[0];
  if (/^https?:\/\//i.test(withoutQuery)) {
    const marker = '/object/';
    const idx = withoutQuery.lastIndexOf(marker);
    if (idx === -1) return null;
    const base = withoutQuery.slice(idx + marker.length);
    const accessSlash = base.indexOf('/');
    if (accessSlash === -1) return null;
    const bucketPath = base.slice(accessSlash + 1);
    const bucketSlash = bucketPath.indexOf('/');
    if (bucketSlash === -1) return null;
    const path = bucketPath.slice(bucketSlash + 1).replace(/^\/+/, '');
    return path || null;
  }
  return withoutQuery.replace(/^\/+/, '') || null;
}

export async function resolveResidencePhotos(photos: string[]): Promise<string[]> {
  const refs = new Map<string, string>();
  const uniquePaths: string[] = [];

  for (const original of photos) {
    const path = storagePathFromPhotoRef(original);
    if (!path || refs.has(original)) continue;
    refs.set(original, path);
    if (!uniquePaths.includes(path)) uniquePaths.push(path);
  }

  const signedByPath = new Map<string, string>();
  for (let i = 0; i < uniquePaths.length; i += 100) {
    const batch = uniquePaths.slice(i, i + 100);
    const { data, error } = await supabase.storage.from('residence-photos').createSignedUrls(batch, 3600);
    if (error || !data) continue;
    data.forEach((item, index) => {
      if (item.signedUrl) signedByPath.set(batch[index], item.signedUrl);
    });
  }

  return photos
    .map((original) => {
      const path = refs.get(original);
      return path ? signedByPath.get(path) ?? null : null;
    })
    .filter((url): url is string => Boolean(url));
}
