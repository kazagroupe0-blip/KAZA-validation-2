import { test, expect, type BrowserContext, type Page } from '@playwright/test';

const TENANT_EMAIL = process.env.E2E_TENANT_EMAIL ?? 'locataire.demo@kaza.bj';
const TENANT_PW = process.env.E2E_TENANT_PW ?? 'KazaDemo2026!';
const LANDLORD_EMAIL = process.env.E2E_LANDLORD_EMAIL ?? 'bailleur.demo@kaza.bj';
const LANDLORD_PW = process.env.E2E_LANDLORD_PW ?? 'KazaDemo2026!';
const CHAT_RESIDENCE_ID = '00000000-0000-0000-0000-000000000103';

async function login(page: Page, email: string, password: string) {
  await page.goto('/login');
  await page.getByLabel('Email').fill(email);
  await page.getByRole('textbox', { name: 'Mot de passe' }).fill(password);
  await page.getByRole('button', { name: 'Se connecter' }).click();
  await expect(page).toHaveURL(/\/explorer/);
}

async function logout(context: BrowserContext) {
  await context.clearCookies();
}

test.describe('Messagerie de bout en bout', () => {
  test('locataire ↔ bailleur : ouverture, envoi et temps réel', async ({ browser }) => {
    const tenantContext = await browser.newContext();
    const landlordContext = await browser.newContext();
    const tenant = await tenantContext.newPage();
    const landlord = await landlordContext.newPage();

    const tenantMessage = `Bonjour depuis E2E ${Date.now()}`;
    const landlordMessage = `Réponse bailleur E2E ${Date.now()}`;

    try {
      // Le locataire ouvre réellement une conversation depuis une annonce publique.
      await login(tenant, TENANT_EMAIL, TENANT_PW);
      await tenant.goto(`/residences/${CHAT_RESIDENCE_ID}`);
      await expect(tenant.getByTestId('contact-owner')).toBeVisible({ timeout: 15_000 });
      await tenant.getByTestId('contact-owner').click();
      await expect(tenant).toHaveURL(/\/chat\//);
      const realtimeStatus = tenant.getByTestId('realtime-status');
      try {
        await expect(realtimeStatus).toHaveAttribute('data-state', 'connected', { timeout: 15_000 });
      } catch (error) {
        const realtimeError = await realtimeStatus.getAttribute('data-error');
        throw new Error(`${error instanceof Error ? error.message : String(error)}\\nRealtime error: ${realtimeError || 'aucun détail'}`);
      }

      // La conversation est ensuite utilisée comme un vrai échange.
      await tenant.getByLabel('Message').fill(tenantMessage);
      await tenant.getByRole('button', { name: 'Envoyer' }).click();
      await expect(tenant.getByText(tenantMessage)).toBeVisible();

      // Le bailleur voit la même conversation via sa propre session.
      await login(landlord, LANDLORD_EMAIL, LANDLORD_PW);
      await landlord.goto('/chat');
      await expect(landlord.getByTestId('conversation-list')).toBeVisible({ timeout: 15_000 });

      const conversation = landlord
        .getByTestId('conversation-list')
        .locator('button')
        .filter({ hasText: tenantMessage });
      await expect(conversation).toBeVisible({ timeout: 15_000 });
      await conversation.click();

      await expect(landlord.getByText(tenantMessage)).toBeVisible({ timeout: 15_000 });

      // Le bailleur répond sans recharger la page du locataire.
      await landlord.getByLabel('Message').fill(landlordMessage);
      await landlord.getByRole('button', { name: 'Envoyer' }).click();
      await expect(landlord.getByText(landlordMessage)).toBeVisible();

      // C'est l'assertion importante : la réponse arrive par Realtime.
      await expect(tenant.getByText(landlordMessage)).toBeVisible({ timeout: 15_000 });
    } finally {
      await logout(tenantContext);
      await tenantContext.close();
      await landlordContext.close();
    }
  });
});
