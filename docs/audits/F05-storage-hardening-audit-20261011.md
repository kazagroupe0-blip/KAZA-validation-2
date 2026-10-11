# KAZA F05 — Audit et durcissement du Storage (rapport mis à jour, 2026-10-11)

Branche : `security/F05-storage-hardening-20261010` (HEAD `7b9dbcde`). Aucun commit, push, merge, déploiement ni accès distant. Travail local antérieur préservé (vérifié via `git status`).

## 1. Résumé exécutif — statut : **BLOCKED**

Le code et l'architecture d'activation sont prêts, les tests exécutables passent, **mais aucun SQL n'a été exécuté** : Docker Desktop ne peut pas démarrer (virtualisation absente, voir §6) et aucun PostgreSQL natif n'existe sur la machine. Donc ne sont **pas prouvés** : la migration phase 1, le script d'activation, les politiques RLS, les états pending/validated/rejected, les reprises, l'isolation inter-tenant. Ces points restent BLOCKED tant qu'un Postgres/Supabase local n'a pas exécuté la migration, l'activation et `tests/integration`.

Évolution depuis le premier passage : la migration unique (qui échouait volontairement sans Vault, donc cassait `supabase db reset`) est scindée en deux phases.

## 2. Architecture migration / activation (point B)

**Phase 1 — `supabase/migrations/20261010175125_harden_storage_upload_validation.sql`** (rejouée par `db reset`/CI) : schéma `private`, table `storage_upload_validations` (+RLS), fonctions `private.storage_validation_target()`, `storage_upload_validation_allows_read()`, `dispatch_storage_validation_webhook()`, `retry_stale_storage_validations()`, garde **nouvelle** `public._guard_storage_upload_f05()`, durcissement du `search_path` de `_allowed_upload_mime` (mêmes valeurs). Elle ne crée **aucun trigger, aucun cron, aucune politique** et ne lit pas Vault à l'exécution : rien de dépendant de l'environnement. Les triggers `guard_storage_upload` (ancienne garde), `protect_objects_delete`, `update_objects_updated_at`, le webhook legacy et les politiques de lecture sont inchangés → aucun affaiblissement ni nouvel upload illisible.

**Phase 2 — `supabase/activation/` (hors `migrations/`, jamais rejouée automatiquement)**
- `f05_activate_storage_validation.sql` : une transaction ; `target_env` (`production`|`test`|`local-test`) et `expected_ref` fournis par l'opérateur doivent correspondre (production = `qbogbuwnkwqgarbchtyr`, test = `bzvlnefowgtuasqjfpem`, le ref de test est donc refusé en production) ; vérifie fonctions/table de la phase 1, `pg_cron`, `net.http_post`, buckets, les 3 noms Vault, la forme de l'URL, URL-ref = ref Vault = ref affirmé ; avertit si `protect_objects_delete` est absent ; puis rebinde la garde, remplace le webhook legacy par le webhook dédié, planifie la reprise cron, remplace les 2 politiques de lecture. Toute vérification qui échoue annule la transaction.
- `preflight-edge.sh` : sonde la fonction Edge (401 du handler sans secret / avec mauvais secret ; 400 `invalid webhook event` avec le bon secret, sans toucher aux données). Secrets lus en variables d'environnement, jamais affichés.
- `f05_post_activation_checks.sql` (lecture seule) et `f05_rollback_storage_validation.sql` (restaure garde et politiques d'origine, retire webhook dédié et cron ; ne recrée **pas** le webhook legacy).

Limite assumée : le SQL ne peut pas connaître son propre project ref ; le ref est une double saisie (opérateur + Vault) croisée avec l'URL, pas une auto-détection. Les fichiers `supabase/activation/*.sql` n'ont **jamais été exécutés**.

## 3. Faits vérifiés / hypothèses

**Vérifiés par lecture du code** : l'ancienne migration codait l'URL de test dans dispatch/retry ; `getAdminClient()` n'avait plus de repli `SUPABASE_SERVICE_ROLE_KEY` (11 fonctions concernées) ; l'ancien handler pouvait écraser un état `rejected` ; PDF accepté dans `residence-photos` ; mobile : `contentType` JPEG codé en dur ; aucune politique UPDATE/DELETE pour `authenticated` sur `storage.objects` dans les migrations ; `protect_objects_delete` n'est défini dans **aucune** migration du dépôt ; `edit.tsx` mobile : un seul `throw new Error(...)` pour la validation de photo (ligne 112), compile (typecheck mobile OK).

**Hypothèses non vérifiées** : `metadata.mimetype`/`size` présents au `BEFORE INSERT` ; signatures `net.http_post` et `vault.decrypted_secrets` identiques sur les deux projets ; un upload `upsert:true` remet l'état à pending sans déclencher le webhook (récupération par cron, ~5 min) ; l'état distant de la mission (section 2 de la mission) est repris tel que fourni, non revérifié.

## 4. Matrice des risques

| # | Gravité | Constat / preuve | Décision |
|---|---|---|---|
| 1 | P0 | URL du projet de test codée en dur dans la migration (ancien code, dispatch/retry) | **Corrigé** : cible lue dans Vault, validée (forme + ref). Aucun ref dans la migration (test statique). |
| 2 | P0 | Jeton privilégié en clair dans le trigger legacy du projet de test (fourni) | **Non traité à distance**. Remplacement par l'activation ; confinement/rotation : §8. |
| 3 | P0 | Admin client sans repli | **Corrigé** (`_shared/admin-key.ts`, 7 tests unitaires). |
| 4 | P1 | États terminaux écrasables par upsert | **Corrigé** (`UPDATE … WHERE status='pending'`, lecture d'état, 409/503). Handler jamais exécuté (vérifié par `deno check` et tests textuels seulement). |
| 5 | P1 | Pas de règle MIME par bucket | **Corrigé** (handler testé en unitaire ; garde SQL non exécutée). |
| 6 | P1 | Migration cassait `db reset` / installait un trigger sans prérequis | **Corrigé** par la scission en deux phases (non vérifié par un vrai `db reset`). |
| 7 | P1 | Format mobile non prouvé | **Corrigé** (détection par octets, `apps/mobile/lib/storage-upload.ts`) ; non testé sur appareil. |
| 8 | P1 | Fenêtre de régression à la bascule | **Mitigé** : slug `validate-file-upload-v2` + remplacement atomique du trigger ; procédure §9. |
| 9 | P1 | `protect_objects_delete` absent du dépôt | **Non vérifié** : suppression d'un fichier rejeté non prouvée (l'état `rejected` est persisté avant la suppression, lecture bloquée). |
| 10 | P2 | Objet rejeté non supprimé après 5 tentatives | Accepté, revue manuelle. |
| 11 | P2 | Objets historiques sans ligne d'état restent lisibles | Décision explicite : backfill avant retrait de l'exception. |
| 12 | P2 | `last_error` jamais alimenté par le handler | Non traité. |

Contrat de taille : web 8 Mio (client) < serveur 20 Mio ; conservé, cohérent. Chat : politique à chemin exact + expéditeur = 1er dossier + appartenance à la conversation (non exécutée).

## 5. Fichiers

Préexistants (préservés) : écrans/composants clients web et mobile, `config.toml`, `validate-file-upload/index.ts`, helper et test d'auth. Modifiés/ajoutés par moi : migration phase 1 ; `supabase/activation/{f05_activate_storage_validation.sql, f05_rollback_storage_validation.sql, f05_post_activation_checks.sql, preflight-edge.sh}` ; `_shared/{db.ts, admin-key.ts, file-validation.ts}` ; `validate-file-upload/index.ts` ; `validate-file-upload-v2/index.ts` ; `config.toml` (entrée v2) ; `packages/shared/src/utils/{image-format.ts, index.ts}` ; `apps/mobile/lib/storage-upload.ts`, `edit.tsx`, `chat/[id].tsx` ; tests `tests/{admin-key, storage-upload-contract}.test.ts` et `tests/integration/security/storage-upload-validation.test.ts` ; ce rapport.

## 6. Tests réellement exécutés

| Commande | Résultat | Code |
|---|---|---|
| `npx vitest run` | 16 fichiers, 154 tests OK | 0 |
| `deno lint` + `deno check --config deno.json` sur chaque `supabase/functions/*/index.ts` | **10 fonctions** (dernière passe ; la première passe, avant création de `-v2`, en vérifiait 9), aucun échec | 0 |
| `npm run typecheck` (web) | OK | 0 |
| `npm run typecheck:mobile` | OK | 0 |
| `npm run lint` (web) | 0 erreur, avertissements anciens (`exhaustive-deps`, `<img>`) | 0 |
| `git diff --check` | propre (avertissements LF/CRLF seulement) | 0 |
| `vitest -c vitest.config.integration.ts` sur le nouveau fichier | 6 tests **ignorés** (skip, `KAZA_F05_ACTIVATED` ≠ 1) | 0 |
| `prettier --check` (2 composants web) | échec, déjà non formatés sur HEAD | 1 |
| ESLint mobile | non exécutable (aucune config) | 2 |

Les « tests de migration/activation » de `storage-upload-contract.test.ts` sont des **contrôles textuels** (regex sur les fichiers SQL), pas des tests SQL exécutés.

**Non exécutés (BLOCKED)** : migration phase 1, `supabase db reset`, script d'activation, rollback, `tests/integration` existants et le nouveau (écrit sans pouvoir être lancé, à valider à la première exécution), tests de reprise/suppression/orphelins, URLs signées inter-utilisateurs, tests UI web/mobile (aucun test existant), lint SQL.

**Blocage Docker (diagnostic, rien de modifié)** : `docker info` → « Docker Desktop is unable to start » ; `wsl --status` n'indique que la version par défaut 2 ; hyperviseur Windows absent (`HypervisorPresent = False`) ; journal Docker Desktop : `hasNoVirtualization: true`. Docker Desktop a été lancé (non destructif), service `com.docker.service` arrêté. Corriger demande le BIOS/fonctionnalités Windows : hors périmètre autorisé. Aucun PostgreSQL local (`psql`, `pg_ctl`, `postgres` absents).

## 7. Régression par domaine

Stockage : phase 1 sans effet sur les uploads existants ; la phase 2 durcit (MIME vide refusé, PDF refusé pour photos). Chat : lecture par chemin exact après activation ; anciens messages inchangés avant. Photos : web attend déjà la validation, mobile édition aussi désormais. Auth admin : repli conservé. Paiements/reçus : non touchés. Suppressions Storage : triggers non modifiés, comportement non prouvé (#9).

## 8. Jeton privilégié de l'ancien trigger de test

Valeur non reproduite ni lue. Il est stocké en clair dans les arguments de `kaza-storage-content-validation` (visible de tout rôle pouvant lire `pg_trigger`, sauvegardes, outils d'introspection, journaux). Procédure (à valider manuellement) : (1) **inventorier les consommateurs** de cette clé (fonctions Edge, CI, scripts, intégrations) avant toute révocation, sans supposer qu'on peut la désactiver immédiatement ; (2) retirer le stockage en clair en appliquant la phase 2 sur le projet de test (le trigger est remplacé, la nouvelle définition ne contient aucun jeton) puis vérifier avec `f05_post_activation_checks.sql` qu'aucune définition de trigger ne porte de jeton ; (3) planifier la rotation de la clé après migration de ses consommateurs ; (4) revoir les sauvegardes/dumps/logs ayant pu contenir la définition. Rotation non effectuée ici.

## 9. Procédures

**Local (une fois Docker/WSL réparé)** : `supabase start` → `supabase db reset` (phase 1 seule) → insérer des entrées Vault jetables locales (ref fictif `localtestrefaaaaaaaa`, jamais committées) → appliquer l'activation avec `-v target_env=local-test -v expected_ref=localtestrefaaaaaaaa` → `KAZA_F05_ACTIVATED=1 npx vitest run -c vitest.config.integration.ts tests/integration/security/storage-upload-validation.test.ts` + suite d'intégration existante → rollback → réactivation.

**Projet de test (non exécuté)** : 1) créer les 3 entrées Vault et le secret Edge `STORAGE_VALIDATION_WEBHOOK_SECRET` (identique à Vault, propre au projet) ; 2) déployer `validate-file-upload-v2` (`--no-verify-jwt`), l'ancien slug et le trigger legacy restent opérationnels ; 3) `preflight-edge.sh` doit tout valider ; 4) migration phase 1 ; 5) activation `-v target_env=test -v expected_ref=bzvlnefowgtuasqjfpem` (remplacement atomique du trigger) ; 6) post-checks + essais : JPEG valide → validated + URL signée ; PNG déclaré JPEG → rejeté et supprimé ; PDF dans `residence-photos` → refusé ; fichier d'un autre utilisateur → refusé ; reprise d'un pending ; 7) plus tard : retirer l'ancien slug, traiter le jeton (§8).
**Production** : aucun legacy ; même séquence avec `target_env=production`, ref `qbogbuwnkwqgarbchtyr` ; backfill des objets historiques avant de retirer l'exception « sans ligne d'état ».
**Rollback** : `f05_rollback_storage_validation.sql`, puis traiter la liste des objets non validés listée à sa fin.

## 10. Paramètres par projet (sans valeur)

Vault : `kaza_storage_validation_webhook_secret` (≥ 32 car., distinct par projet), `kaza_storage_validation_function_url`, `kaza_storage_validation_expected_project_ref`. Secret Edge : `STORAGE_VALIDATION_WEBHOOK_SECRET`. Clé admin : `SUPABASE_SECRET_KEYS` (ou `SUPABASE_SERVICE_ROLE_KEY`). Extensions : `pg_cron`, `pg_net`, Vault.

## 11. Blocages restants

1. Réparer la virtualisation (BIOS/fonctionnalités Windows/WSL) pour Docker, ou fournir un autre environnement Supabase/Postgres ; puis exécuter phase 1, activation, rollback et les tests d'intégration.
2. Fournir/vérifier `protect_objects_delete` et tester la suppression d'un fichier rejeté.
3. Confirmer le contrat PDF pour le chat et la présence de `metadata.mimetype`/`size` à l'insertion.
4. Créer Vault/secrets par projet ; décider le backfill ; rotation du jeton exposé après inventaire des consommateurs.
5. Valider le nouveau test d'intégration (jamais exécuté) et tester les écrans mobiles sur appareil.

## 12. Diagnostic VirtualBox (ajout, constats vérifiés le 2026-10-11)

| Commande | Résultat | Code |
|---|---|---|
| `VBoxManage --version` | 7.2.4r170995 | 0 |
| `VBoxManage list vms` | **aucune VM enregistrée** | 0 |
| `VBoxManage list runningvms` | aucune VM en marche | 0 |
| `VBoxManage list hostinfo` | CPU i7-7500U, 2 cœurs / 4 threads ; **« Processor supports HW virtualization: no »** ; nested paging : no ; RAM 8083 Mo dont **1439 Mo disponibles** | 0 |
| Dossier `C:\Users\hp\VirtualBox VMs` | vide | — |

Conclusions :
- Il n'existe aucune VM Linux, donc aucun terminal invité ni Docker à interroger (`uname -m`, `docker info` : impossibles). Rien n'a été créé, démarré ni modifié.
- Même en créant une VM : VirtualBox signale que le CPU n'expose pas VT-x/AMD-V (la même cause que `hasNoVirtualization: true` de Docker Desktop). Sans virtualisation matérielle, VirtualBox ne peut pas exécuter d'invité 64 bits, or les images de la pile Supabase locale sont x86_64/arm64 64 bits. La VM ne contourne donc pas le blocage.
- Ressources : ~1,4 Go de RAM libre, très insuffisant pour la pile Supabase complète (Postgres, Storage, Auth, Realtime, Kong, Edge runtime, etc.).
- Un simple Postgres ne suffirait pas à démontrer Storage, Vault, pg_net, pg_cron et les fonctions Edge.

Statut inchangé : **BLOCKED** (aucun test SQL ni d'intégration exécuté).

Alternatives les moins coûteuses (non mises en œuvre) : (1) activer la virtualisation dans le BIOS/UEFI puis les fonctionnalités Windows/WSL2 (action humaine, puis `supabase start` + `supabase db reset`) ; (2) exécuter la CI existante `ci-full.yml` (`supabase start` + `db reset` + tests d'intégration) sur un runner GitHub, sans toucher au projet Supabase distant ; (3) une autre machine ou un Linux natif disposant de ≥ 8 Go de RAM et de la virtualisation. Dans les cas 2-3, l'activation Phase 2 reste à jouer avec des entrées Vault jetables locales (`target_env=local-test`).

## 13. Exécution CI sur GitHub B (résultats réels)

**Cible** : `kazagroupe0-blip/KAZA-validation-2`, branche `security/F05-storage-hardening-20261011-ghb`, basée sur `security/payments-mutation-boundary-20261004` (les 8 fichiers clients/config touchés par F05 y sont identiques à la version antérieure de la branche A ; `validation/f01-f26-validated` diffère sur `edit.tsx` et `residence-form.tsx`, et `main` n'est pas une base complète). Historiques non communs : seul le patch F05 a été transféré (commits **ec57fc2** puis **3e9ce10**), aucun historique de A poussé, aucune PR, aucun merge, aucun déploiement, aucune opération sur le Supabase distant.

**Quota (compte B, plan Free)** : relevé `/settings/billing/usage/summary` d'octobre 2026 : 124 min Actions Linux brutes, 124 remises, 0 net facturé. Le quota inclus n'est pas exposé par l'API ; le plan Free inclut 2000 min/mois selon la documentation GitHub (non lu via l'API). Deux runs F05 d'environ 6 min chacun ont été lancés.

| Run | SHA | Résultat | Lien |
|---|---|---|---|
| 38121051856 | ec57fc2 | échec sur une assertion **du workflow** (`regproc::text` sans schéma), après un `supabase db reset` réussi | https://github.com/kazagroupe0-blip/KAZA-validation-2/actions/runs/38121051856 |
| 38121430542 | 3e9ce10 | échec à l'étape « F05 integration tests » (installation de test manquante, voir ci-dessous) | https://github.com/kazagroupe0-blip/KAZA-validation-2/actions/runs/38121430542 |

**Étapes du run 2 réellement réussies** (vérifiées dans les logs) : dépendances ; **tests unitaires Vitest** ; **deno lint + check** des fonctions Edge ; démarrage de la pile Supabase locale ; **`supabase db reset` Phase 1** (toutes les migrations, migration F05 comprise, rejouées sans secret) avec assertions (table créée, garde F05 présente, aucun trigger webhook installé, garde existante toujours liée) ; **entrées Vault jetables** ; **gardes d'activation** (ref de test refusé pour production, ref de production refusé pour test, divergence Vault refusée, rien installé après échec) ; **activation Phase 2 `local-test`**, **post-checks**, **assertions SQL** (`supabase/activation/ci/retry_assertions.sql` : reprise avec incrément, plafond de 5 tentatives → rejected, objet disparu → rejected, garde SQL : PDF dans residence-photos, MIME ou taille absents, taille non numérique ou débordante, fichier trop petit) ; **rollback puis réactivation deux fois** (idempotence) ; **service du validateur Edge local** (répond 401 sans secret).

**Étape en échec (run 2)** : « F05 integration tests ». Cause lue dans les logs : `Manual cleanup failed on favorites: column favorites.id does not exist`, dans `tests/helpers/setup.ts` / `resetDatabase`. Le helper exige la fonction `reset_test_database`, que `ci-full` installe via « Install CI-only test helpers » ; mon workflow ciblé ne l'installait pas. C'est un défaut de **mise en place du test**, pas un résultat négatif sur F05. Les 12 tests d'intégration (états pending/validated/rejected, lecture inter-utilisateurs, validateur Edge de bout en bout) n'ont donc **pas été exécutés**.

**Correctif préparé, non poussé** : l'étape d'installation des helpers (copiée de `ci-full.yml`) est ajoutée au workflow dans le clone de travail B (non commitée). Un troisième run dépasse le budget « une unique relance » : à autoriser explicitement.

**Prouvé / non prouvé**
- Prouvé en CI locale jetable : rejeu Phase 1 sans secret ; activation Phase 2 et ses gardes d'environnement ; rollback ; reprises et plafond ; garde SQL MIME/taille ; démarrage et authentification du validateur Edge.
- **Non prouvé** : RLS et lecture inter-utilisateurs réelles via l'API Storage ; cycle pending → validated/rejected par le handler Edge (persistance, suppression d'un fichier rejeté, rejeu idempotent) ; URLs signées. Le trajet PostgreSQL → fonction Edge via `pg_net` vers une URL `https://<ref>.supabase.co` n'est pas testable en local (le webhook est simulé par appel direct du handler) et reste non démontré. Rien n'est démontré sur les projets distants. **La production ne peut pas être déclarée sécurisée.**

**Statut final : BLOCKED** (tests d'intégration F05 non exécutés).

## 14. Lot correctif consolidé après diagnostic CI (2026-10-11) — NON EXÉCUTÉ en SQL / intégration

Statut inchangé : **BLOCKED**. Tout ce qui suit est écrit mais, faute de Docker (démon inaccessible, voir §12) et sans nouveau run CI (non autorisé), **aucun SQL, aucun test d'intégration, aucun test pg_net → Edge n'a été exécuté pour ce lot**. Seuls ont tourné :
- Vitest complet : 16 fichiers, 165 tests verts (dont 31 dans `storage-upload-contract.test.ts` : ce sont des contrôles TEXTUELS de fichiers, pas des tests SQL) ;
- `deno lint` + `deno check` des 10 fonctions Edge : 0 échec ;
- `bash -n` des 22 scripts `run:` du workflow et du script de course, analyse YAML du workflow ;
- `tsc` ciblé des fichiers de test d'intégration (seules erreurs restantes : celles, préexistantes, de `tests/helpers/supabase-test-client.ts` et des génériques supabase-js).

### 14.1 Contrat SQL d'upload (métadonnées provisoires / définitives)
- Fichiers : migration `20261010175125_harden_storage_upload_validation.sql` (`public._guard_storage_upload_f05`), `supabase/activation/f05_activate_storage_validation.sql` (clause WHEN du trigger webhook), `supabase/activation/ci/guard_assertions.sql` (nouveau).
- Comportement :
  - MIME exigé et filtré dans tous les cas (PDF interdit dans `residence-photos`, contrôle provisoire compris).
  - Avec `metadata.size` : insertion définitive, entier d'au plus 12 chiffres, 12 o ≤ taille ≤ 20 MiB, ligne `pending` créée, `contentLength` ignoré.
  - Sans `size` mais avec `contentLength` : numérique et borné, **aucune ligne d'état**.
  - Sans `size` ni `contentLength` : toléré uniquement si le MIME est la seule métadonnée ; sinon refus.
  - Le webhook ne part que si `metadata.size` est présent (garde dans `dispatch_storage_validation_webhook` et clause WHEN du trigger).
- Assertions écrites (non exécutées) : plus de 40 cas (provisoire, bornes, débordement, JSON null, `size` invalide non « rattrapé » par un `contentLength` valide…). Un envoi définitif se reconnaît à `retry_attempts = 1`, un provisoire à l'absence de ligne d'état.
- Ancien trigger conservé avant activation : étape CI « Pre-activation state » (garde historique liée, pas de webhook, `private.f05_activation` vide, cible refusée). Non exécutée.
- **Risques résiduels** :
  - la forme exacte des métadonnées provisoires de la version de Storage utilisée n'est pas vérifiée ; la tolérance « MIME seul » et `contentLength` reposent sur l'énoncé de la mission. Si Storage ajoute d'autres clés au contrôle provisoire, les uploads seront refusés (fail-closed, visible dès le premier test d'intégration réel) ;
  - une ligne `storage.objects` persistée sans `size` (insertion directe privilégiée) n'aurait pas d'état de validation donc serait lisible comme « historique » ; non atteignable par un client via l'API.

### 14.2 Trajet PostgreSQL → Edge local
- `private.f05_activation` : table à un seul enregistrement, écrite par le script d'activation dans sa transaction, effacée par le rollback.
- `private.storage_validation_target()` retourne maintenant `o_url, o_secret, o_apikey`. Elle n'accepte une URL `http://<hôte>:<port>/functions/v1/validate-file-upload[-v2]` que si l'environnement enregistré est `local-test` ET le ref attendu `localtestrefaaaaaaaa`. Elle exige ref Vault = ref enregistré. La clé `apikey` Vault est facultative : `sb_secret_*` et les JWT de rôle ≠ `anon` sont refusés.
- CI :
  - l'URL factice `localtestrefaaaaaaaa.supabase.co` est supprimée ;
  - `supabase functions serve` démarre AVANT l'activation et est sondé depuis l'hôte (401 sans secret, 400 avec secret + événement invalide, 409 pour un objet inconnu, ce qui prouve que le handler atteint API et base depuis son conteneur) ;
  - le workflow **découvre** réseau Docker, conteneur Kong et ports exposés (`docker inspect`, rien d'inventé) et sonde chaque candidat **depuis PostgreSQL** (`net.http_post`, lecture de `net._http_response` : 400 avec le bon secret, 401 avec un faux secret ou sans secret) ;
  - l'URL retenue et la clé anon sont écrites dans Vault.
- Assertions écrites (non exécutées) :
  - `ci/target_assertions.sql` : production et test distant refusent l'URL locale et toute URL http ; ref divergent ; astuce de suffixe de domaine ; absence d'enregistrement ; apikey ;
  - refus au niveau de l'activation (Vault aligné sur production puis test, URL locale) ;
  - rollback → enregistrement effacé → cible refusée ; réactivation ×2 puis ré-exécution de `target_assertions` et `guard_assertions`.
- **Risques résiduels** : nom et port du conteneur Kong, et capacité du worker `pg_net` à atteindre cette route, **non vérifiés** (découverte au runtime, échec explicite si introuvable). Un opérateur disposant d'un accès DB complet peut écrire `private.f05_activation` : le lien est « autant que possible », pas inviolable.

### 14.3 Tests d'intégration
- `storage-upload-validation.test.ts` : exige le webhook en pause (`KAZA_F05_WEBHOOK_PAUSED=1`) ; aucune erreur d'upload ignorée ; fixtures enregistrées après succès seulement.
- `storage-validation-edge.test.ts` (réécrit) : appels DIRECTS au handler, explicitement non comptés comme preuve du trajet automatique. Couvre : authentification, rejeu validé/rejeté, événement invalide tardif sur objet validé (ni écrasé ni supprimé), état terminal non renversable même par écriture inconditionnelle, reprise de suppression d'un rejeté, **échec réel de suppression** (trigger CI `ci_f05_block_delete` : 503, objet toujours illisible, supprimé au rejeu), concurrence (4 livraisons simultanées, fichier valide et invalide), PDF dans `residence-photos`.
- Le PDF dans `residence-photos` est un **vrai objet** créé AVANT activation (`f05-prepare-legacy-fixture.test.ts`, garde historique encore liée) ; la ligne `pending` n'est insérée qu'après vérification de son existence.
- `storage-validation-automatic.test.ts` (nouveau) : upload réel authentifié puis attente d'un état terminal (délai max 90 s, diagnostic avec dernier état observé) : JPEG → `validated` + URL signée ; PNG déclaré JPEG → `rejected` + objet supprimé ; PDF chat validé ; PDF dans `residence-photos` refusé par la garde sans ligne d'état ; photo validée. Aucun appel direct.
- Aucun de ces fichiers n'a été exécuté.

### 14.4 Transitions d'état et reprise des suppressions
- `validate-file-upload/index.ts` : plus aucun `upsert`. `markRejected` = `UPDATE … WHERE status='pending'`. Un `pending` perdu face à `validated` donne 409 sans suppression. Un rejeté sans `deleted_at` est supprimé à nouveau au rejeu ; `deleted_at` est posé après suppression confirmée. Vérifié : `deno lint` + `deno check` OK ; tests statiques OK.
- SQL :
  - colonnes `deleted_at`, `delete_attempts` ;
  - trigger `storage_validation_state_guard` : validated et rejected sont irréversibles ; retour à `pending` seulement via un nouvel envoi du même nom par la garde (drapeau local à la transaction) ;
  - la reprise cron renvoie au validateur les rejetés dont l'objet existe encore (5 min, 5 tentatives maximum, objet toujours illisible), pose `deleted_at` si l'objet a disparu, ne touche jamais un validé ;
  - changement de comportement : après 5 envois sans issue, l'objet n'est plus laissé « en revue manuelle » mais rejeté puis supprimé.
- Tests écrits, non exécutés : `ci/state_machine_assertions.sql`, `ci/retry_assertions.sql` (réécrit), `ci/race_validated_vs_rejected.sh` (vraie course à deux sessions psql, deux ordres).
- **Risques résiduels / non démontrés** :
  - la sûreté en concurrence repose sur la sémantique READ COMMITTED de PostgreSQL, que seul le script de course (non exécuté) doit démontrer ;
  - le drapeau `kaza.f05_reupload` peut être posé par tout rôle autorisé à `UPDATE` la table (service_role) : le trigger protège contre les bugs de logique, pas contre un service_role malveillant.

### 14.5 Validation CI future (aucune commande lancée ici)
Copier vers le clone B (`C:\Users\hp\kb`, branche `security/F05-storage-hardening-20261011-ghb`) : migration, `supabase/activation/**`, `validate-file-upload/index.ts`, workflow, tests d'intégration et `tests/storage-upload-contract.test.ts`. Puis, **après autorisation explicite**, un seul push. Le run enchaîne : fixture PDF → pré-activation → serveur Edge → route PG→Edge → Vault → gardes d'activation → phase 2 + assertions SQL + course → rollback/réactivation → intégration (webhook en pause) → intégration automatique. Critère de sortie : tout vert, sans relance sélective.

### 14.6 Conclusion de ce lot
Corrections livrées et vérifiées statiquement uniquement. F05 n'est **pas** prêt pour la production : restent à démontrer par exécution la preuve du chemin réel d'upload, du webhook automatique pg_net → Edge, des règles d'accès via l'API Storage, du nettoyage des fichiers rejetés, de la concurrence et du rollback.

## 15. Revue bloquante pré-transfert (2026-10-11) — proposition de diff local, rien transféré

Statut : **BLOCKED**. Rien n'a été copié vers B, poussé, committé ni lancé en CI ; aucun accès distant. Le résultat est un diff local prêt à revue, pas une déclaration de production prête. Ce paragraphe prime sur §14 en cas de divergence.

### 15.1 Corrections apportées

**A. Taille provisoire (garde F05).**
- `contentLength` est traité comme la longueur de la requête, pas du fichier. En multipart il inclut le surcoût des parties.
- Provisoire : numérique, ≥ 12, ≤ 20 MiB + 64 KiB (filet pour le surcoût multipart) ; aucune ligne d'état créée.
- Définitif : `metadata.size` obligatoire, numérique, 12 o ≤ taille ≤ 20 MiB **exactement**, sans marge ; `contentLength` n'est jamais lu quand `size` est présent.
- Cas à la limite écrits dans `ci/guard_assertions.sql` : brut 20 MiB accepté, brut +1 o refusé ; multipart 20 MiB (contentLength 20971900) accepté, multipart +1 o refusé ; borne provisoire 21037056 accepté / 21037057 refusé ; petit fichier multipart.
- **Conflit relevé, non tranché** : `supabase/config.toml` fixe `[storage] file_size_limit = "5MiB"`. Le Storage local refusera donc tout fichier > 5 MiB avant la base : le plafond F05 de 20 MiB n'est pas atteignable en local, et la limite effective en production n'a pas été lue (accès distant interdit). Le client web plafonne à 8 MiB. Résolutions possibles, à décider par vous : (1) aligner explicitement la limite F05 sur la limite Storage réelle de chaque projet (par bucket) ; (2) relever `file_size_limit` en local/CI à 20 MiB pour pouvoir tester la borne. Aucun plafond n'a été modifié.

**B. Remplacement d'objet (`upsert: true`).**
- Cycle : le serveur Storage n'est pas disponible localement (image Docker non démarrable, pas de code serveur dans `node_modules`). Je n'ai donc **pas pu tracer** l'upsert réel. Hypothèse de travail (non vérifiée ici) : écriture `INSERT … ON CONFLICT (bucket_id, name) DO UPDATE`, donc BEFORE INSERT (garde) puis UPDATE, **sans** AFTER INSERT.
- Ajouté : trigger `kaza-storage-content-validation-update` (AFTER UPDATE sur `storage.objects`), actif seulement si bucket validé, `size` présent et (`version` ou `metadata` changés). Le dispatch ignore sans erreur un UPDATE dont l'état n'est pas `pending` (la garde ne remet à `pending` que sur une insertion/remplacement). Le webhook n'écrit jamais dans `storage.objects` : pas de boucle. L'activation vérifie la présence de la colonne `storage.objects.version` (sinon échec atomique) ; le rollback supprime ce trigger. Si Storage faisait DELETE + INSERT, le trigger AFTER INSERT existant suffirait et celui-ci serait inoffensif.
- Assertions écrites : `state_machine_assertions.sql` (remplacement d'un validé et d'un rejeté → `pending`, `retry_attempts = 1` = un seul envoi ; mise à jour sans changement → aucun envoi ni changement d'état). Reprise en cas d'échec : `retry_assertions.sql` (un `pending` ancien est renvoyé).

**C. Isolation des tests directs.** Aucune commande ne désactivait « tous » les triggers : seule la désactivation nommée existait. Elle vise maintenant exactement les deux triggers du webhook ; une assertion SQL exige que seuls ces deux soient désactivés (garde F05, `protect_objects_delete`, `update_objects_updated_at` restent actifs). Réactivation par `trap resume EXIT` (succès, échec ou arrêt du shell). Limite : un arrêt brutal du runner (kill -9, perte de machine) ne peut pas être couvert, mais la base est jetable ; l'étape suivante revérifie que les deux triggers sont actifs.

**D. Reprise de suppression (lecture croisée handler / dispatch / retry / assertions).**
- `rejected` + `deleted_at` NULL + objet présent : la reprise (passe 5) incrémente `delete_attempts`, met `updated_at` à jour et renvoie `record = to_jsonb(storage.objects)` ; le handler lit `rejected`, `deleted_at` NULL → supprime à nouveau puis pose `deleted_at`. L'objet reste illisible (`allows_read` faux tant que l'état n'est pas `validated`).
- Objet déjà absent : `deleted_at` posé par la reprise (ou par le handler, `remove` d'un objet absent étant un succès côté API — comportement Storage non vérifié ici).
- Plafond 5 tentatives, délai ≥ 5 min depuis `updated_at` : assertions écrites. Un validé n'est ni sélectionné par la reprise ni modifiable (trigger d'états, handler `alreadyProcessed`).
- Après rollback : le script restaure les politiques antérieures, donc un rejeté non supprimé redevient lisible par les règles historiques. Le script liste ces objets pour suppression manuelle ; ce n'est pas automatisé et **c'est un risque de rollback**.

**E. Environnement enregistré.** `private.f05_activation` conditionne l'URL `http://` locale à `local-test` + ref `localtestrefaaaaaaaa` ; `production` et `test` la refusent (assertions SQL et étape d'activation). Rollback efface le marqueur (cible refusée « not activated »), la réactivation le réécrit, `target_assertions.sql` est rejoué après. `apikey` : `sb_secret_*` et JWT de rôle ≠ `anon` refusés, `sb_publishable_*` et JWT `anon` acceptés. Tout ceci est écrit et lu statiquement, **non exécuté**.

### 15.2 Classement des preuves

**1. Vérifié par exécution (local, sans effet distant)**
- `npx vitest run` : 16 fichiers, 169 tests verts (dont 35 dans `storage-upload-contract.test.ts` : contrôles textuels uniquement).
- `deno lint` + `deno check` sur les 10 `supabase/functions/*/index.ts` : 0 échec.
- `bash -n` sur les 22 scripts `run:` du workflow et sur `race_validated_vs_rejected.sh` : 0 erreur ; le YAML du workflow se charge (js-yaml).
- `tsc --noEmit` ciblé sur les 4 fichiers de test d'intégration F05.

**2. Vérifié statiquement (lecture / tests textuels, pas d'exécution SQL)**
- Structure de la garde (provisoire vs définitif, bornes, ordre MIME → taille), trigger AFTER UPDATE et son rollback, absence d'`upsert` dans le handler, suppression atteignable seulement depuis `rejected`, ordre des étapes du workflow, désactivation ciblée + `trap`, absence d'URL factice, clé `apikey` issue de l'anon.

**3. Non exécuté**
- Tout SQL (migration, activation, rollback, `ci/*.sql`), la course à deux sessions, le trajet Storage → `pg_net` → Edge, les tests d'intégration (contrôlés, directs, automatiques), la fixture PDF, la découverte Docker du conteneur de passerelle, le comportement réel de `upsert` et des métadonnées provisoires/multipart de la version de Storage locale.

**4. Risque restant**
- Contrat des métadonnées provisoires et fonctionnement de l'upsert supposés, pas observés ; conflit 5 MiB local / 20 MiB F05 ; objets rejetés non supprimés redevenant lisibles après rollback ; route `pg_net` → Kong non vérifiée ; marqueur d'activation modifiable par un accès DB complet ; drapeau de ré-envoi posable par tout rôle pouvant écrire la table ; concurrence dépendante de READ COMMITTED non démontrée ; aucune preuve sur les projets distants ni sur mobile réel. Production : **non déclarée sûre**.

### 15.3 Comparaison des erreurs TypeScript avec la révision de base
- `tests/helpers/supabase-test-client.ts` n'est pas modifié (`git diff HEAD` vide) : ses 2 erreurs (TS2367, TS2345) sont bien celles de HEAD.
- Les tests HEAD `rls-profiles.test.ts` / `rls-conversations-messages.test.ts` produisent déjà des erreurs de type `never` du client Supabase non typé : même classe que celle que `storage-upload-validation.test.ts` produisait. Cette dernière a été supprimée en typant les clients en `any` ; il ne reste dans les fichiers F05 que les 2 erreurs de l'aide HEAD. Les fichiers F05 n'introduisent donc plus d'erreur propre.

### 15.4 Fichiers touchés dans ce lot
Migration `20261010175125_harden_storage_upload_validation.sql` (dispatch UPDATE, borne provisoire) ; `supabase/activation/f05_activate_storage_validation.sql`, `f05_rollback_storage_validation.sql` ; `supabase/activation/ci/guard_assertions.sql`, `state_machine_assertions.sql` ; `.github/workflows/f05-storage-validation.yml` ; `tests/storage-upload-contract.test.ts` ; `tests/integration/security/storage-upload-validation.test.ts` ; ce rapport.

## 16. Décision technique : plafond fonctionnel 5 MiB (2026-10-11) — remplace tous les « 20 MiB » et « 8 Mo » des §1–15

Statut : **BLOCKED** (inchangé). Aucun commit, push, transfert vers B, accès distant ni CI.

### 16.1 Appliqué
- `[storage] file_size_limit = "5MiB"` conservé (non relevé pour la CI) ; un test statique le vérifie.
- Garde SQL F05 : taille définitive (`metadata.size`) ≤ 5 MiB = 5 242 880 o **exactement**, minimum 12 o. `contentLength` reste une longueur de requête provisoire : borne de filet 5 MiB + 64 KiB (5 308 416), aucune ligne d'état.
- Contrôle serveur du contenu (`MAX_VALIDATED_FILE_SIZE_BYTES`) : 5 MiB.
- Web (`chat-window.tsx`, `residence-form.tsx`, `lib/api/chat.ts`) : 5 Mo, messages alignés. Mobile : constantes partagées `MAX_UPLOAD_FILE_SIZE_BYTES` / `MIN_UPLOAD_FILE_SIZE_BYTES` (`packages/shared`), contrôle de la longueur réelle des octets dans `prepareImageForUpload` avant détection du format, message « 5 Mo maximum ».
- Anciennes migrations (`017_…`, `20260908232309_…`) non modifiées : elles portent toujours leur limite historique de 20 MiB, sans effet une fois la garde F05 activée.

### 16.2 Tests
- Écrits, **non exécutés en SQL** (`ci/guard_assertions.sql`) : mode brut (contentLength = size) 5 242 880 accepté / 5 242 881 refusé ; mode multipart (contentLength 5 243 200 > size) 5 242 880 accepté / 5 242 881 refusé ; provisoire : 5 308 416 accepté, 5 308 417 refusé, petit fichier multipart accepté ; `contentLength` valide ne rattrape pas un `size` invalide.
- **Exécutés** : Vitest complet 16 fichiers / 174 tests verts, dont `storage-upload-contract.test.ts` (textuel) et le contrôle de contenu réel sur octets : exactement 5 MiB accepté (`chat-files` et `residence-photos`), 5 MiB + 1 refusé. `deno lint` + `deno check` des 10 fonctions : 0 échec. `tsc --noEmit` des projets web et mobile : aucune erreur signalée sur les fichiers modifiés (filtre sur ces fichiers ; le reste du bilan tsc des projets n'a pas été comparé à la base).
- Les fixtures d'intégration (36–40 octets) n'ont pas été modifiées ; aucun test d'intégration ne téléverse 5 MiB (le Storage local refuserait 5 MiB + 1 avant la base : cas couvert côté SQL et octets seulement).

### 16.3 Blocage de mise en production ajouté
**Vérifier la configuration réelle des projets Supabase distants avant toute validation de production** : limite globale et limite par bucket (`residence-photos`, `chat-files`), types MIME de bucket, présence et version de `storage.objects.version`, triggers existants. Rien n'a été lu ni modifié à distance ; la limite effective du Storage distant est **inconnue**. Si elle dépasse 5 MiB, la garde SQL reste la borne ; si elle est inférieure, les clients peuvent promettre plus que ce que le Storage accepte.

### 16.4 Évolution séparée
Un plafond de 20 MiB pourra être étudié ultérieurement, seulement si le besoin métier est confirmé et si Storage (global + buckets), garde SQL, contrôle serveur, clients web/mobile, messages et tests sont changés ensemble.

### 16.5 Condition de sortie de BLOCKED
Exécution réussie des tests SQL et d'intégration sur une pile locale fonctionnelle, puis vérification des paramètres distants (§16.3).

## 17. Revue statique finale dans le checkout A (2026-10-11)

Statut : **BLOCKED**. Aucun SQL ni test d'intégration n'a été exécuté (Docker indisponible). Aucun commit, push, transfert vers B, accès distant ni CI. Les 26 entrées non commitées sont préservées.

### 17.1 Exécuté
- Vitest complet : 16 fichiers, 174 tests verts (contrôles textuels pour tout ce qui touche SQL/workflow).
- `deno lint` + `deno check` : 10 fonctions Edge, 0 échec.
- `bash -n` : 22 scripts `run:` du workflow, 0 erreur ; YAML chargé.
- Recherche de secrets (JWT, `sb_secret_`, URL de connexion avec mot de passe) dans tous les fichiers modifiés ou nouveaux : aucune occurrence.

### 17.2 Revue statique
- **Anciennes limites.** Chemins actifs : plus aucune occurrence de 20 MiB ni de 8 Mo (recherche exhaustive hors `node_modules`). Seules restent les migrations historiques `017_storage_mime_validation.sql` (l. 52) et `20260908232309_production_security_final.sql` (l. 700), qui portent 20 MiB dans l'ancienne garde `_guard_storage_upload`, **encore liée tant que F05 n'est pas activé** : avant activation la limite effective de la garde SQL reste 20 MiB (le Storage plafonne à 5 MiB). Je ne les ai pas modifiées. Les buckets ne fixent pas de `file_size_limit` dans les migrations (seul `expenses` : 5 MiB, hors périmètre F05) ; les mentions restantes de 20 MiB / 8 Mo sont dans ce rapport (historique) et dans un test qui les interdit.
- **Contrat 5 MiB.** Garde SQL : définitif ≤ 5 242 880 sans marge, provisoire ≤ 5 242 880 + 65 536. Edge : `MAX_VALIDATED_FILE_SIZE_BYTES` = 5 MiB sur les octets réels. Web : 3 fichiers à 5 Mo. Mobile : contrôle des octets réels avant détection du format. Tests : limite exacte et +1 en octets réels (exécutés), cas brut/multipart en SQL (non exécutés). **Défaut corrigé** : le mobile affichait « trop volumineuse » pour une image trop petite ; deux messages distincts maintenant.
- **Déclenchement UPDATE (remplacement).** Le comportement réel de Storage lors d'un `upsert: true` n'a pas été observé : **non validé**. Hypothèse : `INSERT … ON CONFLICT DO UPDATE`. Défaut corrigé : le dispatch lisait la cible Vault avant de savoir si un état `pending` existait, donc une mise à jour d'objet banale pouvait échouer sur une cible mal configurée. Il consulte maintenant l'état `pending` en premier (un UPDATE sans `pending` sort sans lire Vault). Risque restant : si Storage fait un INSERT puis un UPDATE de métadonnées pour un envoi ordinaire, le trigger UPDATE enverrait un second événement sur la ligne encore `pending` (inoffensif, idempotent, mais incrémente `retry_attempts`). Ce point est à observer lors de la première exécution réelle.
- **Ordre de la CI.** Reset phase 1 → helpers → simulateur de suppression → **fixture PDF historique (garde héritée liée)** → état pré-activation → serveur Edge → route PG→Edge → Vault → gardes d'activation → phase 2 + assertions + course → rollback → réactivation ×2 → tests contrôlés (webhook en pause) → tests automatiques. Cohérent : la fixture précède l'activation et survit au rollback (aucune ligne d'état).
- **Triggers suspendus.** Seuls `kaza-storage-content-validation` et `kaza-storage-content-validation-update` sont désactivés, par nom ; une assertion exige exactement 2 triggers désactivés et 3 triggers de garde/protection/maintenance actifs ; `trap resume EXIT` + réactivation explicite ; l'étape suivante revérifie les 2 triggers actifs. Limite : arrêt brutal du runner non couvert (base jetable). Risque : les noms `protect_objects_delete` et `update_objects_updated_at` sont supposés présents sur la pile locale ; s'ils n'existent pas, l'assertion CI échoue (visible, non silencieux), alors que l'activation ne fait qu'avertir.
- **Reprise / états / marqueur / cible.** Relus ensemble (handler, dispatch, reprise, assertions, activation, rollback) : une reprise sur `rejected` + `deleted_at` NULL renvoie bien la ligne au validateur ; les transitions terminales sont protégées par le trigger d'états et les UPDATE conditionnels ; le marqueur d'activation est écrit avant la validation de la cible, effacé au rollback ; la cible locale `http` exige `local-test`. Aucune incohérence supplémentaire trouvée, **sans exécution**.

### 17.3 Défauts, risques et fichiers

| # | Type | Description | Fichier(s) | Statut |
|---|------|-------------|-----------|--------|
| 1 | Défaut corrigé | Mobile : message « trop volumineuse » pour une image trop petite | `apps/mobile/lib/storage-upload.ts` | Corrigé, vérifié statiquement |
| 2 | Défaut corrigé | Dispatch : lecture Vault avant de savoir si un état `pending` existe (un UPDATE banal pouvait échouer) | migration `20261010175125_…` | Corrigé, test textuel, non exécuté |
| 3 | Risque | Comportement réel de `upsert` / métadonnées provisoires de Storage non observé ; possible second événement sur un INSERT suivi d'un UPDATE | migration, `f05_activate_storage_validation.sql` | Ouvert, à observer en exécution |
| 4 | Risque | Garde héritée (20 MiB) active tant que F05 n'est pas activé | `017_storage_mime_validation.sql`, `20260908232309_production_security_final.sql` | Ouvert, historique intact |
| 5 | Risque | Noms de triggers locaux supposés (`protect_objects_delete`, `update_objects_updated_at`) ; route Kong, version `storage.objects.version` supposées | workflow, activation | Ouvert, échec visible si faux |
| 6 | Risque | Après rollback, un rejeté non supprimé redevient lisible (politiques historiques) | `f05_rollback_storage_validation.sql` | Ouvert, liste manuelle |
| 7 | Blocage | Aucun test SQL ni d'intégration exécuté ; trajet `pg_net` → Edge non prouvé | `ci/*.sql`, tests d'intégration, workflow | Ouvert |
| 8 | Blocage | Configuration réelle des projets distants (limites, MIME, `version`, triggers) non vérifiée | — | Ouvert, avant toute mise en production |
| 9 | Risque | Marqueur d'activation et drapeau de ré-envoi modifiables par un accès DB / service_role | migration | Accepté, documenté |

F05 reste **BLOCKED**.

## 18. Intervention du 2026-10-11 : idempotence du webhook et rollback fail-closed

Cette section corrige les conclusions devenues obsolètes des §14 à §17 sur les points suivants : (a) la reprise de suppression est inchangée, mais le risque « second événement sur un INSERT suivi d'un UPDATE » (§17.3 ligne 3) est maintenant traité par une revendication atomique par génération ; (b) la phrase « le script liste les objets rejetés pour suppression manuelle » (§14.4, §15.1-D, §17.3 ligne 6) est **remplacée** : le rollback est désormais refusé tant qu'un tel objet existe.

### A. Résumé exécutif
Statut final : **BLOCKED**. Les deux corrections sont écrites et vérifiées statiquement (tests textuels, `deno lint`/`deno check`, `bash -n`, YAML). **Aucun SQL, aucun test d'intégration, aucune course PostgreSQL n'a été exécuté** : le démon Docker reste inaccessible (« Docker Desktop is unable to start »), et je n'ai ni contourné ce blocage ni utilisé de projet Supabase distant. F05 n'est pas déclaré prêt pour la production : le trajet Storage → PostgreSQL → `pg_net` → Edge et les garanties de rollback ne sont pas démontrés par exécution.

### B. Défaut d'idempotence
**Cause (par lecture du code, pas par observation).** Un même upload pouvait déclencher le dispatch plusieurs fois : le trigger AFTER INSERT puis le trigger AFTER UPDATE (si Storage écrit la ligne en deux temps, ou en cas de remplacement suivi d'une mise à jour de métadonnées). Chaque appel faisait `retry_attempts + 1` sans mémoire de la génération déjà envoyée, ce qui consommait le plafond de 5 tentatives sans vraie reprise et émettait des requêtes en double. La comparaison « vérifier puis écrire » n'existait pas, mais rien n'empêchait deux déclenchements équivalents.

**Correction.**
- Colonnes (migration, `add column if not exists`, rejouable) : `generation` (génération de contenu posée par la garde d'upload), `dispatched_generation` (dernière génération dont l'envoi a été revendiqué), `last_request_id` (id `pg_net` de la dernière requête réellement mise en file).
- Clé de génération `private.f05_object_generation(version, metadata)` = `storage.objects.version` si présente, sinon `eTag|taille`. **Hypothèse non vérifiée** : que `version` soit un identifiant d'envoi propre à chaque contenu (conception S3 de Storage). Elle n'a pas pu être confirmée sans le serveur Storage ni Docker.
- Revendication atomique dans `private.dispatch_storage_validation_webhook()` : un seul `UPDATE … WHERE status='pending' AND dispatched_generation IS DISTINCT FROM <clé>` qui incrémente la tentative et pose `dispatched_generation`. Deux triggers ou deux sessions se sérialisent sur le verrou de la ligne d'état : le premier revendique, le second ne trouve rien et sort sans envoi ni tentative consommée. La revendication précède la lecture de la cible Vault et l'appel `net.http_post`.
- La garde d'upload remet `dispatched_generation` et `last_request_id` à NULL et pose la nouvelle `generation` à chaque nouvel envoi (donc un vrai remplacement est toujours revendiqué une fois).
- Le trigger AFTER UPDATE ne se déclenche plus que si la version, l'eTag ou la taille changent (une mise à jour de métadonnées ordinaires ne déclenche rien).
- La reprise cron n'est **pas** soumise à la revendication : c'est une vraie tentative (incrémente `retry_attempts`, enregistre son `last_request_id`). Elle couvre l'événement envoyé mais jamais terminé par l'Edge, et une mise en file échouée.
- Échec de **mise en file** `pg_net` : l'upload n'est plus perdu ; l'objet reste `pending` (illisible), `last_error` est renseigné, `last_request_id` reste NULL, la reprise réémet. Une cible Vault invalide continue en revanche de faire échouer l'instruction (fail-closed, tentative non consommée).
- Génération obsolète : le handler Edge lit `generation` avec l'état, puis conditionne **chaque** transition (`markValidated`, `markRejected`) sur `status='pending'` ET cette génération. Un verdict calculé sur l'ancien contenu n'écrit rien sur un contenu remplacé entre-temps. Le trigger d'états interdit en outre tout changement de `generation` hors nouvel envoi.

**Fichiers** : `supabase/migrations/20261010175125_harden_storage_upload_validation.sql`, `supabase/activation/f05_activate_storage_validation.sql`, `supabase/functions/validate-file-upload/index.ts`.

**Tests qui le démontrent (écrits ; seuls les contrôles textuels ont été exécutés)**
- `supabase/activation/ci/idempotence_assertions.sql` : nouvel upload (pending, génération, 1 tentative, id de requête) ; deux événements de la même génération sans tentative ni requête supplémentaire ; mise à jour de métadonnées sans effet ; reprise après délai (+1 tentative, nouvel id, requête restée sans réponse récupérable) ; remplacement réel (nouvelle génération, pending, une validation) ; verdict d'une génération obsolète sans effet ; génération non modifiable hors nouvel envoi.
- `supabase/activation/ci/enqueue_failure_assertions.sql` : panne de mise en file simulée (renommage du schéma `net` dans une session dédiée) puis récupération par la reprise. **Elle ne s'exécute que si le rôle CI possède le schéma `net`** ; sinon elle affiche `ENQUEUE_FAILURE_TEST_SKIPPED` et le workflow émet un avertissement : ce serait alors un test non exécuté, pas un succès.
- `supabase/activation/ci/race_dispatch_claim.sh` : vraie course (5 sessions concurrentes sur la même génération → exactement `1|race-ver|true` ; 3 sessions sur une nouvelle génération → exactement une tentative de plus).
- Déjà existants et conservés : `race_validated_vs_rejected.sh` (validated/rejected concurrents), `state_machine_assertions.sql` (états terminaux non renversables), tests directs et automatiques d'intégration.
- Convergence de livraisons concurrentes sur le handler : `storage-validation-edge.test.ts` (inchangé, non exécuté).

### C. Sécurité du rollback
**Conditions de refus.** `f05_rollback_storage_validation.sql` s'exécute en `\set ON_ERROR_STOP on`, `begin;`, prend `lock table public.storage_upload_validations in share mode` (aucun envoi ni changement d'état ne s'intercale jusqu'au `commit`), puis un bloc `do` compte les objets **réellement présents** (`join storage.objects` sur `bucket_id = bucket_id` et `name = object_name`) dont l'état est différent de `validated`. S'il y en a, il lève `check_violation` (« F05 rollback refused: N object(s) … (x pending, y rejected). Nothing was changed. », avec la requête de diagnostic en `hint`). `deleted_at` n'est jamais consulté pour ce contrôle. Aucun fichier n'est supprimé par le script.

**Invariants.** La vérification précède toute modification (retrait des triggers, suppression du marqueur, rétablissement de la garde et des politiques, arrêt du cron). Tout est dans une seule transaction : l'erreur laisse F05 intact. Le marqueur d'activation n'est supprimé qu'après le contrôle, dans la transaction qui réussit. Les objets historiques sans ligne d'état ne bloquent pas.

**Tests (écrits, non exécutés)** — `supabase/activation/ci/rollback_assertions.sh` interroge le catalogue (empreinte md5 des triggers de `storage.objects`, politiques, job cron, marqueur) avant et après, et lit via RLS en rôle `authenticated` :
- cas 2 : objet `pending` présent → refus, empreinte identique, seul l'objet validé reste lisible ;
- cas 3 : objet `rejected` présent avec `deleted_at` renseigné (incohérent) → refus, accès toujours bloqué ;
- cas 5 : échec injecté au milieu du rollback (trigger CI sur la suppression du marqueur) → empreinte identique, aucune restauration partielle ;
- cas 1 + 4 : validés + objet historique sans état + rejeté réellement absent → rollback réussi, garde d'origine restaurée, deux triggers webhook retirés, marqueur et job cron supprimés, politiques historiques restaurées, lignes d'état conservées ;
- réactivation : empreinte identique à l'état activé initial.
- Cas 6 (objet rejeté jamais lisible) : couvert par la lecture RLS des cas 2 et 3 et par l'impossibilité d'un rollback réussi tant qu'il existe. **Les URL signées et l'accès direct via l'API Storage ne sont pas testés ici** (les tests d'intégration existants vérifient l'absence d'URL signée avant rollback uniquement).

**Limite documentée.** Un retour complet à l'ancienne configuration n'est possible que si plus aucun objet non validé n'est présent : c'est volontaire. Il faut supprimer ou attendre la validation de ces objets via l'API Storage avant de relancer le rollback.

### D. Tableau des contrôles (état final de ce lot)
| Contrôle | Commande | Résultat observé | Nature |
|---|---|---|---|
| Vitest complet | `npx vitest run` | 16 fichiers, 184 tests verts (dont 50 dans `storage-upload-contract.test.ts`, textuels) | exécution réelle (tests de texte pour le SQL) |
| Deno | `deno lint` + `deno check --config supabase/functions/deno.json` sur les 10 `*/index.ts` | 0 échec | exécution réelle |
| Bash | `bash -n` sur `race_dispatch_claim.sh`, `race_validated_vs_rejected.sh`, `rollback_assertions.sh`, `preflight-edge.sh` | 0 erreur | statique |
| Workflow | js-yaml + `bash -n` de chacun des 22 scripts `run:` | 0 erreur | statique |
| TypeScript | `tsc --noEmit` ciblé (4 fichiers de test d'intégration) | seules 2 erreurs, dans `tests/helpers/supabase-test-client.ts` (inchangé par rapport à HEAD : `git diff` vide) | exécution réelle ; comparaison à la base faite |
| Secrets | recherche de JWT, `sb_secret_`, URL avec mot de passe dans les fichiers modifiés/nouveaux | aucune occurrence | statique |
| `git diff --check` | `git diff --check` | aucune anomalie d'espace ; avertissements LF→CRLF de Git sur 3 fichiers déjà modifiés | statique |
| SQL, intégration, courses, `pg_net` | — | non exécutés | voir E |

### E. Éléments non exécutés
- Migration, activation, rollback et tous les `ci/*.sql` / `*.sh` ci-dessus : aucune base PostgreSQL disponible (Docker Desktop ne démarre pas, pas de PostgreSQL natif).
- Courses de concurrence (`race_dispatch_claim.sh`, `race_validated_vs_rejected.sh`, `rollback_assertions.sh`), injection de panne `pg_net`.
- Tests d'intégration (contrôlés, directs, automatiques) et trajet Storage → `pg_net` → Edge.
- Comportement réel de Storage sur `upsert`, valeur et stabilité de `storage.objects.version`, métadonnées provisoires/multipart.

### F. Risques résiduels
- **Hypothèses non vérifiées** : `version` identifie un envoi ; Storage écrit un remplacement en `INSERT … ON CONFLICT DO UPDATE` ; noms des triggers locaux ; route Kong ; propriété du schéma `net` pour le test de panne ; existence de la colonne `storage.objects.version` (l'activation échoue explicitement sinon).
- **Risques confirmés par lecture** : si `version`, eTag et taille sont identiques lors d'un remplacement, le trigger UPDATE ne se déclenche pas : l'objet reste `pending` (illisible) jusqu'à la reprise cron (≤ ~6 min), jamais validé à tort. Un rejeu de suppression peut, dans une fenêtre très courte, supprimer par nom un nouvel objet déposé entre la lecture de l'état et l'appel `remove` (l'état redevient `pending`, l'objet manque, la reprise le rejette : perte de disponibilité, pas d'exposition).
- **Blocages techniques** : Docker inaccessible ; configuration des projets distants non lue (limite de taille, MIME, `version`, triggers).
- **Décisions acceptées** : plafond 5 MiB ; marqueur d'activation et drapeau de ré-envoi modifiables par un accès base complet ; refus du rollback plutôt que restauration partielle.

### G. État du dépôt
- Branche : `security/F05-storage-hardening-20261010` (inchangée). Aucun remote configuré affiché par `git remote -v`.
- `git status --short` : 26 entrées avant et après (10 fichiers suivis modifiés, 16 entrées non suivies, dont des dossiers) ; fichiers non suivis individuels : 25 → 29 (ajout de `ci/idempotence_assertions.sql`, `ci/enqueue_failure_assertions.sql`, `ci/race_dispatch_claim.sh`, `ci/rollback_assertions.sh`).
- `git diff --stat` (fichiers suivis) : 10 fichiers, 647 insertions, 113 suppressions (avant : 625 / 113).
- Fichiers de ce lot modifiés ou créés : migration `20261010175125_…`, `f05_activate_storage_validation.sql`, `f05_rollback_storage_validation.sql`, `validate-file-upload/index.ts`, `.github/workflows/f05-storage-validation.yml`, `tests/storage-upload-contract.test.ts`, les 4 scripts CI ci-dessus, ce rapport. Les modifications web/mobile et les autres fichiers F05 n'ont pas été touchés par ce lot.
- Sauvegarde de sécurité hors dépôt prise avant intervention : diff des fichiers suivis et archive des fichiers non suivis dans le dossier temporaire de session. Aucun travail initial n'a été perdu (liste des fichiers non suivis avant/après comparée : uniquement des ajouts).

### H. Actions interdites non effectuées
Aucun commit, push, merge ni pull request ; aucun `reset`, `clean`, `stash` ; pas de changement de branche ni de remote ; rien copié vers le clone B ; aucun workflow GitHub Actions ni CI distante ; aucun accès en écriture à un projet Supabase distant ; aucun déploiement Edge ni changement Vercel ; aucune migration historique modifiée.

### I. Décision suivante (conditions vérifiables pour sortir de BLOCKED)
1. Obtenir une pile locale fonctionnelle (Docker ou équivalent) et y exécuter : migration + `ci/*.sql` + `race_*.sh` + `rollback_assertions.sh`, avec résultat positif observé ; si le test de panne `pg_net` affiche `ENQUEUE_FAILURE_TEST_SKIPPED`, le traiter comme non exécuté.
2. Exécuter les trois suites d'intégration, dont `storage-validation-automatic.test.ts` (trajet Storage → `pg_net` → Edge réel).
3. Observer le vrai comportement de `upsert` et de `storage.objects.version` ; ajuster la clé de génération si l'hypothèse est fausse.
4. Vérifier les paramètres des projets distants (§16.3).
Aucun transfert vers B ni lancement de CI n'est recommandé sans nouvelle autorisation explicite.

### J. Corrections de clôture de la section 18 (2026-10-11)

Statut : **BLOCKED** (inchangé). Aucun SQL ni test d'intégration exécuté (Docker : « Docker Desktop is unable to start »).

**J.1 Boucle des assertions SQL du workflow.**
- Chaque fichier de la boucle (`guard`, `state_machine`, `target`, `retry`, `idempotence`, `enqueue_failure`) n'était **pas** exécuté deux fois : une seule exécution par fichier. Les seules doubles exécutions sont `target_assertions.sql` et `guard_assertions.sql`, **rejouées volontairement après la réactivation** pour prouver la conservation des invariants ; un commentaire du workflow le dit désormais et un test textuel verrouille ce nombre.
- **Défaut réel trouvé et corrigé** : la boucle utilisait `psql … | tee`. Les étapes `run:` sans `shell:` explicite tournent en `bash -e` **sans `pipefail`** : un échec de `psql` (assertion, `ON_ERROR_STOP`) aurait été masqué par le code de sortie de `tee`, et l'étape aurait pu réussir malgré une assertion en échec. La boucle redirige maintenant la sortie vers `/tmp/ci-<fichier>.log`, teste le code de sortie de `psql`, **affiche le log puis s'arrête (`exit 1`)** à la première erreur. Les logs sont conservés.

**J.2 Conditions de réussite.**
- Aucune erreur SQL n'est absorbée : toutes les invocations `psql` portent `-v ON_ERROR_STOP=1`, les `DO` utilisent `assert`/`raise exception`, les scripts `.sh` utilisent `set -euo pipefail`.
- Le test de panne `pg_net` (`enqueue_failure_assertions.sql`) n'est exécuté que si le rôle CI possède le schéma `net` ; sinon il affiche `ENQUEUE_FAILURE_TEST_SKIPPED`. Le workflow émet alors `::warning::NOT EXECUTED - pg_net enqueue-failure assertions …` **et** écrit « NOT EXECUTED … This is not a pass » dans le résumé du job. Il ne compte pas comme un succès, mais ne fait pas échouer le job (limite d'environnement, pas un défaut du produit) : c'est une décision à confirmer si vous voulez qu'il échoue.
- **Défaut corrigé** : les suites d'intégration Vitest (`describe.skipIf`, `it.skipIf`) sortent en code 0 même si tous les tests sont ignorés (drapeau d'environnement manquant). Une étape « No skipped F05 integration test » lit les rapports JUnit `f05-controlled-junit.xml` et `f05-automatic-junit.xml`, **échoue** s'ils sont absents ou contiennent un `<skipped`.
- Ajout défensif : `sed -i 's/\r$//'` sur `supabase/activation/ci/*.sh` avant exécution (cette copie de travail Windows est en CRLF, `core.autocrlf=true`). `bash -n` des trois scripts passe une fois les CR retirés ; je n'ai pas vérifié, faute de dépôt cible, que les fichiers copiés vers B arrivent en LF.

**J.3 Tests ajoutés (textuels, exécutés)** dans `tests/storage-upload-contract.test.ts` : exécution unique par fichier dans la boucle, pas de `| tee` sur `psql`, arrêt à la première erreur, rejeu unique et documenté de `target`/`guard` après réactivation, présence du message `NOT EXECUTED`, de l'écriture dans `GITHUB_STEP_SUMMARY` et de l'étape « No skipped … ». Ces tests lisent le texte du workflow ; ils ne prouvent pas son comportement sur un runner.

**J.4 État du dépôt recalculé depuis la sortie réelle de `git status --short` (26 lignes).**
- Fichiers suivis modifiés (` M`) : **10**. Indexés (colonne 1) : **0**. Entrées non suivies (`??`) : **16** (dont les dossiers `docs/audits/`, `supabase/activation/`, `supabase/functions/validate-file-upload-v2/`), soit **29 fichiers non suivis** développés. Total 10 + 16 = 26 lignes. Les chiffres de §18-G (26 entrées, 25 → 29 fichiers non suivis, +647/−113) sont **confirmés** ; l'ancien « 25 entrées » ou « 625 insertions » dans les sections antérieures est obsolète.
- `git diff --stat` : 10 fichiers, 647 insertions, 113 suppressions. `git diff --check` : 0 anomalie. Branche inchangée.
- Contrôles de cette clôture : Vitest 16 fichiers / 186 tests verts (dont 52 dans `storage-upload-contract.test.ts`, textuels) ; `deno lint` + `deno check` des 10 fonctions Edge : 0 échec ; YAML chargé et `bash -n` de chacun des 23 scripts `run:` : 0 erreur ; recherche de secrets : aucune occurrence. Ces chiffres **remplacent** ceux du tableau D (184 tests, 50 textuels, 22 scripts).
