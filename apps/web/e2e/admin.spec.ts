import { test, expect, type Page } from '@playwright/test';

const ADMIN_EMAIL = process.env.E2E_ADMIN_EMAIL ?? 'admin@kaza.bj';
const ADMIN_PW = process.env.E2E_ADMIN_PW ?? 'KazaDemo2026!';

async function login(page: Page) {
  await page.goto('/login');
  await page.getByLabel('Email').fill(ADMIN_EMAIL);
  await page.getByRole('textbox', { name: 'Mot de passe' }).fill(ADMIN_PW);
  await page.getByRole('button', { name: 'Se connecter' }).click();
  await expect(page).toHaveURL(/\/explorer/);
}

test.describe('Console administration', () => {
  test('admin peut charger la console, filtrer et consulter le journal', async ({ page }) => {
    await login(page);
    await page.goto('/admin');

    await expect(page.getByRole('heading', { name: 'Administration' })).toBeVisible();
    await expect(page.getByRole('heading', { name: 'Utilisateurs' })).toBeVisible();
    await expect(page.getByRole('heading', { name: 'Biens récents' })).toBeVisible();
    await expect(page.getByRole('heading', { name: 'Journal d’administration' })).toBeVisible();

    await page.getByLabel('Filtrer par rôle').selectOption('bailleur');
    await page.getByLabel('Rechercher un utilisateur').fill('bailleur');
    await expect(page.getByText(/résultat\(s\) sur/)).toBeVisible();

    await page.getByLabel('Filtrer le statut de modération').selectOption('pending');
    await expect(page.getByRole('heading', { name: /File de modération/ })).toBeVisible();
  });

  test('un non-admin n’accède pas à la console', async ({ page }) => {
    const tenantEmail = process.env.E2E_TENANT_EMAIL ?? 'locataire.demo@kaza.bj';
    const tenantPw = process.env.E2E_TENANT_PW ?? 'KazaDemo2026!';

    await page.goto('/login');
    await page.getByLabel('Email').fill(tenantEmail);
    await page.getByRole('textbox', { name: 'Mot de passe' }).fill(tenantPw);
    await page.getByRole('button', { name: 'Se connecter' }).click();
    await expect(page).toHaveURL(/\/explorer/);

    await page.goto('/admin');
    await expect(page.getByText('Accès réservé à l’administration.')).toBeVisible();
  });
});
