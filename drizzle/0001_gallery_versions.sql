-- Additive migration for encrypted thumbnails and content version history.
-- Existing file ids, storage pointers, keys, ciphertext and metadata are preserved.
ALTER TABLE public.encrypted_files ADD COLUMN IF NOT EXISTS version_number integer NOT NULL DEFAULT 1;
ALTER TABLE public.encrypted_files ADD COLUMN IF NOT EXISTS content_updated_at timestamptz NOT NULL DEFAULT now();
ALTER TABLE public.encrypted_files ADD COLUMN IF NOT EXISTS replaces_file_id uuid REFERENCES public.encrypted_files(id) ON DELETE CASCADE;
ALTER TABLE public.encrypted_files ADD COLUMN IF NOT EXISTS base_version integer;
ALTER TABLE public.encrypted_files ADD COLUMN IF NOT EXISTS thumbnail_iv text;
ALTER TABLE public.encrypted_files ADD COLUMN IF NOT EXISTS thumbnail_sha256 text;
ALTER TABLE public.encrypted_files ADD COLUMN IF NOT EXISTS thumbnail_size_bytes integer NOT NULL DEFAULT 0;
UPDATE public.encrypted_files SET content_updated_at = created_at WHERE version_number = 1;

CREATE TABLE IF NOT EXISTS public.file_versions (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    file_id uuid NOT NULL REFERENCES public.encrypted_files(id) ON DELETE CASCADE,
    version_number integer NOT NULL,
    storage_key text NOT NULL,
    storage_provider text NOT NULL,
    ciphertext_size_bytes bigint NOT NULL,
    file_algo public.file_algo NOT NULL,
    file_iv text NOT NULL,
    file_auth_tag text,
    chunked boolean NOT NULL,
    chunk_size_bytes integer NOT NULL,
    wrapped_file_key text NOT NULL,
    key_algo public.key_algo NOT NULL,
    key_wrap_iv text,
    key_wrap_ephemeral_public_key_jwk jsonb,
    total_chunks integer NOT NULL,
    ciphertext_sha256 text NOT NULL,
    thumbnail_iv text,
    thumbnail_sha256 text,
    thumbnail_size_bytes integer NOT NULL DEFAULT 0,
    metadata_blob text NOT NULL,
    metadata_iv text NOT NULL,
    metadata_algo public.file_algo NOT NULL,
    strength_score integer NOT NULL,
    strength_label text NOT NULL,
    created_at timestamptz NOT NULL,
    archived_at timestamptz NOT NULL DEFAULT now(),
    purging_at timestamptz
);

ALTER TABLE public.share_links ADD COLUMN IF NOT EXISTS version_id uuid REFERENCES public.file_versions(id) ON DELETE SET NULL;
ALTER TABLE public.share_links ADD COLUMN IF NOT EXISTS download_grant_until timestamptz;
CREATE INDEX IF NOT EXISTS encrypted_files_storage_idx ON public.encrypted_files(storage_key);
CREATE INDEX IF NOT EXISTS encrypted_files_replacement_idx ON public.encrypted_files(replaces_file_id);
CREATE INDEX IF NOT EXISTS file_versions_file_idx ON public.file_versions(file_id, version_number);
CREATE INDEX IF NOT EXISTS file_versions_storage_idx ON public.file_versions(storage_key);
