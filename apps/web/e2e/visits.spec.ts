import { test, expect, type BrowserContext, type Page } from '@playwright/test';
import {
  buildC1Report,
  captureRealtimeWire,
  openC1Probes,
  probesReady,
  realtimeEnv,
  signInRealUser,
} from './helpers/realtime-wire';

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
    const tenantWire = captureRealtimeWire(tenant);

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

      // Régression C1 : le channel du chat doit souscrire ses deux bindings
      // (UPDATE visits, INSERT messages) avec l'UUID réel de la conversation.
      const conversationId = new URL(tenant.url()).pathname.split('/').pop() ?? '';
      expect(conversationId).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/);
      const expectedFilter = `conversation_id=eq.${conversationId}`;
      await expect
        .poll(
          () => tenantWire.joins.find((join) => join.topic === `realtime:messages:${conversationId}`)?.filters ?? [],
          { timeout: 10_000 },
        )
        .toEqual([expectedFilter, expectedFilter]);

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

      // Vérifier la persistance côté bailleur indépendamment du rendu React transitoire.
      await landlord.reload();
      await expect(landlord.getByTestId('visit-confirmed-message')).toBeVisible({ timeout: 15_000 });

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

      // 6. Aucune souscription Realtime du locataire n'a été rejetée pendant le parcours
      // (un rejet arrive par un événement `system`, après SUBSCRIBED).
      expect(tenantWire.systemErrors).toEqual([]);
    } finally {
      await logout(tenantContext);
      await tenantContext.close();
      await landlordContext.close();
    }
  });
});

function dateTimeLocalValue(date: Date): string {
  const y = date.getFullYear();
  const m = String(date.getMonth() + 1).padStart(2, '0');
  const d = String(date.getDate()).padStart(2, '0');
  const h = String(date.getHours()).padStart(2, '0');
  const min = String(date.getMinutes()).padStart(2, '0');
  return `${y}-${m}-${d}T${h}:${min}`;
}

// Diagnostic C1 (opt-in : E2E_REALTIME_DIAG=1, base fraîchement réinitialisée,
// à lancer seul : `--grep "Diagnostic Realtime C1"`). Le bailleur confirme par
// l'interface, avec sa vraie session : c'est l'UPDATE réel de `visits`. Trois
// sondes Node (session réelle du locataire, clé anon) et la capture du fil de
// la page comparent les chemins ; le rapport est joint au test.
test.describe('Diagnostic Realtime C1 — visites', () => {
  test('C1 : UPDATE visits (confirmed) reçu par chaque chemin', async ({ browser }, testInfo) => {
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
    const probes: Awaited<ReturnType<typeof openC1Probes>> = [];

    const start = new Date(Date.now() + 3 * 24 * 60 * 60 * 1000);
    start.setMinutes(0, 0, 0);
    const end = new Date(start.getTime() + 60 * 60 * 1000);

    try {
      await login(tenant, TENANT_EMAIL, TENANT_PW);
      await tenant.goto(`/residences/${VISIT_RESIDENCE_ID}`);
      await expect(tenant.getByTestId('contact-owner')).toBeVisible({ timeout: 15_000 });
      await tenant.getByTestId('contact-owner').click();
      await expect(tenant).toHaveURL(/\/chat\//, { timeout: 15_000 });
      await expect(tenant.getByTestId('realtime-status')).toHaveAttribute('data-state', 'connected', {
        timeout: 15_000,
      });
      const conversationId = new URL(tenant.url()).pathname.split('/').pop() ?? '';
      expect(conversationId).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/);

      probes.push(...await openC1Probes(env, tenantSession, 'visits', 'UPDATE', conversationId));
      // note : on n'échoue pas ici — une sonde non prête rend le verdict « inconclusive ».
      await expect
        .poll(() => probesReady(probes), { timeout: 15_000 })
        .toBe(true)
        .catch(() => undefined);

      // Le locataire propose un créneau par l'interface (ligne visits à confirmer).
      await tenant.getByRole('button', { name: 'Proposer une visite' }).click();
      const modal = tenant.getByRole('dialog', { name: 'Proposer une visite' });
      await expect(modal).toBeVisible();
      const dateInputs = modal.locator('input[type="datetime-local"]');
      await dateInputs.nth(0).fill(dateTimeLocalValue(start));
      await dateInputs.nth(1).fill(dateTimeLocalValue(end));
      await modal.getByRole('button', { name: 'Proposer' }).click();
      await expect(modal).not.toBeVisible();

      // UPDATE réel : le bailleur confirme par l'interface, avec sa propre session.
      await login(landlord, LANDLORD_EMAIL, LANDLORD_PW);
      await landlord.goto(`/chat/${conversationId}`);
      const proposals = landlord.getByTestId('visit-proposals');
      await expect(proposals).toBeVisible({ timeout: 15_000 });
      await proposals.getByRole('button', { name: 'Confirmer' }).first().click();
      await expect(proposals).not.toBeVisible({ timeout: 10_000 });

      const isTarget = (record: Record<string, unknown>) =>
        record.conversation_id === conversationId && record.status === 'confirmed';
      const confirmed = tenant.getByTestId('visit-confirmed-message');
      const snapshot = async () =>
        buildC1Report({
          scenario: 'visits: UPDATE visits status=confirmed (bailleur → locataire)',
          conversationId,
          table: 'visits',
          type: 'UPDATE',
          predicate: isTarget,
          wire: tenantWire,
          probes,
          browserDom: await confirmed.isVisible(),
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
      await testInfo.attach('c1-visits-diagnostic.json', {
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
