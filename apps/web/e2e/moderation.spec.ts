import { test, expect, type Page } from '@playwright/test';

const LANDLORD_EMAIL = process.env.E2E_LANDLORD_EMAIL ?? 'bailleur.demo@kaza.bj';
const LANDLORD_PW = process.env.E2E_LANDLORD_PW ?? 'KazaDemo2026!';
const ADMIN_EMAIL = process.env.E2E_ADMIN_EMAIL ?? 'admin@kaza.bj';
const ADMIN_PW = process.env.E2E_ADMIN_PW ?? 'KazaDemo2026!';

const RESIDENCE_ID = '00000000-0000-0000-0000-000000000102';
const PENDING_TITLE = `KAZA E2E Modération ${Date.now()}`;
const EDITED_TITLE = `${PENDING_TITLE} - Modifiée`;

// JPEG réel 2x2, suffisamment petit pour l'upload E2E et accepté par la
// validation MIME/magic-bytes du bucket residence-photos.
const JPEG_BASE64 =
  '/9j/4AAQSkZJRgABAQAAAQABAAD/2wBDAAUDBAQEAwUEBAQFBQUGBwwIBwcHBw8LCwkMEQ8SEhEPERETFhwXExQaFRERGCEYGh0dHx8fExciJCIeJBweHx7/2wBDAQUFBQcGBw4ICA4eFBEUHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh7/wAARCAACAAIDASIAAhEBAxEB/8QAHwAAAQUBAQEBAQEAAAAAAAAAAAECAwQFBgcICQoL/8QAtRAAAgEDAwIEAwUFBAQAAAF9AQIDAAQRBRIhMUEGE1FhByJxFDKBkaEII0KxwRVS0fAkM2JyggkKFhcYGRolJicoKSo0NTY3ODk6Q0RFRkdISUpTVFVWV1hZWmNkZWZnaGlqc3R1dnd4eXqDhIWGh4iJipKTlJWWl5iZmqKjpKWmp6ipqrKztLW2t7i5usLDxMXGx8jJytLT1NXW19jZ2uHi4+Tl5ufo6erx8vP09fb3+Pn6/9oADAMBAAIRAxEAPwD1WiiivyQ+tP/Z';

async function login(page: Page, email: string, password: string) {
  await page.goto('/login');
  await page.getByLabel('Email').fill(email);
  await page.getByRole('textbox', { name: 'Mot de passe' }).fill(password);
  await page.getByRole('button', { name: 'Se connecter' }).click();
  await expect(page).toHaveURL(/\/explorer/);
}

async function logout(page: Page) {
  await page.evaluate(() => {
    localStorage.clear();
    sessionStorage.clear();
  });
  await page.context().clearCookies();
}

async function searchTitle(page: Page, title: string) {
  await logout(page);
  await page.goto('/explorer');
  const search = page.getByLabel('Rechercher un quartier, une ville…');
  await search.fill(title);
  await expect(page.getByText('Aucun logement ne correspond')).toBeVisible({ timeout: 10_000 });
}

async function expectTitleVisibleInSearch(page: Page, title: string) {
  await logout(page);
  await page.goto('/explorer');
  const search = page.getByLabel('Rechercher un quartier, une ville…');
  await search.fill(title);
  await expect(page.locator('article').filter({ hasText: title })).toBeVisible({ timeout: 15_000 });
}

test.describe('Cycle de modération des résidences', () => {
  test('soumission → refus → resoumission → approbation → édition invalidante', async ({ page }) => {
    let lastResidenceMutationRequest: unknown = null;
    let lastResidenceMutationReturn: unknown = null;
    let lastGetResidenceReturn: unknown = null;

    page.on('console', (message) => {
      if (message.text().includes('[KAZA:RESIDENCE_DIAGNOSTIC]')) {
        console.log(`[KAZA:E2E_BROWSER] ${message.text()}`);
      }
    });

    page.on('request', (request) => {
      const url = request.url();
      const isResidenceMutation =
        url.includes('/rest/v1/residences') &&
        ['PATCH', 'POST', 'PUT'].includes(request.method());
      if (isResidenceMutation) {
        let payload: unknown;
        try {
          payload = request.postDataJSON();
        } catch {
          payload = request.postData();
        }
        lastResidenceMutationRequest = {
          method: request.method(),
          url,
          payload,
        };
        console.log(`[KAZA:E2E_HTTP] RESIDENCE_MUTATION_REQUEST ${JSON.stringify(lastResidenceMutationRequest)}`);
      }
    });

    page.on('response', async (response) => {
      const url = response.url();
      const request = response.request();
      const isResidenceMutation =
        url.includes('/rest/v1/residences') &&
        ['PATCH', 'POST', 'PUT'].includes(request.method());
      const isGetResidence = request.method() === 'POST' && url.includes('/rest/v1/rpc/get_residence');
      if (!isResidenceMutation && !isGetResidence) return;

      try {
        const body = await response.json();
        if (isResidenceMutation) lastResidenceMutationReturn = {
          method: request.method(),
          url,
          status: response.status(),
          body,
        };
        if (isGetResidence) lastGetResidenceReturn = body;
        console.log(
          `[KAZA:E2E_HTTP] ${isResidenceMutation ? 'UPDATE_RETURN' : 'GET_RESIDENCE_RETURN'} status=${response.status()} body=${JSON.stringify(body)}`,
        );
      } catch (error) {
        const fallback = {
          method: request.method(),
          url,
          status: response.status(),
          text: await response.text().catch(() => '<read failed>'),
          error: error instanceof Error ? error.message : String(error),
        };
        if (isResidenceMutation) lastResidenceMutationReturn = fallback;
        if (isGetResidence) lastGetResidenceReturn = fallback;
        console.log(
          `[KAZA:E2E_HTTP] ${isResidenceMutation ? 'UPDATE_RETURN' : 'GET_RESIDENCE_RETURN'} ${JSON.stringify(fallback)}`,
        );
      }
    });
    page.on('console', (message) => {
      if (message.text().includes('[KAZA:RESIDENCE_DIAGNOSTIC]')) {
        console.log(`[KAZA:E2E_BROWSER] ${message.text()}`);
      }
    });
    // 1. Le bailleur prépare une annonce brouillon.
    await login(page, LANDLORD_EMAIL, LANDLORD_PW);
    await page.goto(`/landlord/residences/${RESIDENCE_ID}/edit`);
    await expect(page.getByTestId('moderation-status')).toContainText('Brouillon');

    await page.getByLabel('Titre').fill(PENDING_TITLE);
    const fileInput = page.getByLabel('Ajouter des photos');
    await fileInput.setInputFiles({
      name: 'kaza-e2e.jpg',
      mimeType: 'image/jpeg',
      buffer: Buffer.from(JPEG_BASE64, 'base64'),
    });
    await expect(page.getByRole('button', { name: 'Retirer la photo' }).first()).toBeVisible();

    await page.getByRole('button', { name: 'Enregistrer les modifications' }).click();
    await expect(page).toHaveURL(/\/landlord/);

    // 2. Soumission explicite à la modération.
    await page.goto(`/landlord/residences/${RESIDENCE_ID}/edit`);
    // Vérifier que l'upload a survécu au save et à la navigation : la soumission
    // à la modération doit lire l'état réellement persisté en base.
    try {
      await expect(page.getByRole('button', { name: 'Retirer la photo' }).first()).toBeVisible({ timeout: 10_000 });
    } catch (error) {
      throw new Error(
        `Photo absente après rechargement.
UPDATE request=${JSON.stringify(lastResidenceMutationRequest)}
UPDATE return=${JSON.stringify(lastResidenceMutationReturn)}
GET_RESIDENCE return=${JSON.stringify(lastGetResidenceReturn)}
Original error=${error instanceof Error ? error.message : String(error)}`,
      );
    }
    await page.getByTestId('publish-toggle').click();
    const moderationStatus = page.getByTestId('moderation-status');
    await expect.poll(
      async () => {
        const status = (await moderationStatus.textContent()) ?? '';
        const error = await page.getByTestId('publish-error').textContent().catch(() => null);
        return error ? status + ' | erreur=' + error : status;
      },
      { timeout: 5_000 },
    ).toContain('En attente de modération');
    await searchTitle(page, PENDING_TITLE);

    // 3. L'admin refuse avec un motif obligatoire.
    await login(page, ADMIN_EMAIL, ADMIN_PW);
    await page.goto('/admin');
    const row = page.locator('li').filter({ hasText: PENDING_TITLE }).first();
    await expect(row).toBeVisible({ timeout: 15_000 });

    page.once('dialog', async (dialog) => {
      expect(dialog.type()).toBe('prompt');
      await dialog.accept('Ajoutez une photo plus claire de la façade.');
    });
    await row.getByRole('button', { name: 'Refuser' }).click();

    await expect(page.locator('li').filter({ hasText: PENDING_TITLE })).toHaveCount(0);

    // 4. Après refus, la résidence reste invisible dans la recherche publique.
    await searchTitle(page, PENDING_TITLE);

    // 5. Le bailleur voit le motif puis resoumet sans modifier le dossier.
    await login(page, LANDLORD_EMAIL, LANDLORD_PW);
    await page.goto(`/landlord/residences/${RESIDENCE_ID}/edit`);
    await expect(page.getByTestId('moderation-status')).toContainText('Refusée');
    await expect(page.getByTestId('moderation-status')).toContainText('Ajoutez une photo plus claire de la façade.');

    await page.getByTestId('publish-toggle').click();
    try {
      await expect(page.getByTestId('moderation-status')).toContainText('En attente de modération');
    } catch (error) {
      const detail = await page.getByTestId('publish-error').textContent().catch(() => null);
      throw new Error(`${error instanceof Error ? error.message : String(error)}\nSoumission : ${detail || 'aucune erreur affichée'}`);
    }
    await searchTitle(page, PENDING_TITLE);

    // 6. L'admin approuve. La résidence devient alors réellement publique.
    await login(page, ADMIN_EMAIL, ADMIN_PW);
    await page.goto('/admin');
    const pendingAgain = page.locator('li').filter({ hasText: PENDING_TITLE }).first();
    await expect(pendingAgain).toBeVisible({ timeout: 15_000 });
    await pendingAgain.getByRole('button', { name: 'Approuver' }).click();
    await expect(page.locator('li').filter({ hasText: PENDING_TITLE })).toHaveCount(0);

    await expectTitleVisibleInSearch(page, PENDING_TITLE);

    // 7. Un bailleur modifie le contenu public d'une annonce approuvée.
    // Le correctif DB doit immédiatement casser la publication et remettre
    // la résidence en brouillon, sans qu'un simple save contourne la modération.
    await login(page, LANDLORD_EMAIL, LANDLORD_PW);
    await page.goto(`/landlord/residences/${RESIDENCE_ID}/edit`);
    await expect(page.getByTestId('moderation-status')).toContainText('Approuvée et visible');

    await page.getByLabel('Titre').fill(EDITED_TITLE);
    await page.getByRole('button', { name: 'Enregistrer les modifications' }).click();
    await expect(page).toHaveURL(/\/landlord/);

    await page.goto(`/landlord/residences/${RESIDENCE_ID}/edit`);
    await expect(page.getByTestId('moderation-status')).toContainText('Brouillon');

    // Le nouveau contenu ne doit plus être publiquement découvrable.
    await searchTitle(page, EDITED_TITLE);
  });
});
