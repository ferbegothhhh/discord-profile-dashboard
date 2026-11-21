BEGIN;

ALTER TABLE public.profile_backgrounds ADD COLUMN IF NOT EXISTS color TEXT DEFAULT '#202024';
ALTER TABLE public.profile_backgrounds ADD COLUMN IF NOT EXISTS category TEXT DEFAULT 'Lainnya';
ALTER TABLE public.profile_backgrounds ADD COLUMN IF NOT EXISTS is_active BOOLEAN DEFAULT true;
ALTER TABLE public.profile_backgrounds ADD COLUMN IF NOT EXISTS created_at TIMESTAMPTZ DEFAULT NOW();
ALTER TABLE public.profile_preferences ADD COLUMN IF NOT EXISTS updated_at TIMESTAMPTZ DEFAULT NOW();

LOCK TABLE public.profile_backgrounds, public.profile_preferences IN ACCESS EXCLUSIVE MODE;

DO $$
DECLARE
  expected RECORD;
  item RECORD;
  background_column SMALLINT;
  user_column SMALLINT;
  guild_column SMALLINT;
BEGIN
  FOR expected IN
    SELECT * FROM (VALUES
      ('profile_backgrounds', 'id', 'text'),
      ('profile_backgrounds', 'name', 'text'),
      ('profile_backgrounds', 'asset_key', 'text'),
      ('profile_backgrounds', 'color', 'text'),
      ('profile_backgrounds', 'category', 'text'),
      ('profile_backgrounds', 'is_active', 'boolean'),
      ('profile_backgrounds', 'created_at', 'timestamp with time zone'),
      ('profile_preferences', 'user_id', 'text'),
      ('profile_preferences', 'guild_id', 'text'),
      ('profile_preferences', 'background_id', 'text'),
      ('profile_preferences', 'updated_at', 'timestamp with time zone')
    ) AS columns(table_name, column_name, type_name)
  LOOP
    IF NOT EXISTS (
      SELECT 1 FROM pg_attribute a
      JOIN pg_class c ON c.oid = a.attrelid
      JOIN pg_namespace n ON n.oid = c.relnamespace
      WHERE n.nspname = 'public' AND c.relname = expected.table_name
        AND c.relkind = 'r' AND NOT c.relispartition
        AND a.attname = expected.column_name AND NOT a.attisdropped
        AND a.atttypid = expected.type_name::regtype
        AND a.attgenerated = '' AND a.attidentity = ''
    ) THEN
      RAISE EXCEPTION 'Unsupported schema: %.% must be an ordinary % column',
        expected.table_name, expected.column_name, expected.type_name;
    END IF;
  END LOOP;

  IF EXISTS (
    SELECT 1 FROM pg_policy
    WHERE polrelid IN ('public.profile_backgrounds'::regclass, 'public.profile_preferences'::regclass)
      AND NOT (polrelid = 'public.profile_backgrounds'::regclass
        AND polname = 'Allow public read on backgrounds')
  ) THEN
    RAISE EXCEPTION 'Unsupported schema: unexpected profile RLS policy';
  END IF;

  SELECT attnum INTO user_column FROM pg_attribute
    WHERE attrelid = 'public.profile_preferences'::regclass AND attname = 'user_id';
  SELECT attnum INTO guild_column FROM pg_attribute
    WHERE attrelid = 'public.profile_preferences'::regclass AND attname = 'guild_id';
  SELECT attnum INTO background_column FROM pg_attribute
    WHERE attrelid = 'public.profile_preferences'::regclass AND attname = 'background_id';

  IF EXISTS (
    SELECT 1 FROM pg_index
    WHERE indrelid = 'public.profile_preferences'::regclass AND indisunique
      AND (indnkeyatts <> 2 OR indexprs IS NOT NULL OR indpred IS NOT NULL
        OR NOT (indkey[0] IN (user_column, guild_column)
          AND indkey[1] IN (user_column, guild_column)
          AND indkey[0] <> indkey[1]))
  ) THEN
    RAISE EXCEPTION 'Unsupported schema: preferences uniqueness must use only user_id and guild_id';
  END IF;

  ALTER TABLE public.profile_backgrounds ALTER COLUMN id SET NOT NULL;
  ALTER TABLE public.profile_backgrounds ALTER COLUMN name SET NOT NULL;
  ALTER TABLE public.profile_backgrounds ALTER COLUMN asset_key SET NOT NULL;
  ALTER TABLE public.profile_preferences ALTER COLUMN user_id SET NOT NULL;
  ALTER TABLE public.profile_preferences ALTER COLUMN guild_id SET NOT NULL;
  ALTER TABLE public.profile_preferences ALTER COLUMN background_id DROP NOT NULL;

  IF NOT EXISTS (
    SELECT 1 FROM pg_index
    WHERE indrelid = 'public.profile_preferences'::regclass AND indisunique
      AND indisvalid AND indisready AND indimmediate
      AND indnkeyatts = 2 AND indpred IS NULL AND indexprs IS NULL
      AND indkey[0] IN (user_column, guild_column)
      AND indkey[1] IN (user_column, guild_column) AND indkey[0] <> indkey[1]
  ) THEN
    ALTER TABLE public.profile_preferences
      ADD CONSTRAINT profile_preferences_user_guild_key UNIQUE (user_id, guild_id);
  END IF;

  FOR item IN
    SELECT conname, conkey, confrelid, confkey FROM pg_constraint
    WHERE conrelid = 'public.profile_preferences'::regclass AND contype = 'f'
  LOOP
    IF item.conkey <> ARRAY[background_column]::SMALLINT[]
      OR item.confrelid <> 'public.profile_backgrounds'::regclass
      OR item.confkey <> ARRAY[(SELECT attnum FROM pg_attribute
        WHERE attrelid = 'public.profile_backgrounds'::regclass AND attname = 'id')]::SMALLINT[] THEN
      RAISE EXCEPTION 'Unsupported schema: unexpected preferences foreign key %', item.conname;
    END IF;
    EXECUTE format('ALTER TABLE public.profile_preferences DROP CONSTRAINT %I', item.conname);
  END LOOP;

  ALTER TABLE public.profile_preferences ADD CONSTRAINT profile_preferences_background_id_fkey
    FOREIGN KEY (background_id) REFERENCES public.profile_backgrounds(id) ON DELETE SET NULL;
END;
$$;

ALTER TABLE public.profile_backgrounds ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.profile_preferences ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "Allow public read on backgrounds" ON public.profile_backgrounds;
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

GRANT SELECT ON public.profile_backgrounds TO service_role;
GRANT SELECT, INSERT, UPDATE, DELETE ON public.profile_preferences TO service_role;

ALTER TABLE public.profile_preferences DROP CONSTRAINT IF EXISTS profile_preferences_user_id_check;
ALTER TABLE public.profile_preferences ADD CONSTRAINT profile_preferences_user_id_check CHECK (user_id ~ '^[1-9][0-9]{16,19}$');
ALTER TABLE public.profile_preferences DROP CONSTRAINT IF EXISTS profile_preferences_guild_id_check;
ALTER TABLE public.profile_preferences ADD CONSTRAINT profile_preferences_guild_id_check CHECK (guild_id ~ '^[1-9][0-9]{16,19}$');

DO $$
DECLARE
  item RECORD;
BEGIN
  IF EXISTS (
    SELECT 1 FROM public.profile_preferences p
    LEFT JOIN public.profile_backgrounds b ON b.id = p.background_id
    WHERE p.background_id IS NOT NULL AND NOT COALESCE(
      b.is_active IS TRUE AND b.asset_key = b.id
      AND ((b.id = 'sample-carbon' AND b.color = '#202024')
        OR (b.id = 'sample-graphite' AND b.color = '#343438')
        OR (b.id = 'sample-plum' AND b.color = '#352442')
        OR (b.id = 'sample-violet' AND b.color = '#493260')), false)
  ) THEN
    RAISE EXCEPTION 'Invalid existing data: unavailable preference background';
  END IF;
  FOR item IN
    SELECT conrelid::regclass AS table_name, conname FROM pg_constraint
    WHERE conrelid IN ('public.profile_backgrounds'::regclass, 'public.profile_preferences'::regclass)
      AND NOT convalidated
  LOOP
    EXECUTE format('ALTER TABLE %s VALIDATE CONSTRAINT %I', item.table_name, item.conname);
  END LOOP;
END;
$$;

CREATE OR REPLACE FUNCTION public.validate_profile_background() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
BEGIN
  IF NEW.background_id IS NOT NULL THEN
    PERFORM 1 FROM public.profile_backgrounds
    WHERE id = NEW.background_id AND is_active IS TRUE AND asset_key = id
      AND ((id = 'sample-carbon' AND color = '#202024')
        OR (id = 'sample-graphite' AND color = '#343438')
        OR (id = 'sample-plum' AND color = '#352442')
        OR (id = 'sample-violet' AND color = '#493260'))
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
CREATE TRIGGER validate_profile_background BEFORE INSERT OR UPDATE OF background_id ON public.profile_preferences
FOR EACH ROW EXECUTE FUNCTION public.validate_profile_background();

COMMIT;
