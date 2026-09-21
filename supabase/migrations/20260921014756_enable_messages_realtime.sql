-- Enable Supabase Postgres Changes for the chat message stream.
-- The application subscribes to INSERT events on public.messages.
alter publication supabase_realtime add table public.messages;
