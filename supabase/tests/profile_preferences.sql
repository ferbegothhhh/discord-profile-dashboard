BEGIN;

DO $$
DECLARE
  role_name TEXT;
  table_name TEXT;
  statement TEXT;
BEGIN
  IF EXISTS (
    SELECT 1 FROM pg_class
    WHERE oid IN ('public.profile_backgrounds'::regclass, 'public.profile_preferences'::regclass)
      AND NOT relrowsecurity
  ) THEN
    RAISE EXCEPTION 'RLS must be enabled';
  END IF;
  IF EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conrelid IN ('public.profile_backgrounds'::regclass, 'public.profile_preferences'::regclass)
      AND NOT convalidated
  ) THEN
    RAISE EXCEPTION 'All constraints must be validated';
  END IF;
  IF EXISTS (SELECT 1 FROM public.profile_preferences
    WHERE user_id IN ('911111111111111111', '922222222222222222')) THEN
    RAISE EXCEPTION 'Test fixture user IDs already exist';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM public.profile_backgrounds
    WHERE id = 'sample-carbon' AND asset_key = id AND color = '#202024' AND is_active IS TRUE) THEN
    RAISE EXCEPTION 'Expected active carbon seed';
  END IF;
  FOREACH role_name IN ARRAY ARRAY['anon', 'authenticated'] LOOP
    FOREACH table_name IN ARRAY ARRAY['profile_backgrounds', 'profile_preferences'] LOOP
      FOREACH statement IN ARRAY ARRAY[
        format('SELECT * FROM public.%I', table_name),
        format('INSERT INTO public.%I DEFAULT VALUES', table_name),
        format('UPDATE public.%I SET %I = NULL WHERE false', table_name,
          CASE WHEN table_name = 'profile_backgrounds' THEN 'color' ELSE 'background_id' END),
        format('DELETE FROM public.%I WHERE false', table_name),
        format('TRUNCATE public.%I', table_name)
      ] LOOP
        EXECUTE format('SET LOCAL ROLE %I', role_name);
        BEGIN
          EXECUTE statement;
          RAISE EXCEPTION 'Unexpected access: %: %', role_name, statement;
        EXCEPTION WHEN insufficient_privilege THEN
          NULL;
        END;
        RESET ROLE;
      END LOOP;
      IF has_any_column_privilege(role_name, 'public.' || table_name, 'SELECT')
        OR has_any_column_privilege(role_name, 'public.' || table_name, 'INSERT')
        OR has_any_column_privilege(role_name, 'public.' || table_name, 'UPDATE')
        OR has_any_column_privilege(role_name, 'public.' || table_name, 'REFERENCES') THEN
        RAISE EXCEPTION 'Unexpected column grant for % on %', role_name, table_name;
      END IF;
    END LOOP;
  END LOOP;
  IF EXISTS (
    SELECT 1 FROM pg_class c
    CROSS JOIN LATERAL aclexplode(COALESCE(c.relacl, acldefault('r', c.relowner))) acl
    WHERE c.oid IN ('public.profile_backgrounds'::regclass, 'public.profile_preferences'::regclass)
      AND acl.grantee = 0
  ) OR EXISTS (
    SELECT 1 FROM pg_attribute a CROSS JOIN LATERAL aclexplode(a.attacl) acl
    WHERE a.attrelid IN ('public.profile_backgrounds'::regclass, 'public.profile_preferences'::regclass)
      AND acl.grantee = 0
  ) THEN
    RAISE EXCEPTION 'PUBLIC must not have profile privileges';
  END IF;
END;
$$;

SET LOCAL ROLE service_role;

INSERT INTO public.profile_preferences (user_id, guild_id, background_id) VALUES
('911111111111111111', '933333333333333333', 'sample-carbon'),
('911111111111111111', '944444444444444444', 'sample-carbon'),
('922222222222222222', '933333333333333333', 'sample-carbon');

INSERT INTO public.profile_preferences (user_id, guild_id, background_id)
VALUES ('911111111111111111', '933333333333333333', NULL)
ON CONFLICT (user_id, guild_id) DO UPDATE
SET background_id = EXCLUDED.background_id, updated_at = NOW();

DO $$
BEGIN
  IF (SELECT count(*) FROM public.profile_preferences
      WHERE user_id IN ('911111111111111111', '922222222222222222')) <> 3
    OR NOT EXISTS (SELECT 1 FROM public.profile_preferences
      WHERE user_id = '911111111111111111' AND guild_id = '933333333333333333' AND background_id IS NULL)
    OR (SELECT count(*) FROM public.profile_preferences
      WHERE ((user_id = '911111111111111111' AND guild_id = '944444444444444444')
        OR (user_id = '922222222222222222' AND guild_id = '933333333333333333'))
        AND background_id = 'sample-carbon') <> 2 THEN
    RAISE EXCEPTION 'Upsert/reset must preserve other users and guilds';
  END IF;
  BEGIN
    INSERT INTO public.profile_preferences (user_id, guild_id)
    VALUES ('911111111111111111', '933333333333333333');
    RAISE EXCEPTION 'Duplicate user/guild accepted';
  EXCEPTION WHEN unique_violation THEN NULL;
  END;
END;
$$;

DO $$
DECLARE
  invalid_id TEXT;
BEGIN
  FOREACH invalid_id IN ARRAY ARRAY['', 'abc', '012345678901234567', '1234567890123456', '123456789012345678901', '-12345678901234567'] LOOP
    BEGIN
      INSERT INTO public.profile_preferences (user_id, guild_id) VALUES (invalid_id, '933333333333333333');
      RAISE EXCEPTION 'Invalid user ID accepted: %', invalid_id;
    EXCEPTION WHEN check_violation THEN NULL;
    END;
    BEGIN
      INSERT INTO public.profile_preferences (user_id, guild_id) VALUES ('911111111111111111', invalid_id);
      RAISE EXCEPTION 'Invalid guild ID accepted: %', invalid_id;
    EXCEPTION WHEN check_violation THEN NULL;
    END;
  END LOOP;
  BEGIN
    INSERT INTO public.profile_preferences (user_id, guild_id) VALUES (NULL, '933333333333333333');
    RAISE EXCEPTION 'NULL user accepted';
  EXCEPTION WHEN not_null_violation THEN NULL;
  END;
  BEGIN
    INSERT INTO public.profile_preferences (user_id, guild_id) VALUES ('911111111111111111', NULL);
    RAISE EXCEPTION 'NULL guild accepted';
  EXCEPTION WHEN not_null_violation THEN NULL;
  END;
  BEGIN
    UPDATE public.profile_preferences SET background_id = 'missing-test-background'
    WHERE user_id = '911111111111111111';
    RAISE EXCEPTION 'Missing background accepted';
  EXCEPTION WHEN check_violation OR foreign_key_violation THEN NULL;
  END;
END;
$$;

RESET ROLE;
UPDATE public.profile_backgrounds SET is_active = false WHERE id = 'sample-carbon';
SET LOCAL ROLE service_role;
DO $$
BEGIN
  BEGIN
    UPDATE public.profile_preferences SET background_id = 'sample-carbon'
    WHERE user_id = '911111111111111111';
    RAISE EXCEPTION 'Inactive background accepted';
  EXCEPTION WHEN check_violation THEN NULL;
  END;
END;
$$;
RESET ROLE;
UPDATE public.profile_backgrounds SET is_active = true, asset_key = 'mismatched-test-asset' WHERE id = 'sample-carbon';
SET LOCAL ROLE service_role;
DO $$
BEGIN
  BEGIN
    UPDATE public.profile_preferences SET background_id = 'sample-carbon'
    WHERE user_id = '911111111111111111';
    RAISE EXCEPTION 'Mismatched asset accepted';
  EXCEPTION WHEN check_violation THEN NULL;
  END;
END;
$$;
RESET ROLE;
UPDATE public.profile_backgrounds SET asset_key = id, color = '#000000' WHERE id = 'sample-carbon';
SET LOCAL ROLE service_role;
DO $$
BEGIN
  BEGIN
    UPDATE public.profile_preferences SET background_id = 'sample-carbon'
    WHERE user_id = '911111111111111111';
    RAISE EXCEPTION 'Mismatched color accepted';
  EXCEPTION WHEN check_violation THEN NULL;
  END;
END;
$$;
RESET ROLE;
UPDATE public.profile_backgrounds SET color = '#202024' WHERE id = 'sample-carbon';

GRANT SELECT, INSERT, UPDATE, DELETE ON public.profile_backgrounds, public.profile_preferences TO anon, authenticated;
DO $$
DECLARE
  role_name TEXT;
  visible_rows BIGINT;
  affected_rows BIGINT;
BEGIN
  FOREACH role_name IN ARRAY ARRAY['anon', 'authenticated'] LOOP
    EXECUTE format('SET LOCAL ROLE %I', role_name);
    SELECT count(*) INTO visible_rows FROM public.profile_backgrounds;
    IF visible_rows <> 0 THEN RAISE EXCEPTION 'RLS exposed catalog to %', role_name; END IF;
    SELECT count(*) INTO visible_rows FROM public.profile_preferences;
    IF visible_rows <> 0 THEN RAISE EXCEPTION 'RLS exposed preferences to %', role_name; END IF;
    UPDATE public.profile_preferences SET background_id = NULL;
    GET DIAGNOSTICS affected_rows = ROW_COUNT;
    IF affected_rows <> 0 THEN RAISE EXCEPTION 'RLS allowed update by %', role_name; END IF;
    DELETE FROM public.profile_preferences;
    GET DIAGNOSTICS affected_rows = ROW_COUNT;
    IF affected_rows <> 0 THEN RAISE EXCEPTION 'RLS allowed delete by %', role_name; END IF;
    BEGIN
      INSERT INTO public.profile_preferences (user_id, guild_id)
      VALUES ('922222222222222222', '944444444444444444');
      RAISE EXCEPTION 'RLS allowed insert by %', role_name;
    EXCEPTION WHEN insufficient_privilege THEN NULL;
    END;
    RESET ROLE;
  END LOOP;
END;
$$;
REVOKE ALL ON public.profile_backgrounds, public.profile_preferences FROM anon, authenticated;

DELETE FROM public.profile_backgrounds WHERE id = 'sample-carbon';
SET LOCAL ROLE service_role;
DO $$
BEGIN
  IF (SELECT count(*) FROM public.profile_preferences
      WHERE user_id IN ('911111111111111111', '922222222222222222')) <> 3
    OR EXISTS (SELECT 1 FROM public.profile_preferences
      WHERE user_id IN ('911111111111111111', '922222222222222222') AND background_id IS NOT NULL) THEN
    RAISE EXCEPTION 'Background deletion must preserve preference rows and set background_id to NULL';
  END IF;
  DELETE FROM public.profile_preferences
  WHERE user_id = '911111111111111111' AND guild_id = '933333333333333333';
  IF (SELECT count(*) FROM public.profile_preferences
      WHERE user_id IN ('911111111111111111', '922222222222222222')) <> 2 THEN
    RAISE EXCEPTION 'Delete reset must preserve other users and guilds';
  END IF;
END;
$$;
RESET ROLE;

ROLLBACK;
