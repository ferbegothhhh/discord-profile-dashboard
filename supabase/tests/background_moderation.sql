BEGIN;

DO $$
DECLARE
  role_name TEXT;
BEGIN
  FOREACH role_name IN ARRAY ARRAY['anon', 'authenticated'] LOOP
    IF has_function_privilege(role_name, 'public.disable_guild_background(text,text,text)', 'EXECUTE')
      OR has_table_privilege(role_name, 'public.profile_background_moderation', 'SELECT') THEN
      RAISE EXCEPTION 'Moderation exposed';
    END IF;
    EXECUTE format('SET LOCAL ROLE %I', role_name);
    BEGIN
      PERFORM public.disable_guild_background(NULL,NULL,NULL);
      RAISE EXCEPTION 'Frontend moderation accepted';
    EXCEPTION WHEN insufficient_privilege THEN NULL;
    END;
    RESET ROLE;
  END LOOP;
  IF NOT has_function_privilege('service_role', 'public.disable_guild_background(text,text,text)', 'EXECUTE')
    OR has_table_privilege('service_role', 'public.profile_background_moderation', 'INSERT')
    OR EXISTS (SELECT 1 FROM pg_proc WHERE oid = 'public.disable_guild_background(text,text,text)'::regprocedure
      AND (NOT prosecdef OR NOT ('search_path=""' = ANY(proconfig)))) THEN
    RAISE EXCEPTION 'Moderation grants unsafe';
  END IF;
END;
$$;

SET LOCAL ROLE service_role;
DO $$
DECLARE
  u TEXT := '912121212121212121';
  g TEXT := '923232323232323232';
  other_g TEXT := '945454545454545454';
  actor TEXT := '934343434343434343';
  image_id TEXT := '12121212-1212-4212-8212-121212121212';
  image_key TEXT := 'profile-images/abababababababababababababababab.png';
BEGIN
  PERFORM public.reserve_profile_background(u,g,1,image_id,image_key,1);
  IF public.disable_guild_background(actor,g,image_id) THEN RAISE EXCEPTION 'Processing moderated'; END IF;
  PERFORM public.finalize_profile_background(u,g,1,image_id,image_key,1,'image/png',1000,560,500,20);
  INSERT INTO public.profile_preferences (user_id,guild_id,background_id) VALUES (u,g,image_id),(u,other_g,'sample-carbon');
  IF public.disable_guild_background(actor,other_g,image_id) THEN RAISE EXCEPTION 'Foreign target accepted'; END IF;
  BEGIN
    PERFORM public.disable_guild_background(actor,g,'sample-carbon');
    RAISE EXCEPTION 'Catalog target accepted';
  EXCEPTION WHEN check_violation THEN NULL;
  END;
  BEGIN
    PERFORM public.disable_guild_background(NULL,g,image_id);
    RAISE EXCEPTION 'Invalid actor accepted';
  EXCEPTION WHEN check_violation THEN NULL;
  END;
  BEGIN
    PERFORM public.disable_guild_background(actor,g,image_id);
    RAISE EXCEPTION 'rollback_probe' USING ERRCODE = 'P0002';
  EXCEPTION WHEN no_data_found THEN NULL;
  END;
  IF NOT EXISTS (SELECT 1 FROM public.profile_backgrounds WHERE id = image_id AND is_active)
    OR EXISTS (SELECT 1 FROM public.profile_background_moderation WHERE background_id = image_id) THEN
    RAISE EXCEPTION 'Moderation rollback failed';
  END IF;
  IF NOT public.disable_guild_background(actor,g,image_id)
    OR NOT public.disable_guild_background(actor,g,image_id) THEN RAISE EXCEPTION 'Disable not idempotent'; END IF;
  IF EXISTS (SELECT 1 FROM public.profile_backgrounds WHERE id = image_id AND is_active)
    OR NOT EXISTS (SELECT 1 FROM public.profile_preferences WHERE user_id = u AND guild_id = g AND background_id IS NULL)
    OR NOT EXISTS (SELECT 1 FROM public.profile_preferences WHERE user_id = u AND guild_id = other_g AND background_id = 'sample-carbon')
    OR (SELECT count(*) FROM public.profile_background_moderation WHERE background_id = image_id AND actor_user_id = actor AND guild_id = g) <> 1
    OR EXISTS (SELECT 1 FROM public.profile_background_cleanup WHERE object_key = image_key) THEN
    RAISE EXCEPTION 'Disable, fallback, audit or retention failed';
  END IF;
  BEGIN
    UPDATE public.profile_preferences SET background_id = image_id WHERE user_id = u AND guild_id = g;
    RAISE EXCEPTION 'Disabled image selectable';
  EXCEPTION WHEN check_violation THEN NULL;
  END;
  PERFORM public.delete_profile_background_slot(u,g,1);
  IF NOT EXISTS (SELECT 1 FROM public.profile_background_cleanup WHERE object_key = image_key AND reason = 'slot_deleted')
    OR EXISTS (SELECT 1 FROM public.profile_backgrounds WHERE id = image_id) THEN RAISE EXCEPTION 'Owner cleanup broken'; END IF;
END;
$$;
ROLLBACK;
