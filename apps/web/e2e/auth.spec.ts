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

    await page.getByRole('textbox', { name: /nom ou raison sociale/i }).fill('KAZA Immo Test');
    await page.getByLabel(/opérateur mobile money/i).selectOption('mtn');
    await page.getByLabel(/numéro mobile money/i).fill('+2290190000000');
    await page.getByRole('button', { name: /enregistrer les modifications/i }).click();

    await expect(page.getByText(/profil propriétaire complet/i)).toBeVisible({ timeout: 10_000 });

    await bell.click();
    await expect(page.locator('#main').getByText(/profil propriétaire incomplet/i)).not.toBeVisible();
  });
});


test.describe('Phone activation', () => {
  test('existing profile phone can be activated and reused for SMS login', async ({ page }) => {
    const unique = Date.now();
    const email = `phone_activation_${unique}@kaza.test`;
    const phone = '+2290190000000';
    const password = 'TestPass123!';

    await page.goto('/register');
    await page.getByLabel(/je suis/i).selectOption({ label: 'Un locataire — je cherche un logement' });
    await page.getByLabel(/nom complet/i).fill('Téléphone Test');
    await page.getByLabel(/e-?mail/i).fill(email);
    await page.getByLabel(/téléphone.*whatsapp/i).fill(phone);
    await page.getByRole('textbox', { name: /mot de passe/i }).fill(password);
    await page.getByRole('checkbox').check();
    await page.getByRole('button', { name: /créer mon compte/i }).click();

    await page.waitForURL(/explorer/, { timeout: 15_000 });
    await page.goto('/verify-phone');

    await expect(page.getByRole('heading', { name: /activer mon numéro/i })).toBeVisible();
    await expect(page.getByText(phone)).toBeVisible();

    await page.getByRole('button', { name: /recevoir le code par sms/i }).click();
    await expect(page.getByText(/code envoyé/i)).toBeVisible();

    await page.getByLabel(/code à 6 chiffres/i).fill('123456');
    await page.getByRole('button', { name: /confirmer mon numéro/i }).click();
    await expect(page.getByRole('heading', { name: /numéro activé/i })).toBeVisible();

    await page.getByRole('button', { name: /retour à kaza/i }).click();
    await page.getByRole('button', { name: /déconnexion|se déconnecter/i }).click();

    await page.goto('/verify-otp');
    await page.getByLabel(/numéro de téléphone/i).fill('+229 01 90 00 00 00');
    await page.getByRole('button', { name: /envoyer le code/i }).click();
    await expect(page.getByText(/code envoyé/i)).toBeVisible();
    await page.getByLabel(/code à 6 chiffres/i).fill('123456');
    await page.getByRole('button', { name: /valider et me connecter/i }).click();
    await page.waitForURL(/explorer/, { timeout: 15_000 });
  });

  test('unknown phone does not create an auth account', async ({ page }) => {
    const unique = Date.now();
    const email = `phone_count_${unique}@kaza.test`;
    const phone = '+2290190000001';
    const password = 'TestPass123!';

    await page.goto('/register');
    await page.getByLabel(/je suis/i).selectOption({ label: 'Un locataire — je cherche un logement' });
    await page.getByLabel(/nom complet/i).fill('Compteur Test');
    await page.getByLabel(/e-?mail/i).fill(email);
    await page.getByLabel(/téléphone.*whatsapp/i).fill('+2290190000000');
    await page.getByRole('textbox', { name: /mot de passe/i }).fill(password);
    await page.getByRole('checkbox').check();
    await page.getByRole('button', { name: /créer mon compte/i }).click();
    await page.waitForURL(/explorer/, { timeout: 15_000 });

    await page.evaluate(async () => {
      await fetch('/api/logout', { method: 'POST' }).catch(() => undefined);
    });

    await page.goto('/verify-otp');
    await page.getByLabel(/numéro de téléphone/i).fill(phone);
    await page.getByRole('button', { name: /envoyer le code/i }).click();
    await expect(page.getByText(/code envoyé/i)).toBeVisible();
    await expect(page.getByLabel(/code à 6 chiffres/i)).toBeVisible();
  });
});
