/**
 * Slug versionné pour la bascule sans fenêtre de régression : il exécute le même
 * gestionnaire que validate-file-upload, mais peut être déployé (verify_jwt = false,
 * secret dédié) pendant que l'ancien slug et son déclencheur legacy (Bearer JWT)
 * restent en service. À supprimer avec l'ancien chemin une fois la bascule validée.
 */
import '../validate-file-upload/index.ts';
