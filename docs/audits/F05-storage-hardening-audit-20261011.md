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

## 13. Publication GitHub B

Cette copie du rapport est celle publiée avec la branche `security/F05-storage-hardening-20261011-ghb` ; le résultat de l'exécution CI est consigné dans le rapport tenu à jour hors dépôt (aucun second push n'est fait pour éviter une relance de la CI).
