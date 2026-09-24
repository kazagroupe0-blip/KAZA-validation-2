import { describe, expect, it } from 'vitest';
import { createClient } from '@supabase/supabase-js';
import { supabaseAdmin } from '../helpers/supabase-test-client';

const storageAdmin = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL!,
  process.env.SUPABASE_SERVICE_ROLE_KEY!,
  {
    db: { schema: 'storage' },
    auth: { autoRefreshToken: false, persistSession: false },
  },
);

describe('Storage upload contract', () => {
  it('keeps bucket-level size and MIME restrictions explicit', async () => {
    const { data, error } = await storageAdmin
      .from('buckets')
      .select('id, file_size_limit, allowed_mime_types, public')
      .in('id', ['residence-photos', 'chat-files', 'expenses', 'receipts']);

    expect(error).toBeNull();
    expect(data).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          id: 'residence-photos',
          file_size_limit: 8 * 1024 * 1024,
          allowed_mime_types: ['image/jpeg', 'image/png', 'image/webp'],
          public: true,
        }),
        expect.objectContaining({
          id: 'chat-files',
          file_size_limit: 8 * 1024 * 1024,
          allowed_mime_types: ['image/jpeg', 'image/png', 'image/webp', 'application/pdf'],
          public: false,
        }),
        expect.objectContaining({
          id: 'expenses',
          file_size_limit: 5 * 1024 * 1024,
          allowed_mime_types: ['image/jpeg', 'image/png', 'image/webp', 'image/gif', 'application/pdf'],
          public: false,
        }),
        expect.objectContaining({
          id: 'receipts',
          public: false,
        }),
      ]),
    );
  });

  it('keeps the server MIME whitelist restricted to supported formats', async () => {
    const { data: allowedImage, error: allowedImageError } = await supabaseAdmin.rpc(
      '_allowed_upload_mime',
      { p_mime: 'image/webp' },
    );
    const { data: allowedPdf, error: allowedPdfError } = await supabaseAdmin.rpc(
      '_allowed_upload_mime',
      { p_mime: 'application/pdf' },
    );
    const { data: deniedGif, error: deniedGifError } = await supabaseAdmin.rpc(
      '_allowed_upload_mime',
      { p_mime: 'image/gif' },
    );

    expect(allowedImageError).toBeNull();
    expect(allowedPdfError).toBeNull();
    expect(deniedGifError).toBeNull();
    expect(allowedImage).toBe(true);
    expect(allowedPdf).toBe(true);
    expect(deniedGif).toBe(false);
  });
});
