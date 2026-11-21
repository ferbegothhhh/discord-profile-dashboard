BEGIN;

LOCK TABLE public.profile_backgrounds, public.profile_preferences IN ACCESS EXCLUSIVE MODE;

ALTER TABLE public.profile_backgrounds
  ADD COLUMN kind TEXT NOT NULL DEFAULT 'solid',
  ADD COLUMN visibility TEXT NOT NULL DEFAULT 'catalog',
  ADD COLUMN owner_user_id TEXT,
  ADD COLUMN owner_guild_id TEXT,
  ADD COLUMN slot_number INTEGER,
  ADD COLUMN status TEXT NOT NULL DEFAULT 'ready',
  ADD COLUMN object_key TEXT,
  ADD COLUMN revision INTEGER NOT NULL DEFAULT 1,
  ADD COLUMN mime TEXT,
  ADD COLUMN width INTEGER,
  ADD COLUMN height INTEGER,
  ADD COLUMN byte_size BIGINT;

ALTER TABLE public.profile_backgrounds ALTER COLUMN asset_key DROP NOT NULL;

ALTER TABLE public.profile_backgrounds
  ADD CONSTRAINT profile_backgrounds_kind_check CHECK (kind IN ('solid', 'image')),
  ADD CONSTRAINT profile_backgrounds_visibility_check CHECK (visibility IN ('catalog', 'private')),
  ADD CONSTRAINT profile_backgrounds_status_check CHECK (status IN ('processing', 'ready', 'failed')),
  ADD CONSTRAINT profile_backgrounds_revision_check CHECK (revision > 0),
  ADD CONSTRAINT profile_backgrounds_ownership_check CHECK (
    (visibility = 'catalog' AND owner_user_id IS NULL AND owner_guild_id IS NULL AND slot_number IS NULL)
    OR (visibility = 'private' AND kind = 'image'
      AND owner_user_id IS NOT NULL AND owner_user_id ~ '^[1-9][0-9]{16,19}$'
      AND owner_guild_id IS NOT NULL AND owner_guild_id ~ '^[1-9][0-9]{16,19}$'
      AND slot_number IS NOT NULL AND slot_number BETWEEN 1 AND 3)
  ),
  ADD CONSTRAINT profile_backgrounds_shape_check CHECK (
    (kind = 'solid' AND visibility = 'catalog' AND status = 'ready'
      AND asset_key IS NOT NULL AND object_key IS NULL AND mime IS NULL
      AND width IS NULL AND height IS NULL AND byte_size IS NULL)
    OR (kind = 'image' AND asset_key IS NULL AND color IS NULL
      AND object_key IS NOT NULL
      AND object_key ~ '^profile-images/[a-f0-9]{32}\.(png|jpg|webp)$'
      AND (mime IS NULL OR mime IN ('image/png', 'image/jpeg', 'image/webp'))
      AND (width IS NULL OR width > 0)
      AND (height IS NULL OR height > 0)
      AND (byte_size IS NULL OR byte_size > 0)
      AND (status <> 'ready' OR (mime IS NOT NULL AND width IS NOT NULL
        AND height IS NOT NULL AND byte_size IS NOT NULL)))
  );

CREATE UNIQUE INDEX profile_backgrounds_private_slot_key
  ON public.profile_backgrounds (owner_user_id, owner_guild_id, slot_number)
  WHERE visibility = 'private';
CREATE UNIQUE INDEX profile_backgrounds_object_key_key
  ON public.profile_backgrounds (object_key) WHERE object_key IS NOT NULL;

CREATE OR REPLACE FUNCTION public.validate_profile_background() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
BEGIN
  IF NEW.background_id IS NOT NULL THEN
    PERFORM 1 FROM public.profile_backgrounds
    WHERE id = NEW.background_id AND is_active IS TRUE AND status = 'ready'
      AND ((kind = 'solid' AND visibility = 'catalog' AND asset_key = id
        AND ((id = 'sample-carbon' AND color = '#202024')
          OR (id = 'sample-graphite' AND color = '#343438')
          OR (id = 'sample-plum' AND color = '#352442')
          OR (id = 'sample-violet' AND color = '#493260')))
        OR (kind = 'image' AND (visibility = 'catalog'
          OR (visibility = 'private' AND owner_user_id = NEW.user_id
            AND owner_guild_id = NEW.guild_id))))
    FOR SHARE;
    IF NOT FOUND THEN
      RAISE EXCEPTION 'Background unavailable' USING ERRCODE = '23514';
    END IF;
  END IF;
  RETURN NEW;
END;
$$;
REVOKE ALL ON FUNCTION public.validate_profile_background() FROM PUBLIC, anon, authenticated;
DROP TRIGGER IF EXISTS validate_profile_background ON public.profile_preferences;
CREATE TRIGGER validate_profile_background
BEFORE INSERT OR UPDATE OF background_id, user_id, guild_id ON public.profile_preferences
FOR EACH ROW EXECUTE FUNCTION public.validate_profile_background();

ALTER TABLE public.profile_backgrounds ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.profile_preferences ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.profile_backgrounds, public.profile_preferences FROM PUBLIC, anon, authenticated;
DO $$
DECLARE
  item RECORD;
BEGIN
  FOR item IN
    SELECT c.relname, a.attname FROM pg_attribute a
    JOIN pg_class c ON c.oid = a.attrelid
    WHERE c.oid IN ('public.profile_backgrounds'::regclass, 'public.profile_preferences'::regclass)
      AND a.attnum > 0 AND NOT a.attisdropped
  LOOP
    EXECUTE format('REVOKE ALL (%I) ON public.%I FROM PUBLIC, anon, authenticated', item.attname, item.relname);
  END LOOP;
END;
$$;
GRANT SELECT, INSERT, UPDATE, DELETE ON public.profile_backgrounds, public.profile_preferences TO service_role;

COMMIT;
