BEGIN;

DO $$
DECLARE
  role_name TEXT;
  function_name TEXT;
  statement TEXT;
BEGIN
  IF NOT (SELECT relrowsecurity FROM pg_class WHERE oid = 'public.profile_background_cleanup'::regclass)
    OR EXISTS (SELECT 1 FROM pg_policy WHERE polrelid = 'public.profile_background_cleanup'::regclass) THEN
    RAISE EXCEPTION 'Cleanup queue must be backend-only';
  END IF;
  IF NOT (SELECT relrowsecurity FROM pg_class WHERE oid = 'public.profile_background_object_keys'::regclass)
    OR EXISTS (SELECT 1 FROM pg_policy WHERE polrelid = 'public.profile_background_object_keys'::regclass) THEN
    RAISE EXCEPTION 'Object key ledger must be backend-only';
  END IF;
  IF has_table_privilege('service_role', 'public.profile_background_object_keys', 'UPDATE,DELETE,TRUNCATE,REFERENCES,TRIGGER')
    OR has_any_column_privilege('service_role', 'public.profile_background_object_keys', 'UPDATE,REFERENCES')
    OR NOT has_column_privilege('service_role', 'public.profile_background_object_keys', 'object_key', 'SELECT')
    OR NOT has_column_privilege('service_role', 'public.profile_background_object_keys', 'object_key', 'INSERT') THEN
    RAISE EXCEPTION 'Object key ledger service privileges invalid';
  END IF;
  IF EXISTS (SELECT 1 FROM public.profile_backgrounds b WHERE b.object_key IS NOT NULL
    AND NOT EXISTS (SELECT 1 FROM public.profile_background_object_keys k WHERE k.object_key = b.object_key)) THEN
    RAISE EXCEPTION 'Live object keys missing from ledger';
  END IF;
  FOREACH role_name IN ARRAY ARRAY['anon', 'authenticated'] LOOP
    IF has_table_privilege(role_name, 'public.profile_background_object_keys', 'SELECT,INSERT,UPDATE,DELETE,TRUNCATE,REFERENCES,TRIGGER')
      OR has_any_column_privilege(role_name, 'public.profile_background_object_keys', 'SELECT,INSERT,UPDATE,REFERENCES') THEN
      RAISE EXCEPTION 'Object key ledger exposed';
    END IF;
    IF has_table_privilege(role_name, 'public.profile_background_cleanup', 'SELECT,INSERT,UPDATE,DELETE,TRUNCATE,REFERENCES,TRIGGER')
      OR has_any_column_privilege(role_name, 'public.profile_background_cleanup', 'SELECT,INSERT,UPDATE,REFERENCES') THEN
      RAISE EXCEPTION 'Cleanup queue exposed';
    END IF;
    FOREACH function_name IN ARRAY ARRAY[
      'public.reserve_profile_background(text,text,integer,text,text,integer)',
      'public.finalize_profile_background(text,text,integer,text,text,integer,text,integer,integer,bigint,integer)',
      'public.abort_profile_background(text,text,integer,text,text,integer)'
    ] LOOP
      IF has_function_privilege(role_name, function_name, 'EXECUTE') THEN RAISE EXCEPTION 'Upload RPC exposed'; END IF;
      IF NOT has_function_privilege('service_role', function_name, 'EXECUTE') THEN RAISE EXCEPTION 'Service role missing upload RPC'; END IF;
    END LOOP;
    EXECUTE format('SET LOCAL ROLE %I', role_name);
    FOREACH statement IN ARRAY ARRAY[
      'SELECT * FROM public.profile_background_cleanup',
      'SELECT * FROM public.profile_background_object_keys',
      'INSERT INTO public.profile_background_object_keys (object_key) VALUES (''profile-images/aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa.png'')',
      'SELECT public.reserve_profile_background(NULL,NULL,NULL,NULL,NULL,NULL)',
      'SELECT public.finalize_profile_background(NULL,NULL,NULL,NULL,NULL,NULL,NULL,NULL,NULL,NULL,NULL)',
      'SELECT public.abort_profile_background(NULL,NULL,NULL,NULL,NULL,NULL)'
    ] LOOP
      BEGIN
        EXECUTE statement;
        RAISE EXCEPTION 'Frontend operation accepted: %', statement;
      EXCEPTION WHEN insufficient_privilege THEN NULL;
      END;
    END LOOP;
    RESET ROLE;
  END LOOP;
  IF EXISTS (SELECT 1 FROM pg_proc WHERE oid IN (
    'public.reserve_profile_background(text,text,integer,text,text,integer)'::regprocedure,
    'public.finalize_profile_background(text,text,integer,text,text,integer,text,integer,integer,bigint,integer)'::regprocedure,
    'public.abort_profile_background(text,text,integer,text,text,integer)'::regprocedure
  ) AND (NOT prosecdef OR NOT ('search_path=""' = ANY(proconfig)))) THEN
    RAISE EXCEPTION 'Upload RPC security configuration missing';
  END IF;
END;
$$;

SET LOCAL ROLE service_role;

DO $$
DECLARE
  u TEXT := '944444444444444444';
  g TEXT := '933333333333333333';
  image_id TEXT := '11111111-1111-4111-8111-111111111111';
  image_key TEXT := 'profile-images/12121212121212121212121212121212.png';
  mutation TEXT;
  state TEXT;
  reserved RECORD;
  slot INTEGER;
  threshold INTEGER;
  slot_id TEXT;
  slot_key TEXT;
BEGIN
  IF EXISTS (SELECT 1 FROM public.profile_backgrounds WHERE owner_user_id = u)
    OR EXISTS (SELECT 1 FROM public.profile_background_cleanup WHERE object_key = image_key) THEN
    RAISE EXCEPTION 'Upload test fixtures already exist';
  END IF;
  FOREACH mutation IN ARRAY ARRAY[
    format('%L,%L,0,%L,%L,1',u,g,image_id,image_key),
    format('%L,%L,4,%L,%L,1',u,g,image_id,image_key),
    format('%L,%L,NULL,%L,%L,1',u,g,image_id,image_key),
    format('%L,%L,1,%L,%L,2',u,g,image_id,image_key),
    format('%L,%L,1,%L,%L,1','bad',g,image_id,image_key),
    format('%L,%L,1,%L,%L,1',u,g,'not-uuid',image_key),
    format('%L,%L,1,%L,%L,1',u,g,image_id,'../secret'),
    format('NULL,%L,1,%L,%L,1',g,image_id,image_key),
    format('%L,NULL,1,%L,%L,1',u,image_id,image_key),
    format('%L,%L,1,NULL,%L,1',u,g,image_key),
    format('%L,%L,1,%L,NULL,1',u,g,image_id),
    format('%L,%L,1,%L,%L,NULL',u,g,image_id,image_key)
  ] LOOP
    BEGIN
      EXECUTE 'SELECT public.reserve_profile_background(' || mutation || ')';
      RAISE EXCEPTION 'Invalid reserve accepted';
    EXCEPTION WHEN check_violation THEN NULL;
    END;
  END LOOP;
  SELECT * INTO reserved FROM public.reserve_profile_background(u, g, 1, image_id, image_key, 1);
  IF reserved.id <> image_id OR reserved.object_key <> image_key OR reserved.revision <> 1 THEN
    RAISE EXCEPTION 'Reservation result invalid';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM public.profile_backgrounds WHERE id = image_id
    AND name = 'Background pribadi 1' AND category = 'Pribadi' AND asset_key IS NULL AND color IS NULL
    AND kind = 'image' AND visibility = 'private' AND status = 'processing' AND is_active IS FALSE
    AND mime IS NULL AND width IS NULL AND height IS NULL AND byte_size IS NULL) THEN
    RAISE EXCEPTION 'Reservation shape invalid';
  END IF;
  FOREACH state IN ARRAY ARRAY['processing', 'failed', 'ready'] LOOP
    UPDATE public.profile_backgrounds SET status = state,
      mime = CASE WHEN state = 'ready' THEN 'image/png' END,
      width = CASE WHEN state = 'ready' THEN 1000 END,
      height = CASE WHEN state = 'ready' THEN 560 END,
      byte_size = CASE WHEN state = 'ready' THEN 500 END WHERE id = image_id;
    BEGIN
      PERFORM public.reserve_profile_background(u, g, 1, '22222222-2222-4222-8222-222222222222', 'profile-images/23232323232323232323232323232323.png', 1);
      RAISE EXCEPTION 'Occupied slot replaced';
    EXCEPTION WHEN unique_violation THEN NULL;
    END;
  END LOOP;
  UPDATE public.profile_backgrounds SET status = 'processing', mime = NULL, width = NULL, height = NULL, byte_size = NULL WHERE id = image_id;
  FOREACH mutation IN ARRAY ARRAY[
    format('%L,%L,1,%L,%L,1,''image/png'',1000,560,500,19',u,g,image_id,image_key),
    format('%L,%L,1,%L,%L,2,''image/png'',1000,560,500,65',u,g,image_id,image_key),
    format('%L,%L,1,%L,%L,1,''image/jpeg'',1000,560,500,65',u,g,image_id,image_key),
    format('%L,%L,1,%L,%L,1,''image/png'',999,560,500,65',u,g,image_id,image_key),
    format('%L,%L,1,%L,%L,1,''image/png'',1000,559,500,65',u,g,image_id,image_key),
    format('%L,%L,1,%L,%L,1,''image/png'',1000,560,2305537,65',u,g,image_id,image_key),
    format('%L,%L,1,%L,%L,1,''image/png'',1000,560,0,65',u,g,image_id,image_key),
    format('%L,%L,1,%L,%L,1,''image/png'',1000,560,500,NULL',u,g,image_id,image_key),
    format('%L,%L,1,%L,%L,1,''image/png'',1000,560,500,65','922222222222222222',g,image_id,image_key),
    format('%L,%L,1,%L,%L,1,''image/png'',1000,560,500,65',u,'922222222222222222',image_id,image_key),
    format('%L,%L,2,%L,%L,1,''image/png'',1000,560,500,65',u,g,image_id,image_key),
    format('%L,%L,1,%L,%L,1,''image/png'',1000,560,500,65',u,g,image_id,'profile-images/34343434343434343434343434343434.png')
  ] LOOP
    BEGIN
      EXECUTE 'SELECT public.finalize_profile_background(' || mutation || ')';
      RAISE EXCEPTION 'Invalid finalize accepted';
    EXCEPTION WHEN check_violation THEN NULL;
    END;
  END LOOP;
  BEGIN
    PERFORM public.abort_profile_background('922222222222222222', g, 1, image_id, image_key, 1);
    RAISE EXCEPTION 'Foreign abort accepted';
  EXCEPTION WHEN check_violation THEN NULL;
  END;
  PERFORM public.finalize_profile_background(u, g, 1, image_id, image_key, 1, 'image/png', 1000, 560, 500, 20);
  IF NOT EXISTS (SELECT 1 FROM public.profile_backgrounds WHERE id = image_id AND status = 'ready' AND revision = 2 AND is_active IS TRUE) THEN
    RAISE EXCEPTION 'Finalize failed';
  END IF;
  BEGIN
    PERFORM public.abort_profile_background(u, g, 1, image_id, image_key, 1);
    RAISE EXCEPTION 'Ready image aborted';
  EXCEPTION WHEN check_violation THEN NULL;
  END;
  BEGIN
    PERFORM public.finalize_profile_background(u, g, 1, image_id, image_key, 1, 'image/png', 1000, 560, 500, 65);
    RAISE EXCEPTION 'Duplicate finalize accepted';
  EXCEPTION WHEN check_violation THEN NULL;
  END;
  IF EXISTS (SELECT 1 FROM public.profile_background_cleanup WHERE object_key = image_key) THEN RAISE EXCEPTION 'Ready image queued'; END IF;
  PERFORM public.reserve_profile_background(u, g, 2, '22222222-2222-4222-8222-222222222222', 'profile-images/23232323232323232323232323232323.png', 1);
  BEGIN
    PERFORM public.finalize_profile_background(u, g, 2, '22222222-2222-4222-8222-222222222222', 'profile-images/23232323232323232323232323232323.png', 1, 'image/png', 1000, 560, 500, 44);
    RAISE EXCEPTION 'Slot two level bypass';
  EXCEPTION WHEN check_violation THEN NULL;
  END;
  IF public.abort_profile_background(u, g, 2, '22222222-2222-4222-8222-222222222222', 'profile-images/23232323232323232323232323232323.png', 1)
    <> 'profile-images/23232323232323232323232323232323.png' THEN RAISE EXCEPTION 'Abort key invalid'; END IF;
  IF EXISTS (SELECT 1 FROM public.profile_backgrounds WHERE owner_user_id = u AND slot_number = 2)
    OR NOT EXISTS (SELECT 1 FROM public.profile_background_cleanup WHERE object_key = 'profile-images/23232323232323232323232323232323.png' AND reason = 'upload_aborted' AND attempts = 0) THEN
    RAISE EXCEPTION 'Abort must delete processing reservation and queue cleanup atomically';
  END IF;
  FOR slot IN 1..2 LOOP
    BEGIN
      PERFORM public.reserve_profile_background(u, g, 2, '55555555-5555-4555-8555-555555555555', 'profile-images/23232323232323232323232323232323.png', 1);
      RAISE EXCEPTION 'Aborted object key reused';
    EXCEPTION WHEN unique_violation THEN NULL;
    END;
    DELETE FROM public.profile_background_cleanup WHERE object_key = 'profile-images/23232323232323232323232323232323.png';
  END LOOP;
  BEGIN
    PERFORM public.abort_profile_background(u, g, 2, '22222222-2222-4222-8222-222222222222', 'profile-images/23232323232323232323232323232323.png', 1);
    RAISE EXCEPTION 'Duplicate abort accepted';
  EXCEPTION WHEN check_violation THEN NULL;
  END;
  INSERT INTO public.profile_background_cleanup (object_key, reason)
    VALUES ('profile-images/56565656565656565656565656565656.png', 'upload_aborted');
  BEGIN
    PERFORM public.reserve_profile_background(u, g, 2, '55555555-5555-4555-8555-555555555555', 'profile-images/56565656565656565656565656565656.png', 1);
    RAISE EXCEPTION 'Queued object key reused';
  EXCEPTION WHEN unique_violation THEN NULL;
  END;
  IF NOT EXISTS (SELECT 1 FROM public.profile_background_object_keys WHERE object_key = 'profile-images/23232323232323232323232323232323.png')
    OR EXISTS (SELECT 1 FROM public.profile_background_object_keys WHERE object_key = 'profile-images/56565656565656565656565656565656.png') THEN
    RAISE EXCEPTION 'Object key ledger state invalid';
  END IF;
  FOR slot IN 2..3 LOOP
    threshold := CASE slot WHEN 2 THEN 45 ELSE 65 END;
    slot_id := CASE slot WHEN 2 THEN '33333333-3333-4333-8333-333333333333' ELSE '44444444-4444-4444-8444-444444444444' END;
    slot_key := 'profile-images/' || repeat(slot::text, 32) || '.png';
    PERFORM public.reserve_profile_background(u, g, slot, slot_id, slot_key, 1);
    BEGIN
      PERFORM public.finalize_profile_background(u, g, slot, slot_id, slot_key, 1, 'image/png', 1000, 560, 2305536, threshold - 1);
      RAISE EXCEPTION 'Slot level bypass';
    EXCEPTION WHEN check_violation THEN NULL;
    END;
    PERFORM public.finalize_profile_background(u, g, slot, slot_id, slot_key, 1, 'image/png', 1000, 560, 2305536, threshold);
    IF NOT EXISTS (SELECT 1 FROM public.profile_backgrounds WHERE id = slot_id
      AND status = 'ready' AND is_active IS TRUE AND revision = 2 AND byte_size = 2305536) THEN
      RAISE EXCEPTION 'Slot threshold finalize failed';
    END IF;
  END LOOP;
  IF to_regprocedure('public.delete_profile_background_slot(text,text,integer)') IS NOT NULL THEN
    PERFORM public.delete_profile_background_slot(u, g, 1);
    FOR slot IN 1..2 LOOP
      BEGIN
        PERFORM public.reserve_profile_background(u, g, 1, '55555555-5555-4555-8555-555555555555', image_key, 1);
        RAISE EXCEPTION 'Deleted object key reused';
      EXCEPTION WHEN unique_violation THEN NULL;
      END;
      DELETE FROM public.profile_background_cleanup WHERE object_key = image_key;
    END LOOP;
    IF NOT EXISTS (SELECT 1 FROM public.profile_background_object_keys WHERE object_key = image_key) THEN
      RAISE EXCEPTION 'Deleted object key missing from ledger';
    END IF;
  END IF;
END;
$$;

ROLLBACK;
