BEGIN;

DO $$
DECLARE
  role_name TEXT;
  table_name TEXT;
BEGIN
  IF EXISTS (SELECT 1 FROM public.profile_preferences
    WHERE user_id IN ('955555555555555555', '966666666666666666'))
    OR EXISTS (SELECT 1 FROM public.profile_backgrounds WHERE id LIKE 'test-image-%') THEN
    RAISE EXCEPTION 'Image test fixtures already exist';
  END IF;
  IF (SELECT count(*) FROM public.profile_backgrounds
    WHERE id IN ('sample-carbon', 'sample-graphite', 'sample-plum', 'sample-violet')
      AND kind = 'solid' AND visibility = 'catalog' AND status = 'ready'
      AND owner_user_id IS NULL AND owner_guild_id IS NULL AND slot_number IS NULL
      AND object_key IS NULL AND revision = 1 AND asset_key = id) <> 4 THEN
    RAISE EXCEPTION 'Solid catalog backfill missing';
  END IF;
  IF EXISTS (SELECT 1 FROM pg_constraint
    WHERE conrelid IN ('public.profile_backgrounds'::regclass, 'public.profile_preferences'::regclass)
      AND NOT convalidated) THEN
    RAISE EXCEPTION 'Constraints must be validated';
  END IF;
  IF EXISTS (SELECT 1 FROM pg_class
    WHERE oid IN ('public.profile_backgrounds'::regclass, 'public.profile_preferences'::regclass)
      AND NOT relrowsecurity)
    OR EXISTS (SELECT 1 FROM pg_policy
      WHERE polrelid IN ('public.profile_backgrounds'::regclass, 'public.profile_preferences'::regclass)
         AND NOT (polroles = ARRAY['profile_dashboard'::regrole::oid]
           AND polpermissive
           AND ((polrelid = 'public.profile_backgrounds'::regclass AND polname = 'profile_dashboard_background_read' AND polcmd = 'r')
             OR (polrelid = 'public.profile_preferences'::regclass AND (polname, polcmd) IN (
               ('profile_dashboard_preference_select', 'r'), ('profile_dashboard_preference_insert', 'a'),
               ('profile_dashboard_preference_update', 'w'), ('profile_dashboard_preference_delete', 'd')))))) THEN
    RAISE EXCEPTION 'Profile tables must have backend-only RLS';
  END IF;
  FOREACH role_name IN ARRAY ARRAY['anon', 'authenticated'] LOOP
    FOREACH table_name IN ARRAY ARRAY['profile_backgrounds', 'profile_preferences'] LOOP
      IF has_table_privilege(role_name, 'public.' || table_name, 'SELECT,INSERT,UPDATE,DELETE,TRUNCATE,REFERENCES,TRIGGER')
        OR has_any_column_privilege(role_name, 'public.' || table_name, 'SELECT,INSERT,UPDATE,REFERENCES') THEN
        RAISE EXCEPTION 'Unexpected access for % on %', role_name, table_name;
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
    RAISE EXCEPTION 'PUBLIC must not have table or column grants';
  END IF;
END;
$$;

SET LOCAL ROLE service_role;

INSERT INTO public.profile_backgrounds
  (id, name, kind, visibility, owner_user_id, owner_guild_id, slot_number,
    status, asset_key, color, object_key, mime, width, height, byte_size)
VALUES
  ('test-image-private', 'Private ready', 'image', 'private', '955555555555555555', '977777777777777777', 1,
    'ready', NULL, NULL, 'profile-images/aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa.png', 'image/png', 1200, 600, 10000),
  ('test-image-processing', 'Private processing', 'image', 'private', '955555555555555555', '977777777777777777', 2,
    'processing', NULL, NULL, 'profile-images/bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb.webp', NULL, NULL, NULL, NULL),
  ('test-image-failed', 'Private failed', 'image', 'private', '955555555555555555', '977777777777777777', 3,
    'failed', NULL, NULL, 'profile-images/cccccccccccccccccccccccccccccccc.jpg', NULL, NULL, NULL, NULL),
  ('test-image-catalog', 'Catalog ready', 'image', 'catalog', NULL, NULL, NULL,
    'ready', NULL, NULL, 'profile-images/dddddddddddddddddddddddddddddddd.webp', 'image/webp', 1200, 600, 10000),
  ('test-image-other-user', 'Other owner', 'image', 'private', '966666666666666666', '977777777777777777', 1,
    'ready', NULL, NULL, 'profile-images/eeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee.png', 'image/png', 1200, 600, 10000),
  ('test-image-other-guild', 'Other guild', 'image', 'private', '955555555555555555', '988888888888888888', 1,
    'ready', NULL, NULL, 'profile-images/ffffffffffffffffffffffffffffffff.png', 'image/png', 1200, 600, 10000);

INSERT INTO public.profile_preferences (user_id, guild_id, background_id)
VALUES ('955555555555555555', '977777777777777777', 'test-image-private');

DO $$
DECLARE
  statement TEXT;
  background TEXT;
BEGIN
  IF NOT EXISTS (SELECT 1 FROM public.profile_preferences
    WHERE user_id = '955555555555555555' AND guild_id = '977777777777777777'
      AND background_id = 'test-image-private') THEN
    RAISE EXCEPTION 'Owner must be able to select ready private image';
  END IF;
  FOREACH statement IN ARRAY ARRAY[
    'INSERT INTO public.profile_preferences VALUES (''966666666666666666'', ''977777777777777777'', ''test-image-private'', NOW())',
    'INSERT INTO public.profile_preferences VALUES (''955555555555555555'', ''988888888888888888'', ''test-image-private'', NOW())',
    'UPDATE public.profile_preferences SET user_id = ''966666666666666666'' WHERE background_id = ''test-image-private''',
    'UPDATE public.profile_preferences SET guild_id = ''988888888888888888'' WHERE background_id = ''test-image-private''',
    'UPDATE public.profile_preferences SET user_id = ''966666666666666666'', guild_id = ''988888888888888888'' WHERE background_id = ''test-image-private'''
  ] LOOP
    BEGIN
      EXECUTE statement;
      RAISE EXCEPTION 'Ownership bypass accepted: %', statement;
    EXCEPTION WHEN check_violation THEN NULL;
    END;
  END LOOP;
  FOREACH background IN ARRAY ARRAY['test-image-other-user', 'test-image-other-guild', 'test-image-processing', 'test-image-failed'] LOOP
    BEGIN
      UPDATE public.profile_preferences SET background_id = background
      WHERE user_id = '955555555555555555' AND guild_id = '977777777777777777';
      RAISE EXCEPTION 'Unavailable image accepted: %', background;
    EXCEPTION WHEN check_violation THEN NULL;
    END;
  END LOOP;
  FOREACH background IN ARRAY ARRAY['test-image-catalog', 'sample-carbon', 'sample-graphite', 'sample-plum', 'sample-violet', 'test-image-private'] LOOP
    UPDATE public.profile_preferences SET background_id = background
    WHERE user_id = '955555555555555555' AND guild_id = '977777777777777777';
    IF NOT FOUND THEN RAISE EXCEPTION 'Preference fixture missing'; END IF;
  END LOOP;
END;
$$;

DO $$
DECLARE
  mutation TEXT;
BEGIN
  FOREACH mutation IN ARRAY ARRAY[
    'kind = ''unknown''',
    'visibility = ''public''',
    'status = ''unknown''',
    'owner_user_id = NULL',
    'owner_guild_id = NULL',
    'owner_user_id = ''bad''',
    'owner_guild_id = ''012345678901234567''',
    'slot_number = NULL',
    'slot_number = 0',
    'slot_number = 4',
    'revision = 0',
    'revision = -1',
    'object_key = NULL',
    'object_key = ''https://example.invalid/image.png''',
    'object_key = ''profile-images/../image.png''',
    'object_key = ''profile-images/not-random.png''',
    'asset_key = ''external-image''',
    'color = ''#202024''',
    'mime = NULL',
    'mime = ''image/svg+xml''',
    'width = NULL',
    'height = NULL',
    'byte_size = NULL',
    'width = 0',
    'height = -1',
    'byte_size = 0',
    'visibility = ''catalog'''
  ] LOOP
    BEGIN
      EXECUTE 'UPDATE public.profile_backgrounds SET ' || mutation || ' WHERE id = ''test-image-private''';
      RAISE EXCEPTION 'Invalid image shape accepted: %', mutation;
    EXCEPTION WHEN check_violation THEN NULL;
    END;
  END LOOP;
  BEGIN
    UPDATE public.profile_backgrounds SET revision = NULL WHERE id = 'test-image-private';
    RAISE EXCEPTION 'NULL revision accepted';
  EXCEPTION WHEN not_null_violation THEN NULL;
  END;
  FOREACH mutation IN ARRAY ARRAY['status = ''processing''', 'object_key = ''profile-images/11111111111111111111111111111111.png''', 'asset_key = NULL', 'visibility = ''private'''] LOOP
    BEGIN
      EXECUTE 'UPDATE public.profile_backgrounds SET ' || mutation || ' WHERE id = ''sample-carbon''';
      RAISE EXCEPTION 'Invalid solid shape accepted: %', mutation;
    EXCEPTION WHEN check_violation THEN NULL;
    END;
  END LOOP;
  FOREACH mutation IN ARRAY ARRAY['slot_number = 1', 'slot_number = 2', 'slot_number = 3'] LOOP
    BEGIN
      EXECUTE 'UPDATE public.profile_backgrounds SET ' || mutation || ' WHERE id = ''test-image-other-user''';
      UPDATE public.profile_backgrounds SET owner_user_id = '955555555555555555'
      WHERE id = 'test-image-other-user';
      RAISE EXCEPTION 'Reserved slot reused: %', mutation;
    EXCEPTION WHEN unique_violation THEN NULL;
    END;
  END LOOP;
  BEGIN
    UPDATE public.profile_backgrounds SET object_key = 'profile-images/aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa.png'
    WHERE id = 'test-image-other-user';
    RAISE EXCEPTION 'Duplicate object key accepted';
  EXCEPTION WHEN unique_violation THEN NULL;
  END;
END;
$$;

DO $$
DECLARE
  mutation TEXT;
BEGIN
  FOREACH mutation IN ARRAY ARRAY['is_active = false', 'status = ''processing''', 'status = ''failed'''] LOOP
    BEGIN
      EXECUTE 'UPDATE public.profile_backgrounds SET ' || mutation || ' WHERE id = ''test-image-catalog''';
      UPDATE public.profile_preferences SET background_id = 'test-image-catalog'
      WHERE user_id = '955555555555555555' AND guild_id = '977777777777777777';
      RAISE EXCEPTION 'Unavailable catalog image accepted: %', mutation;
    EXCEPTION WHEN check_violation THEN NULL;
    END;
  END LOOP;
  FOREACH mutation IN ARRAY ARRAY['asset_key = ''wrong''', 'color = ''#000000''', 'is_active = false'] LOOP
    BEGIN
      EXECUTE 'UPDATE public.profile_backgrounds SET ' || mutation || ' WHERE id = ''sample-carbon''';
      UPDATE public.profile_preferences SET background_id = 'sample-carbon'
      WHERE user_id = '955555555555555555' AND guild_id = '977777777777777777';
      RAISE EXCEPTION 'Invalid solid selection accepted: %', mutation;
    EXCEPTION WHEN check_violation THEN NULL;
    END;
  END LOOP;
END;
$$;

UPDATE public.profile_backgrounds SET status = 'processing', revision = revision + 1,
  mime = NULL, width = NULL, height = NULL, byte_size = NULL
WHERE id = 'test-image-private';
DELETE FROM public.profile_backgrounds WHERE id = 'test-image-processing';

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM public.profile_backgrounds
    WHERE id = 'test-image-private' AND slot_number = 1 AND revision = 2 AND status = 'processing')
    OR NOT EXISTS (SELECT 1 FROM public.profile_backgrounds
      WHERE id = 'test-image-failed' AND slot_number = 3 AND status = 'failed') THEN
    RAISE EXCEPTION 'Replacement or deletion must not renumber slots';
  END IF;
END;
$$;

DELETE FROM public.profile_backgrounds WHERE id = 'test-image-private';
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM public.profile_preferences
    WHERE user_id = '955555555555555555' AND guild_id = '977777777777777777'
      AND background_id IS NULL) THEN
    RAISE EXCEPTION 'Image deletion must preserve preference with NULL background';
  END IF;
END;
$$;
UPDATE public.profile_preferences SET background_id = 'sample-carbon'
WHERE user_id = '955555555555555555' AND guild_id = '977777777777777777';
DELETE FROM public.profile_backgrounds WHERE id = 'sample-carbon';
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM public.profile_preferences
    WHERE user_id = '955555555555555555' AND guild_id = '977777777777777777'
      AND background_id IS NULL) THEN
    RAISE EXCEPTION 'Solid deletion must preserve preference with NULL background';
  END IF;
END;
$$;

RESET ROLE;
ROLLBACK;
