import { describe, expect, it } from 'vitest';
import {
  detectAllowedUploadType,
  MAX_VALIDATED_FILE_SIZE_BYTES,
  MIN_VALIDATED_FILE_SIZE_BYTES,
} from '../supabase/functions/_shared/file-validation';

function bytes(...values: number[]) {
  return Uint8Array.from(values);
}

describe('Storage real-content validation', () => {
  it('accepts legitimate JPEG/PNG/PDF/WEBP signatures', () => {
    expect(detectAllowedUploadType(bytes(0xff, 0xd8, 0xff, ...new Array(9).fill(0)))).toBe('JPEG');
    expect(
      detectAllowedUploadType(
        bytes(0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, ...new Array(4).fill(0)),
      ),
    ).toBe('PNG');
    expect(detectAllowedUploadType(bytes(0x25, 0x50, 0x44, 0x46, ...new Array(8).fill(0)))).toBe(
      'PDF',
    );
    expect(
      detectAllowedUploadType(
        bytes(
          0x52,
          0x49,
          0x46,
          0x46,
          0x00,
          0x00,
          0x00,
          0x00,
          0x57,
          0x45,
          0x42,
          0x50,
        ),
      ),
    ).toBe('WEBP');
  });

  it('rejects forged or unknown content even when the declared MIME would be allowed', () => {
    expect(detectAllowedUploadType(bytes(...new Array(MIN_VALIDATED_FILE_SIZE_BYTES).fill(0)))).toBe(
      null,
    );
  });

  it('rejects truncated signatures', () => {
    expect(detectAllowedUploadType(bytes(0xff, 0xd8, 0xff))).toBeNull();
    expect(
      detectAllowedUploadType(bytes(0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x1a)),
    ).toBeNull();
  });

  it('rejects files larger than the server-side validation cap', () => {
    const large = new Uint8Array(MAX_VALIDATED_FILE_SIZE_BYTES + 1);
    large[0] = 0xff;
    large[1] = 0xd8;
    large[2] = 0xff;
    expect(detectAllowedUploadType(large)).toBeNull();
  });
});
