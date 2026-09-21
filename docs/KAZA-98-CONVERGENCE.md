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
| 5 | Chat temps réel | Oui | Oui | Oui | Oui | Oui | VERIFIED |
| 6 | Visites | Oui | Oui | Oui | Non: E2E placeholder | À reconfirmer | OPEN |
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
