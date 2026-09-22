import { test, expect, type BrowserContext, type Page } from '@playwright/test';

const TENANT_EMAIL = 'visits.tenant.e2e@kaza.test';
const TENANT_PW = 'KazaDemo2026!';
const LANDLORD_EMAIL = 'visits.landlord.e2e@kaza.test';
const LANDLORD_PW = 'KazaDemo2026!';
const VISIT_RESIDENCE_ID = '00000000-0000-0000-0000-000000000104';

async function login(page: Page, email: string, password: string) {
  await page.goto('/login');
  await page.getByLabel('Email').fill(email);
  await page.getByRole('textbox', { name: 'Mot de passe' }).fill(password);
  await page.getByRole('button', { name: 'Se connecter' }).click();
  await expect(page).toHaveURL(/\/explorer/, { timeout: 15_000 });
}

async function logout(context: BrowserContext) {
  await context.clearCookies();
  await context.pages()[0]?.evaluate(() => {
    localStorage.clear();
    sessionStorage.clear();
  }).catch(() => undefined);
}

test.describe('Visites de bout en bout', () => {
  test('locataire propose → bailleur confirme → locataire reçoit la confirmation', async ({ browser }) => {
    const tenantContext = await browser.newContext();
    const landlordContext = await browser.newContext();
    const tenant = await tenantContext.newPage();
    const landlord = await landlordContext.newPage();

    const firstStart = new Date(Date.now() + 24 * 60 * 60 * 1000);
    firstStart.setMinutes(0, 0, 0);
    const firstEnd = new Date(firstStart.getTime() + 60 * 60 * 1000);
    const secondStart = new Date(firstStart.getTime() + 2 * 60 * 60 * 1000);
    const secondEnd = new Date(secondStart.getTime() + 60 * 60 * 1000);

    try {
      // 1. Le locataire ouvre réellement la conversation depuis le bien public.
      await login(tenant, TENANT_EMAIL, TENANT_PW);
      await tenant.goto(`/residences/${VISIT_RESIDENCE_ID}`);
      await expect(tenant.getByTestId('contact-owner')).toBeVisible({ timeout: 15_000 });
      await tenant.getByTestId('contact-owner').click();
      await expect(tenant).toHaveURL(/\/chat\//, { timeout: 15_000 });

      // Le canal temps réel doit être disponible avant l'envoi.
      await expect(tenant.getByTestId('realtime-status')).toHaveAttribute(
        'data-state',
        'connected',
        { timeout: 15_000 },
      );

      await tenant.getByRole('button', { name: 'Proposer une visite' }).click();
      const modal = tenant.getByRole('dialog', { name: 'Proposer une visite' });
      await expect(modal).toBeVisible();

      const dateTimeLocal = (date: Date) => {
        const y = date.getFullYear();
        const m = String(date.getMonth() + 1).padStart(2, '0');
        const d = String(date.getDate()).padStart(2, '0');
        const h = String(date.getHours()).padStart(2, '0');
        const min = String(date.getMinutes()).padStart(2, '0');
        return `${y}-${m}-${d}T${h}:${min}`;
      };

      const allDateInputs = modal.locator('input[type="datetime-local"]');
      await allDateInputs.nth(0).fill(dateTimeLocal(firstStart));
      await allDateInputs.nth(1).fill(dateTimeLocal(firstEnd));

      await modal.getByRole('button', { name: '+ Ajouter un créneau' }).click();
      await allDateInputs.nth(2).fill(dateTimeLocal(secondStart));
      await allDateInputs.nth(3).fill(dateTimeLocal(secondEnd));

      await modal.getByRole('button', { name: 'Proposer' }).click();
      await expect(modal).not.toBeVisible();
      await expect(tenant.getByText('📅 Demande de visite', { exact: true })).toBeVisible({ timeout: 10_000 });
      await expect(tenant.getByText('Visite proposée')).toBeVisible();

      // 2. Le bailleur retrouve cette même conversation dans sa propre session.
      await login(landlord, LANDLORD_EMAIL, LANDLORD_PW);
      await landlord.goto('/chat');
      await expect(landlord.getByTestId('conversation-list')).toBeVisible({ timeout: 15_000 });

      const conversation = landlord
        .getByTestId('conversation-list')
        .locator('button')
        .filter({ hasText: 'Studio Visites E2E Haie Vive' })
        .first();
      await expect(conversation).toBeVisible({ timeout: 15_000 });
      await conversation.click();
      await expect(landlord).toHaveURL(/\/chat\//, { timeout: 15_000 });

      // Le workflow doit afficher les vraies lignes visits, pas un simple bouton générique.
      const proposals = landlord.getByTestId('visit-proposals');
      await expect(proposals).toBeVisible({ timeout: 15_000 });
      await expect(proposals.getByText(/Proposé par le locataire/).first()).toBeVisible();

      // 3. Le bailleur confirme précisément un créneau existant.
      await proposals.getByRole('button', { name: 'Confirmer' }).first().click();

      // La confirmation doit disparaître côté bailleur parce que les autres alternatives
      // du même dossier sont clôturées par la transaction DB.
      await expect(proposals).not.toBeVisible({ timeout: 10_000 });
      await expect(landlord.getByTestId('visit-confirmed-message')).toBeVisible({ timeout: 10_000 });

      // 4. La confirmation doit parvenir au locataire sans rechargement.
      await expect(tenant.getByTestId('visit-confirmed-message')).toBeVisible({ timeout: 15_000 });

      // 5. La notification métier doit également être présente.
      const bell = tenant.getByRole('button', { name: /^Notifications(?: \(\d+ non lues\))?$/i });
      await expect(bell).toBeVisible();
      await bell.click();
      const notificationPanel = tenant.getByRole('region', { name: 'Notifications' });
      await expect(notificationPanel.getByText('Visite confirmée', { exact: true })).toBeVisible({
        timeout: 10_000,
      });
    } finally {
      await logout(tenantContext);
      await tenantContext.close();
      await landlordContext.close();
    }
  });
});
