-- Stable browser identity and token generations. Existing sessions remain
-- valid until they are adopted or explicitly retired by the signed-in owner.
ALTER TABLE public.sessions ADD COLUMN IF NOT EXISTS device_id uuid;
ALTER TABLE public.sessions ADD COLUMN IF NOT EXISTS token_version integer NOT NULL DEFAULT 1;
CREATE UNIQUE INDEX IF NOT EXISTS sessions_user_device_unique ON public.sessions(user_id, device_id);
