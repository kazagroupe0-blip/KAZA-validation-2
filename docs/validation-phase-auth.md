# Auth profile resilience validation

Validation marker only. The product change under test is limited to `apps/web/src/lib/auth-context.tsx`.

Expected invariant: a validated Supabase session is not destroyed by a transient profile read failure.
