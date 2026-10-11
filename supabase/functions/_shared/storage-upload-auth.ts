const STORAGE_VALIDATION_HEADER = 'x-storage-validation-secret';

export function isAuthorizedStorageValidationWebhook(
  headers: Headers,
  expectedSecret: string | undefined,
): boolean {
  if (!expectedSecret || expectedSecret.length < 32) {
    return false;
  }

  const suppliedSecret = headers.get(STORAGE_VALIDATION_HEADER);

  if (
    suppliedSecret === null ||
    suppliedSecret.length !== expectedSecret.length
  ) {
    return false;
  }

  let difference = 0;

  for (let index = 0; index < expectedSecret.length; index += 1) {
    difference |=
      expectedSecret.charCodeAt(index) ^ suppliedSecret.charCodeAt(index);
  }

  return difference === 0;
}