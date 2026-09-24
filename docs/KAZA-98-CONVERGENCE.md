# KAZA — Matrice de convergence vers 98%+

> Référence: branche `main` après fusion de PR #18.
> Objectif: supprimer les zones d'ombre entre code, DB, sécurité, tests,
> production et promesses produit.

## Règle de validation

Une fonction n'est `VERIFIED` que si les six couches sont cohérentes:
1. métier
2. UI/API
3. DB/RPC
4. sécurité
5. test réel
6. production

Aucun placeholder, mock de complaisance, échec silencieux d'une mutation
métier ou divergence connue code/production ne peut être considéré comme
une validation finale.

## Matrice actuelle

| # | Domaine | Code | DB/API | Sécurité | Test réel | Production | État |
|---|---|---|---|---|---|---|---|
| 1 | Auth Web / profils | Oui | Oui | Oui | Oui | Oui | VERIFIED |
| 2 | Recherche / détail résidence | Oui | Oui | Oui | Oui | Oui | VERIFIED |
| 3 | Modération / revalidation | Oui | Oui | Oui | Oui | Oui | VERIFIED |
| 4 | Contact / conversation | Oui | Oui | Oui | Oui | Oui | VERIFIED |
| 5 | Chat temps réel | Corrigé (C1) | Oui | Oui | Faux vert historique ; nouvelle preuve à rejouer en CI | Non vérifié | FIXED — UNVERIFIED |
| 6 | Visites | Oui (C1 corrigé) | Oui | SECURITY-1 ouvert | E2E réel, échec C1 au run 35791598908 ; correctif à valider en CI | À reconfirmer | OPEN |
| 7 | Baux / cycle occupation | Oui | Oui | Oui | Intégration réelle | Oui | OPEN |
| 8 | Paiement espèces | Oui | Oui | Oui | Oui | Oui | VERIFIED |
| 9 | FedaPay / webhook | Oui | Oui | Oui | Partiel | Partiel | OPEN |
| 10 | Quittances / signature | Oui | Oui | Oui | Oui | Oui | VERIFIED |
| 11 | Impayés / relances | Oui | Oui | Oui | Intégration | Oui | OPEN |
| 12 | Dépenses CRUD | Oui | Oui | Oui | Intégration | Oui | OPEN |
| 13 | Justificatifs dépenses | Partiel | Bucket oui | Policies incomplètes | Non | Partiel | OPEN |
| 14 | Cashflow | Oui | Oui | Oui | Intégration | Oui | OPEN |
| 15 | Reversements bailleur | Oui | Oui | Oui | Partiel | Pipeline actif | OPEN |
| 16 | Notifications / push | Oui | Oui | Oui | Partiel | Oui | OPEN |
| 17 | Administration / audit | Oui | Oui | Oui | Partiel | Oui | OPEN |
| 18 | Maintenance / unités / rentabilité / reporting patrimonial | Partiel ou absent | Partiel ou absent | À concevoir | Non | Non | ROADMAP |

## Journal des constats

### C1 — filtre Realtime littéral dans le chat (cause racine de l'échec E2E visites)

- **Constat** : `chat-window.tsx` construisait le channel et les filtres avec
  `\${id}` échappé ; le serveur recevait le texte `${id}` au lieu de l'UUID.
- **Preuve** : run CI 35791598908 (sondes isolées, branche de diagnostic ;
  résultats analysés en revue) — `system` error 22P02
  `invalid input syntax for type uuid: "${id}"` pour les configurations au
  filtre actuel, aucun événement ; événements reçus avec l'UUID réel.
- **Conséquence** : le ChatWindow ne recevait aucun message ni changement de
  visite en temps réel, y compris sur `main`. `chat.spec` restait vert car
  `getByText` trouvait la réponse dans l'aperçu de la liste latérale
  (channel `conversations-live`, sans filtre) : faux vert pour le fil.
- **Hypothèse C1a** (binding visits perturbant le channel) : RÉFUTÉE.
- **Correctif** : interpolation corrigée ; erreurs `system` de souscription
  exposées dans `realtime-status` (`data-error`) au lieu d'un faux
  « connected » ; preuves ajoutées (join filtré par UUID, aucune erreur
  `system`, réponse visible dans le fil).
- **État** : FIXED — UNVERIFIED tant que visits/chat E2E ne sont pas verts en
  CI sur la branche.
- **Risque test identifié** : l'assertion existante
  `tenant.getByText(landlordMessage)` de `chat.spec` devient ambiguë (fil +
  aperçu latéral, mode strict Playwright). Modification soumise à validation.

### SECURITY-1 — contournement de `propose_visit()` (OUVERT, non traité)

Un locataire participant peut insérer directement dans `visits` (policy
`visits_insert_tenant`) des créneaux passés, trop longs, inversés,
chevauchants, sur un bien non libre, en doublon de proposition active, sans
message ni notification, voire avec `status='confirmed'`. `confirm_visit`
accepte aussi un créneau passé et un bien non libre. Mesuré en SQL sous RLS
(Phase 0) ; correction par migration forward-only à planifier séparément.

## Portes de sortie

### Gate P0 — Confiance technique
- Aucun test placeholder.
- Aucun échec silencieux sur une mutation métier.
- Aucune divergence connue sur les workflows critiques.
- CI verte: lint, typecheck, unit, integration, E2E, Edge, audit.

### Gate P1 — Confiance produit
- Visites E2E réelles.
- Justificatifs dépenses complets.
- Notifications/push prouvés.
- FedaPay et reversement testés sur leurs états critiques.

### Gate P2 — Profondeur Landlord OS
- Immeubles -> unités -> baux.
- Maintenance.
- Rentabilité.
- Reporting.
- Échéancier/calendrier central.

### Gate final — 98%+
Toutes les promesses majeures retenues pour le produit doivent disposer
d'une preuve traçable dans cette matrice, sans anomalie critique connue.


<!-- validation-trigger: migration reset fix 2026-09-24 -->