import { test, expect } from '@playwright/test';

test.describe('Auth flow', () => {
  test('register form renders with all fields', async ({ page }) => {
    await page.goto('/register');
    await expect(page.getByLabel(/nom complet/i)).toBeVisible();
    await expect(page.getByLabel(/e-?mail/i)).toBeVisible();
    await expect(page.getByRole('textbox', { name: /mot de passe/i })).toBeVisible();
    await expect(page.getByLabel(/je suis/i)).toBeVisible();
    await expect(page.getByRole('combobox', { name: /je suis/i })).toBeVisible();
    await expect(page.getByRole('checkbox')).toBeVisible();
  });

  test('register requires consent checkbox', async ({ page }) => {
    await page.goto('/register');
    await page.getByLabel(/nom complet/i).fill('Test User');
    await page.getByLabel(/e-?mail/i).fill('test@example.com');
    await page.getByRole('textbox', { name: /mot de passe/i }).fill('TestPass123!');
    await page.getByLabel(/je suis/i).selectOption({ label: 'Un locataire — je cherche un logement' });
    await page.getByRole('button', { name: /créer mon compte/i }).click();
    await expect(page.getByText(/consentement/i)).toBeVisible();
  });

  test('login page renders with email and password', async ({ page }) => {
    await page.goto('/login');
    await expect(page.getByLabel(/e-?mail/i)).toBeVisible();
    await expect(page.getByRole('textbox', { name: /mot de passe/i })).toBeVisible();
    await expect(page.getByRole('button', { name: /se connecter/i })).toBeVisible();
  });

  test('login shows error on bad credentials', async ({ page }) => {
    await page.goto('/login');
    await page.getByLabel(/e-?mail/i).fill('nonexistent@example.com');
    await page.getByRole('textbox', { name: /mot de passe/i }).fill('WrongPass123!');
    await page.getByRole('button', { name: /se connecter/i }).click();
    await expect(page.getByText(/identifiants invalides/i)).toBeVisible();
  });

  test('unauthenticated user is redirected to login for protected pages', async ({ page }) => {
    await page.goto('/dashboard');
    await expect(page).toHaveURL(/login/);
  });
});

test.describe('Residences', () => {
  test('home page shows search and residence cards', async ({ page }) => {
    await page.goto('/');
    await expect(page.getByPlaceholder(/quartier, ville/i)).toBeVisible();
  });

  test('residence detail page loads', async ({ page }) => {
    await page.goto('/explorer');
    const demoResidence = page.getByRole('link', {
      name: /Studio Lumineux Fidjrossè/i,
    });
    await expect(demoResidence).toBeVisible({ timeout: 15_000 });
    await demoResidence.click();
    await expect(page).toHaveURL(/residences\//);
  });
});

test.describe('Static pages', () => {
  test('confidentialite page is accessible', async ({ page }) => {
    await page.goto('/confidentialite');
    await expect(page.getByRole('heading', { name: /politique de confidentialité/i })).toBeVisible();
    await expect(page.getByText(/loi APDP/i)).toBeVisible();
  });
});

test.describe('Landlord profile completion', () => {
  test('new landlord can complete profile and the warning disappears', async ({ page }) => {
    const unique = Date.now();
    const email = `landlord_${unique}@kaza.test`;

    await page.goto('/register');
    await page.getByLabel(/je suis/i).selectOption({ label: 'Un bailleur — je loue des biens' });
    await page.getByLabel(/nom complet/i).fill('Propriétaire Test');
    await page.getByLabel(/e-?mail/i).fill(email);
    await page.getByLabel(/téléphone.*whatsapp/i).fill('01 90 00 00 00');
    await page.getByRole('textbox', { name: /mot de passe/i }).fill('TestPass123!');
    await page.getByRole('checkbox').check();
    await page.getByRole('button', { name: /créer mon compte/i }).click();

    await page.waitForURL(/explorer/, { timeout: 15_000 });
    await page.goto('/profile');

    await expect(page.locator('#main').getByText(/profil propriétaire incomplet/i)).toBeVisible();
    await expect(page.getByLabel(/numéro mobile money/i)).toBeVisible();

    const bell = page.getByRole('button', { name: /^Notifications(?: \(\d+ non lues\))?$/i });
    await expect(bell).toBeVisible();
    await bell.click();
    const notificationPanel = page.getByRole('region', { name: 'Notifications' });
    await expect(notificationPanel.getByText(/profil propriétaire incomplet/i)).toBeVisible();

    page.on('request', (request) => {
      if (request.url().includes('/rest/v1/profiles') && request.method() !== 'GET') {
        console.log('DIAG profile-request', request.method(), request.url(), request.postData() ?? '');
      }
    });
    page.on('response', async (response) => {
      if (response.url().includes('/rest/v1/profiles')) {
        console.log('DIAG profile-response', response.status(), response.url());
        try { console.log('DIAG profile-response-body', await response.text()); } catch {}
      }
    });
    console.log('DIAG before-save', {
      businessName: await page.getByRole('textbox', { name: /nom ou raison sociale/i }).inputValue(),
      momoProvider: await page.getByRole('combobox', { name: /opérateur mobile money/i }).inputValue(),
      momoNumber: await page.getByRole('textbox', { name: /numéro mobile money/i }).inputValue(),
    });
    await page.getByRole('textbox', { name: /nom ou raison sociale/i }).fill('KAZA Immo Test');
    await page.getByLabel(/opérateur mobile money/i).selectOption('mtn');
    await page.getByLabel(/numéro mobile money/i).fill('+2290190000000');
    await page.getByRole('button', { name: /enregistrer les modifications/i }).click();
    await page.waitForTimeout(1000);
    console.log('DIAG after-save', {
      businessName: await page.getByRole('textbox', { name: /nom ou raison sociale/i }).inputValue(),
      momoProvider: await page.getByRole('combobox', { name: /opérateur mobile money/i }).inputValue(),
      momoNumber: await page.getByRole('textbox', { name: /numéro mobile money/i }).inputValue(),
      completionVisible: await page.getByText(/profil propriétaire complet/i).isVisible().catch(() => false),
      incompleteVisible: await page.getByText(/profil propriétaire incomplet/i).isVisible().catch(() => false),
    });

    await expect(page.getByText(/profil propriétaire complet/i)).toBeVisible({ timeout: 10_000 });

    await bell.click();
    await expect(page.locator('#main').getByText(/profil propriétaire incomplet/i)).not.toBeVisible();
  });
});
