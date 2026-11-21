BEGIN;

DO $$
DECLARE
  role_name TEXT;
BEGIN
  FOREACH role_name IN ARRAY ARRAY['anon', 'authenticated'] LOOP
    IF has_function_privilege(role_name, 'public.delete_profile_background_slot(text,text,integer)', 'EXECUTE') THEN
      RAISE EXCEPTION 'Delete RPC exposed';
    END IF;
    EXECUTE format('SET LOCAL ROLE %I', role_name);
    BEGIN
      PERFORM public.delete_profile_background_slot(NULL, NULL, NULL);
      RAISE EXCEPTION 'Frontend delete accepted';
    EXCEPTION WHEN insufficient_privilege THEN NULL;
    END;
    RESET ROLE;
  END LOOP;
  IF NOT has_function_privilege('service_role', 'public.delete_profile_background_slot(text,text,integer)', 'EXECUTE')
    OR EXISTS (SELECT 1 FROM pg_proc WHERE oid = 'public.delete_profile_background_slot(text,text,integer)'::regprocedure
      AND (NOT prosecdef OR NOT ('search_path=""' = ANY(proconfig)))) THEN
    RAISE EXCEPTION 'Delete RPC security configuration missing';
  END IF;
END;
$$;

SET LOCAL ROLE service_role;

DO $$
DECLARE
  u TEXT := '912121212121212121';
  g TEXT := '923232323232323232';
  other_u TEXT := '934343434343434343';
  other_g TEXT := '945454545454545454';
  image_id TEXT := '12121212-1212-4212-8212-121212121212';
  image_key TEXT := 'profile-images/abababababababababababababababab.png';
  other_id TEXT := '23232323-2323-4323-8323-232323232323';
  other_key TEXT := 'profile-images/bcbcbcbcbcbcbcbcbcbcbcbcbcbcbcbc.png';
  result JSONB;
  args TEXT;
BEGIN
  IF EXISTS (SELECT 1 FROM public.profile_backgrounds WHERE owner_user_id IN (u, other_u))
    OR EXISTS (SELECT 1 FROM public.profile_preferences WHERE user_id IN (u, other_u))
    OR EXISTS (SELECT 1 FROM public.profile_background_cleanup WHERE object_key IN (image_key, other_key)) THEN
    RAISE EXCEPTION 'Delete fixtures already exist';
  END IF;
  FOREACH args IN ARRAY ARRAY[
    format('NULL,%L,1',g), format('%L,NULL,1',u), format('%L,%L,NULL',u,g),
    format('%L,%L,0',u,g), format('%L,%L,4',u,g), format('%L,%L,1','bad',g), format('%L,%L,1',u,'bad')
  ] LOOP
    BEGIN
      EXECUTE 'SELECT public.delete_profile_background_slot(' || args || ')';
      RAISE EXCEPTION 'Invalid owner accepted';
    EXCEPTION WHEN check_violation THEN NULL;
    END;
  END LOOP;
  PERFORM public.reserve_profile_background(u,g,3,image_id,image_key,1);
  BEGIN
    PERFORM public.delete_profile_background_slot(u,g,3);
    RAISE EXCEPTION 'Processing slot deleted';
  EXCEPTION WHEN object_not_in_prerequisite_state THEN NULL;
  END;
  IF NOT EXISTS (SELECT 1 FROM public.profile_backgrounds WHERE id = image_id AND status = 'processing')
    OR EXISTS (SELECT 1 FROM public.profile_background_cleanup WHERE object_key = image_key) THEN
    RAISE EXCEPTION 'Processing rejection mutated data';
  END IF;
  PERFORM public.finalize_profile_background(u,g,3,image_id,image_key,1,'image/png',1000,560,500,65);
  PERFORM public.reserve_profile_background(other_u,g,3,other_id,other_key,1);
  PERFORM public.finalize_profile_background(other_u,g,3,other_id,other_key,1,'image/png',1000,560,500,65);
  INSERT INTO public.profile_preferences (user_id,guild_id,background_id) VALUES
    (u,g,image_id), (other_u,g,other_id), (u,other_g,'sample-carbon');
  result := public.delete_profile_background_slot(u,other_g,3);
  IF result <> jsonb_build_object('removed',false,'object_key',NULL)
    OR public.delete_profile_background_slot(u,g,2) <> result THEN
    RAISE EXCEPTION 'Missing slot not idempotent';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM public.profile_backgrounds WHERE id = image_id)
    OR EXISTS (SELECT 1 FROM public.profile_background_cleanup WHERE object_key = image_key) THEN
    RAISE EXCEPTION 'Foreign scope changed owner slot';
  END IF;
  BEGIN
    result := public.delete_profile_background_slot(u,g,3);
    IF result <> jsonb_build_object('removed',true,'object_key',image_key)
      OR EXISTS (SELECT 1 FROM public.profile_backgrounds WHERE id = image_id)
      OR NOT EXISTS (SELECT 1 FROM public.profile_background_cleanup WHERE object_key = image_key AND reason = 'slot_deleted' AND attempts = 0)
      OR NOT EXISTS (SELECT 1 FROM public.profile_preferences WHERE user_id = u AND guild_id = g AND background_id IS NULL) THEN
      RAISE EXCEPTION 'Delete did not atomically queue, remove and clear preference';
    END IF;
    RAISE EXCEPTION 'rollback_probe' USING ERRCODE = 'P0002';
  EXCEPTION WHEN no_data_found THEN NULL;
  END;
  IF NOT EXISTS (SELECT 1 FROM public.profile_backgrounds WHERE id = image_id)
    OR EXISTS (SELECT 1 FROM public.profile_background_cleanup WHERE object_key = image_key)
    OR NOT EXISTS (SELECT 1 FROM public.profile_preferences WHERE user_id = u AND guild_id = g AND background_id = image_id) THEN
    RAISE EXCEPTION 'Delete transaction rollback not atomic';
  END IF;
  UPDATE public.profile_backgrounds SET is_active = false WHERE id = image_id;
  PERFORM public.delete_profile_background_slot(u,g,3);
  IF public.delete_profile_background_slot(u,g,3) <> jsonb_build_object('removed',false,'object_key',NULL)
    OR NOT EXISTS (SELECT 1 FROM public.profile_preferences WHERE user_id = u AND guild_id = g AND background_id IS NULL)
    OR NOT EXISTS (SELECT 1 FROM public.profile_preferences WHERE user_id = other_u AND guild_id = g AND background_id = other_id)
    OR NOT EXISTS (SELECT 1 FROM public.profile_preferences WHERE user_id = u AND guild_id = other_g AND background_id = 'sample-carbon')
    OR NOT EXISTS (SELECT 1 FROM public.profile_backgrounds WHERE id = other_id)
    OR EXISTS (SELECT 1 FROM public.profile_background_cleanup WHERE object_key = other_key) THEN
    RAISE EXCEPTION 'Owner isolation or FK clearing failed';
  END IF;
  PERFORM public.reserve_profile_background(u,g,3,image_id,'profile-images/cdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcd.png',1);
  UPDATE public.profile_backgrounds SET status = 'failed', object_key = 'profile-images/cdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcd.webp' WHERE id = image_id;
  result := public.delete_profile_background_slot(u,g,3);
  IF result <> jsonb_build_object('removed',true,'object_key','profile-images/cdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcd.webp')
    OR NOT EXISTS (SELECT 1 FROM public.profile_background_cleanup WHERE object_key = result->>'object_key' AND reason = 'slot_deleted') THEN
    RAISE EXCEPTION 'Failed retained image not deleted';
  END IF;
END;
$$;

ROLLBACK;
