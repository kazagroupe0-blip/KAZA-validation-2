import { test, expect, type BrowserContext, type Page } from '@playwright/test';
import {
  buildC1Report,
  captureRealtimeWire,
  openC1Probes,
  probesReady,
  realtimeEnv,
  signInRealUser,
} from './helpers/realtime-wire';

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

    tenant.on('websocket', (ws) => {
      console.log(`[KAZA:WS] opened ${ws.url()}`);
      ws.on('framesent', () => console.log('[KAZA:WS] sent frame'));
      ws.on('framereceived', () => console.log('[KAZA:WS] received frame'));
      ws.on('close', () => console.log('[KAZA:WS] closed'));
      ws.on('socketerror', (error) => console.log(`[KAZA:WS] socketerror ${error}`));
    });
    tenant.on('pageerror', (error) => console.log(`[KAZA:PAGEERROR] ${error.message}`));
    tenant.on('console', (message) => {
      if (message.type() === 'error') console.log(`[KAZA:CONSOLE] ${message.text()}`);
    });

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
      await expect(landlord.getByText(landlordMessage, { exact: true })).toBeVisible();

      // Régression C1 : la réponse doit arriver dans le fil de la conversation
      // (binding postgres_changes du ChatWindow), et pas seulement dans l'aperçu
      // de la liste latérale, alimenté par un autre channel (`conversations-live`).
      await expect(
        tenant.getByTestId('chat-thread').getByText(landlordMessage, { exact: true }),
      ).toBeVisible({ timeout: 15_000 });
    } finally {
      await logout(tenantContext);
      await tenantContext.close();
      await landlordContext.close();
    }
  });
});

// Diagnostic C1 (opt-in : E2E_REALTIME_DIAG=1, base fraîchement réinitialisée).
// Le bailleur envoie la réponse par l'interface, avec sa vraie session : c'est
// l'INSERT réel. Trois sondes Node (session réelle du locataire, clé anon) et la
// capture du fil de la page comparent les chemins ; le rapport est joint au test.
test.describe('Diagnostic Realtime C1 — messagerie', () => {
  test('C1 : INSERT messages reçu par chaque chemin', async ({ browser }, testInfo) => {
    test.skip(process.env.E2E_REALTIME_DIAG !== '1', 'Diagnostic C1 opt-in : E2E_REALTIME_DIAG=1');
    test.skip(testInfo.project.name !== 'chromium', 'Diagnostic exécuté une seule fois (chromium)');
    const env = realtimeEnv();
    if (!env) {
      throw new Error('[KAZA:C1] NEXT_PUBLIC_SUPABASE_URL / NEXT_PUBLIC_SUPABASE_ANON_KEY (ou E2E_SUPABASE_*) requis');
    }

    // Session réelle du locataire (clé anon + mot de passe), jamais service_role.
    const tenantSession = await signInRealUser(env, TENANT_EMAIL, TENANT_PW);
    const tenantContext = await browser.newContext();
    const landlordContext = await browser.newContext();
    const tenant = await tenantContext.newPage();
    const landlord = await landlordContext.newPage();
    const tenantWire = captureRealtimeWire(tenant);
    const probes: ReturnType<typeof openC1Probes> = [];
    const landlordMessage = `C1 diagnostic ${Date.now()}`;

    try {
      await login(tenant, TENANT_EMAIL, TENANT_PW);
      await tenant.goto(`/residences/${CHAT_RESIDENCE_ID}`);
      await expect(tenant.getByTestId('contact-owner')).toBeVisible({ timeout: 15_000 });
      await tenant.getByTestId('contact-owner').click();
      await expect(tenant).toHaveURL(/\/chat\//);
      await expect(tenant.getByTestId('realtime-status')).toHaveAttribute('data-state', 'connected', {
        timeout: 15_000,
      });
      const conversationId = new URL(tenant.url()).pathname.split('/').pop() ?? '';
      expect(conversationId).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/);

      probes.push(...await openC1Probes(env, tenantSession, 'messages', 'INSERT', conversationId));
      // note : on n'échoue pas ici — une sonde non prête rend le verdict « inconclusive ».
      await expect
        .poll(() => probesReady(probes), { timeout: 15_000 })
        .toBe(true)
        .catch(() => undefined);

      // INSERT réel : le bailleur répond par l'interface, avec sa propre session.
      await login(landlord, LANDLORD_EMAIL, LANDLORD_PW);
      await landlord.goto(`/chat/${conversationId}`);
      await expect(landlord.getByLabel('Message')).toBeVisible({ timeout: 15_000 });
      await landlord.getByLabel('Message').fill(landlordMessage);
      await landlord.getByRole('button', { name: 'Envoyer' }).click();
      await expect(landlord.getByTestId('chat-thread').getByText(landlordMessage, { exact: true })).toBeVisible({ timeout: 15_000 });

      const isTarget = (record: Record<string, unknown>) =>
        record.body === landlordMessage && record.conversation_id === conversationId;
      const thread = tenant.getByTestId('chat-thread').getByText(landlordMessage);
      const snapshot = async () =>
        buildC1Report({
          scenario: 'chat: INSERT messages (bailleur → locataire)',
          conversationId,
          table: 'messages',
          type: 'INSERT',
          predicate: isTarget,
          wire: tenantWire,
          probes,
          browserDom: await thread.isVisible(),
        });
      // Fenêtre d'observation : jusqu'à ce que tous les chemins aient reçu, ou 15 s.
      await expect
        .poll(
          async () => {
            const { observation } = await snapshot();
            return (
              observation.browserDom &&
              observation.browserWire &&
              observation.filteredDedicated &&
              observation.unfilteredDedicated &&
              observation.filteredSession
            );
          },
          { timeout: 15_000 },
        )
        .toBe(true)
        .catch(() => undefined);

      const report = await snapshot();
      console.log(`[KAZA:C1] ${JSON.stringify(report)}`);
      await testInfo.attach('c1-chat-diagnostic.json', {
        body: JSON.stringify(report, null, 2),
        contentType: 'application/json',
      });
      expect(report.verdict, `${report.meaning} ${JSON.stringify(report.observation)}`).toBe('no-reproduction');
    } finally {
      await Promise.all(probes.map((probe) => probe.close()));
      await tenantSession.client.auth.signOut().catch(() => undefined);
      await logout(tenantContext);
      await tenantContext.close();
      await landlordContext.close();
    }
  });
});
