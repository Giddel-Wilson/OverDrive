-- Registration is public. Retire only obsolete signup data, preserving all
-- user accounts, storage limits and encrypted vault keys. Apply after the
-- updated application is serving production traffic.
DROP TABLE IF EXISTS public.invites;
ALTER TABLE public.users DROP COLUMN IF EXISTS invite_id;
