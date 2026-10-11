import { describe, it, expect } from 'vitest';
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { supabaseAdmin } from '../../helpers/supabase-test-client';

/**
 * F05 — PRÉPARATION AVANT ACTIVATION (CI jetable uniquement).
 *
 * Crée dans le Storage local un VRAI objet « PDF dans residence-photos », possible uniquement tant
 * que la garde historique est encore liée (la garde F05 refuse ce cas à l'insertion). Il sert ensuite
 * à storage-validation-edge.test.ts pour éprouver la défense en profondeur du validateur Edge APRÈS
 * activation. Le chemin de l'objet est écrit dans le fichier désigné par KAZA_F05_PDF_FIXTURE.
 * Exécuté seulement avec KAZA_F05_PREPARE_FIXTURE=1.
 */
const fixturePath = process.env.KAZA_F05_PDF_FIXTURE;
const enabled = process.env.KAZA_F05_PREPARE_FIXTURE === '1' && !!fixturePath;

const PDF = Uint8Array.from([0x25, 0x50, 0x44, 0x46, 0x2d, ...new Array(36).fill(3)]);

describe.skipIf(!enabled)('F05 legacy fixture preparation (before activation)', () => {
  it('stores a real PDF in residence-photos while the legacy guard is still bound', async () => {
    const name = `legacy-pdf-fixture/${Date.now()}.pdf`;
    // MIME déclaré image/jpeg : seul moyen d'insérer ce contenu sous la garde historique.
    const { error } = await supabaseAdmin.storage
      .from('residence-photos')
      .upload(name, PDF, { contentType: 'image/jpeg', upsert: false });
    expect(error).toBeNull();

    const check = await supabaseAdmin.storage.from('residence-photos').download(name);
    expect(check.error).toBeNull();

    mkdirSync(dirname(fixturePath!), { recursive: true });
    writeFileSync(fixturePath!, JSON.stringify({ bucket: 'residence-photos', name }));
  });
});
