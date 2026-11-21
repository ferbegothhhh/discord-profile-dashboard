BEGIN;

DO $$
DECLARE
  signature TEXT;
  role_name TEXT;
BEGIN
  FOREACH signature IN ARRAY ARRAY[
    'public.reclaim_profile_backgrounds(integer)',
    'public.claim_profile_background_cleanup(integer)',
    'public.check_profile_background_cleanup(text,uuid)',
    'public.ack_profile_background_cleanup(text,uuid)',
    'public.fail_profile_background_cleanup(text,uuid,text)'
  ] LOOP
    FOREACH role_name IN ARRAY ARRAY['anon', 'authenticated'] LOOP
      IF has_function_privilege(role_name, signature, 'EXECUTE') THEN
        RAISE EXCEPTION 'Cleanup RPC exposed';
      END IF;
    END LOOP;
    IF NOT has_function_privilege('service_role', signature, 'EXECUTE')
      OR NOT EXISTS (SELECT 1 FROM pg_proc WHERE oid = signature::regprocedure
        AND prosecdef AND 'search_path=""' = ANY(proconfig)) THEN
      RAISE EXCEPTION 'Cleanup RPC security configuration missing';
    END IF;
  END LOOP;
  IF to_regclass('storage.buckets') IS NOT NULL THEN
    IF NOT EXISTS (SELECT 1 FROM storage.buckets WHERE id = 'profile-backgrounds'
      AND public IS FALSE AND file_size_limit = 2305536 AND allowed_mime_types = ARRAY['image/png']::TEXT[]) THEN
      RAISE EXCEPTION 'Private bucket configuration missing';
    END IF;
    IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE schemaname = 'storage' AND tablename = 'objects'
      AND policyname = 'profile_backgrounds_service_only' AND permissive = 'RESTRICTIVE'
      AND roles @> ARRAY['anon', 'authenticated']::NAME[] AND cmd = 'ALL'
      AND qual LIKE '%bucket_id%profile-backgrounds%' AND with_check LIKE '%bucket_id%profile-backgrounds%') THEN
      RAISE EXCEPTION 'Storage restriction missing';
    END IF;
  END IF;
END;
$$;

DO $$
DECLARE
  u TEXT := '976767676767676767';
  g TEXT := '987878787878787878';
  stale_id TEXT := '67676767-6767-4676-8676-676767676767';
  fresh_id TEXT := '78787878-7878-4787-8787-787878787878';
  ready_id TEXT := '89898989-8989-4898-8989-898989898989';
  stale_key TEXT := 'profile-images/67676767676767676767676767676767.png';
  fresh_key TEXT := 'profile-images/78787878787878787878787878787878.png';
  ready_key TEXT := 'profile-images/89898989898989898989898989898989.png';
  claim RECORD;
  first_token UUID;
  second_token UUID;
  claims INTEGER := 0;
  invalid_limit INTEGER;
BEGIN
  IF EXISTS (SELECT 1 FROM public.profile_backgrounds WHERE owner_user_id = u)
    OR EXISTS (SELECT 1 FROM public.profile_background_object_keys WHERE object_key IN (stale_key, fresh_key, ready_key)) THEN
    RAISE EXCEPTION 'Cleanup fixtures already exist';
  END IF;
  UPDATE public.profile_background_cleanup SET available_at = now() + interval '1 day';
  UPDATE public.profile_backgrounds SET created_at = now() WHERE status = 'processing';
  PERFORM public.reserve_profile_background(u,g,1,stale_id,stale_key,1);
  PERFORM public.reserve_profile_background(u,g,2,fresh_id,fresh_key,1);
  PERFORM public.reserve_profile_background(u,g,3,ready_id,ready_key,1);
  PERFORM public.finalize_profile_background(u,g,3,ready_id,ready_key,1,'image/png',1000,560,500,65);
  INSERT INTO public.profile_preferences (user_id,guild_id,background_id) VALUES (u,g,ready_id);
  UPDATE public.profile_backgrounds SET created_at = now() - interval '2 hours' WHERE id IN (stale_id,ready_id);
  IF public.reclaim_profile_backgrounds(20) <> 1 THEN RAISE EXCEPTION 'Stale reclaim failed'; END IF;
  IF EXISTS (SELECT 1 FROM public.profile_backgrounds WHERE id = stale_id)
    OR NOT EXISTS (SELECT 1 FROM public.profile_background_cleanup WHERE object_key = stale_key)
    OR NOT EXISTS (SELECT 1 FROM public.profile_background_object_keys WHERE object_key = stale_key)
    OR NOT EXISTS (SELECT 1 FROM public.profile_backgrounds WHERE id = fresh_id AND status = 'processing')
    OR NOT EXISTS (SELECT 1 FROM public.profile_backgrounds WHERE id = ready_id AND status = 'ready') THEN
    RAISE EXCEPTION 'Reclaim removed live rows or lost durable key';
  END IF;
  BEGIN
    PERFORM public.finalize_profile_background(u,g,1,stale_id,stale_key,1,'image/png',1000,560,500,65);
    RAISE EXCEPTION 'Reclaimed reservation finalized';
  EXCEPTION WHEN check_violation THEN NULL;
  END;
  INSERT INTO public.profile_background_cleanup (object_key,reason) VALUES (fresh_key,'upload_aborted'),(ready_key,'slot_deleted');
  first_token := gen_random_uuid();
  UPDATE public.profile_background_cleanup SET claim_token = first_token, lease_until = now() + interval '5 minutes'
    WHERE object_key IN (fresh_key,ready_key);
  IF public.check_profile_background_cleanup(fresh_key,first_token)
    OR public.check_profile_background_cleanup(ready_key,first_token)
    OR public.ack_profile_background_cleanup(fresh_key,first_token)
    OR public.ack_profile_background_cleanup(ready_key,first_token)
    OR NOT EXISTS (SELECT 1 FROM public.profile_background_cleanup WHERE object_key = ready_key)
    OR NOT EXISTS (SELECT 1 FROM public.profile_backgrounds WHERE id = ready_id AND is_active) THEN
    RAISE EXCEPTION 'Live key accepted even with matching token';
  END IF;
  FOR claim IN SELECT * FROM public.claim_profile_background_cleanup(20) LOOP
    claims := claims + 1;
    IF claim.object_key <> stale_key THEN RAISE EXCEPTION 'Live key claimed'; END IF;
    first_token := claim.claim_token;
  END LOOP;
  IF claims <> 1 OR first_token IS NULL
    OR EXISTS (SELECT 1 FROM public.claim_profile_background_cleanup(20)) THEN
    RAISE EXCEPTION 'Lease did not exclude concurrent claims';
  END IF;
  IF public.check_profile_background_cleanup(stale_key,gen_random_uuid())
    OR public.ack_profile_background_cleanup(stale_key,gen_random_uuid())
    OR public.fail_profile_background_cleanup(stale_key,gen_random_uuid(),'storage_unavailable')
    OR public.ack_profile_background_cleanup(ready_key,first_token) THEN
    RAISE EXCEPTION 'Wrong token or key accepted';
  END IF;
  IF NOT public.check_profile_background_cleanup(stale_key,first_token)
    OR NOT public.fail_profile_background_cleanup(stale_key,first_token,'storage_unavailable') THEN
    RAISE EXCEPTION 'Valid lease rejected';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM public.profile_background_cleanup WHERE object_key = stale_key
    AND claim_token IS NULL AND lease_until IS NULL AND available_at = now() + interval '1 minute'
    AND attempts = 1 AND last_error = 'storage_unavailable')
    OR EXISTS (SELECT 1 FROM public.claim_profile_background_cleanup(20)) THEN
    RAISE EXCEPTION 'Retry was not delayed';
  END IF;
  UPDATE public.profile_background_cleanup SET available_at = now() WHERE object_key = stale_key;
  SELECT claim_token INTO second_token FROM public.claim_profile_background_cleanup(20);
  UPDATE public.profile_background_cleanup SET lease_until = now() - interval '1 second' WHERE object_key = stale_key;
  IF public.check_profile_background_cleanup(stale_key,second_token)
    OR public.ack_profile_background_cleanup(stale_key,second_token)
    OR public.fail_profile_background_cleanup(stale_key,second_token,'storage_unavailable') THEN
    RAISE EXCEPTION 'Expired lease accepted';
  END IF;
  SELECT claim_token INTO first_token FROM public.claim_profile_background_cleanup(20);
  IF first_token IS NULL OR first_token = second_token
    OR public.ack_profile_background_cleanup(stale_key,second_token)
    OR NOT public.ack_profile_background_cleanup(stale_key,first_token)
    OR public.ack_profile_background_cleanup(stale_key,first_token)
    OR NOT EXISTS (SELECT 1 FROM public.profile_background_object_keys WHERE object_key = stale_key) THEN
    RAISE EXCEPTION 'Reclaim or token-bound acknowledgement failed';
  END IF;
  BEGIN
    PERFORM public.reserve_profile_background(u,g,1,stale_id,stale_key,1);
    RAISE EXCEPTION 'Deleted key reused';
  EXCEPTION WHEN unique_violation THEN NULL;
  END;
  INSERT INTO public.profile_background_cleanup (object_key,reason,attempts) VALUES (stale_key,'upload_aborted',10);
  IF EXISTS (SELECT 1 FROM public.claim_profile_background_cleanup(20)) THEN
    RAISE EXCEPTION 'Retry ceiling ignored';
  END IF;
  FOREACH invalid_limit IN ARRAY ARRAY[NULL,0,-1,21] LOOP
    BEGIN
      PERFORM public.claim_profile_background_cleanup(invalid_limit);
      RAISE EXCEPTION 'Invalid claim batch accepted';
    EXCEPTION WHEN check_violation THEN NULL;
    END;
    BEGIN
      PERFORM public.reclaim_profile_backgrounds(invalid_limit);
      RAISE EXCEPTION 'Invalid reaper batch accepted';
    EXCEPTION WHEN check_violation THEN NULL;
    END;
  END LOOP;
  BEGIN
    PERFORM public.fail_profile_background_cleanup(stale_key,first_token,'unsafe details');
    RAISE EXCEPTION 'Unsafe error accepted';
  EXCEPTION WHEN check_violation THEN NULL;
  END;
END;
$$;

DO $$
DECLARE
  role_name TEXT;
  affected INTEGER;
BEGIN
  IF to_regclass('storage.objects') IS NULL THEN RETURN; END IF;
  INSERT INTO storage.buckets (id,name) VALUES ('profile-storage-test-other','profile-storage-test-other');
  INSERT INTO storage.objects (bucket_id,name) VALUES
    ('profile-backgrounds','profile-storage-test-private'),
    ('profile-storage-test-other','profile-storage-test-other');
  EXECUTE 'CREATE POLICY profile_storage_test_permissive ON storage.objects FOR ALL TO anon, authenticated, service_role USING (true) WITH CHECK (true)';
  FOREACH role_name IN ARRAY ARRAY['anon','authenticated'] LOOP
    EXECUTE format('SET LOCAL ROLE %I', role_name);
    IF EXISTS (SELECT 1 FROM storage.objects WHERE bucket_id = 'profile-backgrounds') THEN
      RAISE EXCEPTION 'Private objects readable by %', role_name;
    END IF;
    IF NOT EXISTS (SELECT 1 FROM storage.objects WHERE bucket_id = 'profile-storage-test-other') THEN
      RAISE EXCEPTION 'Restriction blocked another bucket for %', role_name;
    END IF;
    BEGIN
      INSERT INTO storage.objects (bucket_id,name) VALUES ('profile-backgrounds','profile-storage-test-denied');
      RAISE EXCEPTION 'Private insert accepted for %', role_name;
    EXCEPTION WHEN insufficient_privilege THEN NULL;
    END;
    UPDATE storage.objects SET name = 'profile-storage-test-changed' WHERE bucket_id = 'profile-backgrounds';
    GET DIAGNOSTICS affected = ROW_COUNT;
    IF affected <> 0 THEN RAISE EXCEPTION 'Private update accepted'; END IF;
    DELETE FROM storage.objects WHERE bucket_id = 'profile-backgrounds';
    GET DIAGNOSTICS affected = ROW_COUNT;
    IF affected <> 0 THEN RAISE EXCEPTION 'Private delete accepted'; END IF;
    BEGIN
      UPDATE storage.objects SET bucket_id = 'profile-backgrounds' WHERE bucket_id = 'profile-storage-test-other';
      RAISE EXCEPTION 'Move into private bucket accepted';
    EXCEPTION WHEN insufficient_privilege THEN NULL;
    END;
    EXECUTE 'RESET ROLE';
  END LOOP;
  EXECUTE 'SET LOCAL ROLE service_role';
  IF NOT EXISTS (SELECT 1 FROM storage.objects WHERE bucket_id = 'profile-backgrounds' AND name = 'profile-storage-test-private') THEN
    RAISE EXCEPTION 'Service role cannot read private object';
  END IF;
  INSERT INTO storage.objects (bucket_id,name) VALUES ('profile-backgrounds','profile-storage-test-service');
  UPDATE storage.objects SET name = 'profile-storage-test-service-updated' WHERE name = 'profile-storage-test-service';
  GET DIAGNOSTICS affected = ROW_COUNT;
  IF affected <> 1 THEN RAISE EXCEPTION 'Service role update denied'; END IF;
  DELETE FROM storage.objects WHERE name = 'profile-storage-test-service-updated';
  GET DIAGNOSTICS affected = ROW_COUNT;
  IF affected <> 1 THEN RAISE EXCEPTION 'Service role delete denied'; END IF;
  EXECUTE 'RESET ROLE';
END;
$$;

ROLLBACK;
