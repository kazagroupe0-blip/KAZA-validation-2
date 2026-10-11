'use client';

import { useEffect, useState } from 'react';
import { useRouter } from 'next/navigation';
import Image from 'next/image';
import { Upload, Trash2 } from 'lucide-react';
import { createResidence, updateResidence, ApiError, getSignedStorageUrl } from '@/lib/supabase-api';
import { storagePathFromUrl } from '@/lib/api/storage';
import { supabase } from '@/lib/supabase-client';
import type { ResidenceWithRelations, ResidenceType } from '@/lib/types';
import { TYPE_LABELS } from '@/lib/format';
import { Input } from '@/components/ui/input';
import { Select } from '@/components/ui/select';
import { Button } from '@/components/ui/button';
import { useToast } from '@/components/ui/toast';

const initial = {
  title: '',
  description: '',
  type: 'appartement' as ResidenceType,
  price_monthly: '',
  deposit: '',
  bedrooms: '1',
  bathrooms: '1',
  surface: '',
  address: '',
  city: 'Cotonou',
  zone: '',
};

const MAX_PHOTOS = 12;
const MAX_FILE_SIZE = 5 * 1024 * 1024; // 5 Mo (plafond F05)

function validateForm(form: typeof initial): Record<string, string[]> {
  const errors: Record<string, string[]> = {};

  if (!form.title.trim()) {
    errors.title = ['Le titre est requis'];
  } else if (form.title.trim().length < 3) {
    errors.title = ['Le titre doit contenir au moins 3 caractères'];
  }

  if (!form.price_monthly || Number(form.price_monthly) <= 0) {
    errors.price_monthly = ['Le loyer mensuel doit être supérieur à 0'];
  }

  const deposit = Number(form.deposit || 0);
  const price = Number(form.price_monthly || 0);
  if (deposit > price * 3) {
    errors.deposit = ['La caution ne peut pas dépasser 3 mois de loyer (Loi 2022-30)'];
  }

  if (Number(form.bedrooms) < 0) {
    errors.bedrooms = ['Le nombre de chambres ne peut pas être négatif'];
  }

  if (Number(form.bathrooms) < 0) {
    errors.bathrooms = ['Le nombre de salles de bain ne peut pas être négatif'];
  }

  if (!form.city.trim()) {
    errors.city = ['La ville est requise'];
  }

  if (!form.zone.trim()) {
    errors.zone = ['Le quartier / zone est requis'];
  }

  return errors;
}

export function ResidenceForm({ existing }: Readonly<{ existing?: ResidenceWithRelations | null }>) {
  const router = useRouter();
  const toast = useToast();
  const [form, setForm] = useState(() =>
    existing
      ? {
          title: existing.title,
          description: existing.description ?? '',
          type: existing.type,
          price_monthly: String(existing.price_monthly),
          deposit: String(existing.deposit),
          bedrooms: String(existing.bedrooms),
          bathrooms: String(existing.bathrooms),
          surface: existing.surface != null ? String(existing.surface) : '',
          address: existing.address ?? '',
          city: existing.city ?? '',
          zone: existing.zone ?? '',
        }
      : initial,
  );
  const [photos, setPhotos] = useState<string[]>(() =>
    (existing?.photos ?? []).map(storagePathFromUrl).filter((path): path is string => Boolean(path)),
  );
  const [photoPreviewUrls, setPhotoPreviewUrls] = useState<Record<string, string>>({});
  const [uploading, setUploading] = useState(false);
  const [saving, setSaving] = useState(false);
  const [errors, setErrors] = useState<Record<string, string[]>>({});

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      const entries = await Promise.all(
        photos.map(async (photo) => {
          const signed = await getSignedStorageUrl('residence-photos', photo);
          return signed ? [photo, signed] as const : null;
        }),
      );
      if (cancelled) return;
      setPhotoPreviewUrls(Object.fromEntries(entries.filter((entry): entry is readonly [string, string] => Boolean(entry))));
    })();
    return () => {
      cancelled = true;
    };
  }, [photos]);

  const set = (key: keyof typeof form) => (e: React.ChangeEvent<HTMLInputElement | HTMLSelectElement | HTMLTextAreaElement>) => {
    setForm((f) => ({ ...f, [key]: e.target.value }));
    // Clear error for this field on change
    if (errors[key]) {
      setErrors((prev) => {
        const next = { ...prev };
        delete next[key];
        return next;
      });
    }
  };

  async function uploadPhotos(files: FileList | null) {
    if (!files || files.length === 0) return;

    const remainingSlots = MAX_PHOTOS - photos.length;
    if (remainingSlots <= 0) {
      toast.error(`Maximum ${MAX_PHOTOS} photos autorisees`);
      return;
    }

    const validFiles = Array.from(files).slice(0, remainingSlots);
    if (validFiles.length !== files.length) {
      toast.error(`Maximum ${MAX_PHOTOS} photos autorisees - ${files.length - validFiles.length} ignoree(s)`);
    }

    setUploading(true);
    const uploadedPaths: string[] = [];
    const validatedPathsInOrder: string[] = [];
    const validatedPreviews: Record<string, string> = {};
    const allowedMimeTypes = new Set(['image/jpeg', 'image/png', 'image/webp']);

    try {
      const { data: { user }, error: userError } = await supabase.auth.getUser();
      if (userError || !user?.id) {
        throw new Error('Session utilisateur indisponible. Reconnectez-vous.');
      }

      const bucket = supabase.storage.from('residence-photos');
      const concurrency = 4;

      for (let i = 0; i < validFiles.length; i += concurrency) {
        const batch = validFiles.slice(i, i + concurrency);
        const results = await Promise.allSettled(
          batch.map(async (file) => {
            if (file.size < 12 || file.size > MAX_FILE_SIZE) {
              throw new Error(`${file.name} : taille non autorisee (12 octets a 5 Mo).`);
            }

            const contentType = file.type.toLowerCase().split(';', 1)[0]?.trim() ?? '';
            if (!allowedMimeTypes.has(contentType)) {
              throw new Error(`${file.name} : format d'image non pris en charge.`);
            }

            const safeName = file.name.replace(/[^\w.-]/g, '_');
            const path = `${user.id}/${Date.now()}-${Math.random().toString(36).slice(2, 10)}-${safeName}`;
            const { error } = await bucket.upload(path, file, {
              contentType,
              upsert: false,
            });

            if (error) {
              throw new Error(`Echec de l'upload de ${file.name} : ${error.message}`);
            }

            // Track immediately so a later failure can clean this object's upload.
            uploadedPaths.push(path);
            let signedUrl: string | null = null;

            for (let attempt = 0; attempt < 30; attempt += 1) {
              signedUrl = await getSignedStorageUrl('residence-photos', path).catch(() => null);
              if (signedUrl) break;
              if (attempt < 29) {
                await new Promise<void>((resolve) => setTimeout(resolve, 500));
              }
            }

            if (!signedUrl) {
              throw new Error(`${file.name} : validation non confirmee apres 15 secondes. Reessayez.`);
            }

            validatedPreviews[path] = signedUrl;
            return path;
          })
        );

        // Promise.allSettled ensures every upload in this batch has finished before cleanup.
        for (const result of results) {
          if (result.status === 'rejected') {
            const reason = result.reason;
            throw reason instanceof Error ? reason : new Error("Echec de validation d\u0027une photo.");
          }
          validatedPathsInOrder.push(result.value);
        }
      }

      // Keep the user's selection order for the cover photo.
      setPhotoPreviewUrls((previous) => ({ ...previous, ...validatedPreviews }));
      setPhotos((previous) => [...previous, ...validatedPathsInOrder]);
    } catch (error) {
      if (uploadedPaths.length > 0) {
        try {
          const { error: cleanupError } = await supabase.storage
            .from('residence-photos')
            .remove(Array.from(new Set(uploadedPaths)));
          if (cleanupError) {
            console.error('[KAZA residence] upload cleanup failed', cleanupError);
          }
        } catch (cleanupError) {
          console.error('[KAZA residence] upload cleanup threw', cleanupError);
        }
      }

      toast.error(error instanceof Error ? error.message : 'Upload des photos impossible.');
    } finally {
      setUploading(false);
    }
  }

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    const validationErrors = validateForm(form);
    if (Object.keys(validationErrors).length > 0) {
      setErrors(validationErrors);
      return;
    }
    setErrors({});
    setSaving(true);
    const payload = {
      ...form,
      price_monthly: Number(form.price_monthly),
      deposit: Number(form.deposit || 0),
      bedrooms: Number(form.bedrooms),
      bathrooms: Number(form.bathrooms),
      surface: form.surface ? Number(form.surface) : null,
      photos,
    };
    try {
      if (existing) {
        await updateResidence(existing.id, payload);
        toast.success('Bien mis à jour');
      } else {
        const created = await createResidence(payload);
        toast.success('Bien créé', 'Publiez-le depuis votre espace pour le rendre visible.');
        router.push(`/landlord/residences/${created.id}/edit`);
        return;
      }
      router.push('/landlord/dashboard');
    } catch (err) {
      if (err instanceof ApiError) {
        if (err.status === 409) toast.error('Limite du plan gratuit', '1 bien en ligne pour le plan gratuit — passez au Premium.');
        else if (err.fields) setErrors(err.fields);
        else toast.error(err.message);
      } else toast.error('Enregistrement impossible');
    } finally {
      setSaving(false);
    }
  }

  return (
    <form onSubmit={submit} className="max-w-3xl space-y-6">
      {/* Photos */}
      <section aria-labelledby="photos-title">
        <h2 id="photos-title" className="kaza-label !text-sm font-semibold !text-kaza-text">
          Photos du bien
        </h2>
        <div className="flex flex-wrap gap-3">
          {photos.map((p) => (
            <div key={p} className="relative h-24 w-32 overflow-hidden rounded-kaza border border-kaza-border">
              {photoPreviewUrls[p] ? (
                <Image src={photoPreviewUrls[p]} alt="" fill className="object-cover" sizes="128px" />
              ) : (
                <div className="grid h-full place-items-center text-xs text-kaza-faint">Aperçu indisponible</div>
              )}
              <button
                type="button"
                onClick={() => setPhotos((prev) => prev.filter((x) => x !== p))}
                className="absolute right-1 top-1 grid h-6 w-6 place-items-center rounded-md bg-kaza-danger text-white"
                aria-label="Retirer la photo"
              >
                <Trash2 className="h-3.5 w-3.5" aria-hidden />
              </button>
            </div>
          ))}
          <label
            className="grid h-24 w-32 cursor-pointer place-items-center rounded-kaza border border-dashed border-kaza-border text-kaza-faint transition-colors hover:border-kaza-brand hover:text-kaza-brand"
            role="button"
            tabIndex={0}
            onKeyDown={(e) => e.key === 'Enter' && (e.target as HTMLElement).click()}
          >
            {uploading ? 'Upload…' : <Upload className="h-5 w-5" aria-hidden />}
            <input
              type="file"
              accept="image/*"
              multiple
              className="sr-only"
              aria-label="Ajouter des photos"
              onChange={(e) => {
                void uploadPhotos(e.target.files);
                e.target.value = '';
              }}
            />
          </label>
        </div>
        <p className="mt-2 text-xs text-kaza-faint">Jusqu’à {MAX_PHOTOS} photos, 5 Mo max chacune. La première sert de couverture.</p>
      </section>

      <div className="grid gap-4 sm:grid-cols-2">
        <Input label="Titre" required placeholder="Ex: Villa 3 chambres Haie Vive" value={form.title} onChange={set('title')} error={errors.title?.[0]} />
        <Select
          label="Type de bien"
          value={form.type}
          onChange={set('type')}
          options={Object.entries(TYPE_LABELS).map(([v, l]) => ({ value: v, label: l }))}
        />
      </div>

      <div>
        <label htmlFor="description" className="kaza-label !text-sm font-semibold !text-kaza-text">
          Description
        </label>
        <textarea
          id="description"
          placeholder="Étages, équipements, proche de…"
          value={form.description}
          onChange={set('description')}
          className="mt-1.5 block min-h-24 w-full rounded-kaza border border-kaza-border bg-white px-3.5 py-2.5 text-sm text-kaza-text placeholder:text-kaza-faint focus:border-kaza-brand focus:outline-none focus:ring-2 focus:ring-kaza-brand/20"
        />
      </div>

      <div className="grid gap-4 sm:grid-cols-3">
        <Input label="Loyer mensuel (FCFA)" type="number" min={1} required placeholder="100000" value={form.price_monthly} onChange={set('price_monthly')} error={errors.price_monthly?.[0]} />
        <Input label="Caution (FCFA)" type="number" min={0} placeholder="300000" value={form.deposit} onChange={set('deposit')} hint="Max 3 mois (Loi 2022-30)" error={errors.deposit?.[0]} />
        <Input label="Superficie (m²)" type="number" min={0} placeholder="120" value={form.surface} onChange={set('surface')} />
      </div>

      <div className="grid gap-4 sm:grid-cols-2">
        <Input label="Chambres" type="number" min={0} value={form.bedrooms} onChange={set('bedrooms')} error={errors.bedrooms?.[0]} />
        <Input label="Salles de bain" type="number" min={0} value={form.bathrooms} onChange={set('bathrooms')} error={errors.bathrooms?.[0]} />
      </div>

      <div className="grid gap-4 sm:grid-cols-2">
        <Input label="Ville" required value={form.city} onChange={set('city')} error={errors.city?.[0]} />
        <Input label="Quartier / zone" required placeholder="Haie Vive, Fidjrossè…" value={form.zone} onChange={set('zone')} error={errors.zone?.[0]} />
      </div>
      <Input label="Adresse précise (facultatif)" value={form.address} onChange={set('address')} hint="Géolocalisation automatique depuis ville + zone (OpenStreetMap)." />

      <Button type="submit" loading={saving} disabled={uploading} size="lg" className="w-full sm:w-auto">
        {existing ? 'Enregistrer les modifications' : 'Créer le bien'}
      </Button>
    </form>
  );
}