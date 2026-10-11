import { describe, expect, it } from 'vitest';
import { isAuthorizedStorageValidationWebhook } from '../supabase/functions/_shared/storage-upload-auth';

const validSecret = '0123456789abcdef0123456789abcdef';

describe('Storage validation webhook authentication', () => {
  it('accepts the exact configured secret', () => {
    const headers = new Headers({
      'x-storage-validation-secret': validSecret,
    });

    expect(
      isAuthorizedStorageValidationWebhook(headers, validSecret),
    ).toBe(true);
  });

  it('rejects a missing header', () => {
    expect(
      isAuthorizedStorageValidationWebhook(new Headers(), validSecret),
    ).toBe(false);
  });

  it('rejects an incorrect secret', () => {
    const headers = new Headers({
      'x-storage-validation-secret': 'xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx',
    });

    expect(
      isAuthorizedStorageValidationWebhook(headers, validSecret),
    ).toBe(false);
  });

  it('fails closed when the secret is not configured', () => {
    const headers = new Headers({
      'x-storage-validation-secret': validSecret,
    });

    expect(
      isAuthorizedStorageValidationWebhook(headers, undefined),
    ).toBe(false);
  });

  it('rejects a configured secret that is too short', () => {
    const headers = new Headers({
      'x-storage-validation-secret': 'short',
    });

    expect(
      isAuthorizedStorageValidationWebhook(headers, 'short'),
    ).toBe(false);
  });

  it('rejects a secret with an appended suffix', () => {
    const headers = new Headers({
      'x-storage-validation-secret': `${validSecret}-extra`,
    });

    expect(
      isAuthorizedStorageValidationWebhook(headers, validSecret),
    ).toBe(false);
  });
});