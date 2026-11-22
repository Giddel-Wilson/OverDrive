ALTER TABLE public.share_links ADD COLUMN IF NOT EXISTS revocation_reason text;
-- Retire previously exhausted links once their admitted downloads have ended.
UPDATE public.share_links SET revoked_at = now(), revocation_reason = 'download_limit'
WHERE revoked_at IS NULL AND max_downloads IS NOT NULL AND download_count >= max_downloads
AND (download_grant_until IS NULL OR download_grant_until <= now());
