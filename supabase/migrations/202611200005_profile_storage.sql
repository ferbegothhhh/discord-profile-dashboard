BEGIN;

ALTER TABLE public.profile_background_cleanup
  ADD COLUMN available_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  ADD COLUMN lease_until TIMESTAMPTZ,
  ADD COLUMN claim_token UUID,
  ADD COLUMN last_error TEXT CHECK (last_error IN ('storage_unavailable', 'invalid_job', 'cleanup_unavailable')),
  ADD CONSTRAINT profile_background_cleanup_lease_check CHECK ((lease_until IS NULL) = (claim_token IS NULL)),
  ADD CONSTRAINT profile_background_cleanup_ledger_fkey FOREIGN KEY (object_key)
    REFERENCES public.profile_background_object_keys (object_key);

CREATE INDEX profile_background_cleanup_available_idx ON public.profile_background_cleanup (available_at, created_at);

CREATE FUNCTION public.reclaim_profile_backgrounds(p_limit INTEGER DEFAULT 20)
RETURNS INTEGER LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE
  item RECORD;
  reclaimed INTEGER := 0;
BEGIN
  IF p_limit IS NULL OR p_limit NOT BETWEEN 1 AND 20 THEN
    RAISE EXCEPTION 'Invalid batch size' USING ERRCODE = '23514';
  END IF;
  FOR item IN SELECT b.id, b.object_key FROM public.profile_backgrounds b
    WHERE b.kind = 'image' AND b.visibility = 'private' AND b.status = 'processing'
      AND b.is_active IS FALSE AND b.created_at < now() - interval '1 hour'
      AND NOT EXISTS (SELECT 1 FROM public.profile_preferences p WHERE p.background_id = b.id)
    ORDER BY b.created_at, b.id LIMIT p_limit FOR UPDATE OF b SKIP LOCKED
  LOOP
    INSERT INTO public.profile_background_object_keys (object_key) VALUES (item.object_key) ON CONFLICT DO NOTHING;
    INSERT INTO public.profile_background_cleanup (object_key, reason)
      VALUES (item.object_key, 'upload_aborted') ON CONFLICT DO NOTHING;
    DELETE FROM public.profile_backgrounds WHERE id = item.id;
    reclaimed := reclaimed + 1;
  END LOOP;
  RETURN reclaimed;
END;
$$;

CREATE FUNCTION public.claim_profile_background_cleanup(p_limit INTEGER DEFAULT 20)
RETURNS TABLE(object_key TEXT, claim_token UUID)
LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
BEGIN
  IF p_limit IS NULL OR p_limit NOT BETWEEN 1 AND 20 THEN
    RAISE EXCEPTION 'Invalid batch size' USING ERRCODE = '23514';
  END IF;
  RETURN QUERY
  WITH jobs AS (
    SELECT c.object_key FROM public.profile_background_cleanup c
    WHERE c.available_at <= now() AND (c.lease_until IS NULL OR c.lease_until <= now())
      AND c.attempts < 10
      AND NOT EXISTS (SELECT 1 FROM public.profile_backgrounds b WHERE b.object_key = c.object_key)
    ORDER BY c.available_at, c.created_at, c.object_key LIMIT p_limit FOR UPDATE OF c SKIP LOCKED
  )
  UPDATE public.profile_background_cleanup c
    SET claim_token = gen_random_uuid(), lease_until = now() + interval '5 minutes', attempts = c.attempts + 1
    FROM jobs WHERE c.object_key = jobs.object_key RETURNING c.object_key, c.claim_token;
END;
$$;

CREATE FUNCTION public.check_profile_background_cleanup(p_object_key TEXT, p_claim_token UUID)
RETURNS BOOLEAN LANGUAGE sql SECURITY DEFINER SET search_path = '' AS $$
  SELECT EXISTS (SELECT 1 FROM public.profile_background_cleanup c
    WHERE c.object_key = p_object_key AND c.claim_token = p_claim_token AND c.lease_until > now()
      AND NOT EXISTS (SELECT 1 FROM public.profile_backgrounds b WHERE b.object_key = c.object_key));
$$;

CREATE FUNCTION public.ack_profile_background_cleanup(p_object_key TEXT, p_claim_token UUID)
RETURNS BOOLEAN LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
BEGIN
  DELETE FROM public.profile_background_cleanup c
    WHERE c.object_key = p_object_key AND c.claim_token = p_claim_token AND c.lease_until > now()
      AND NOT EXISTS (SELECT 1 FROM public.profile_backgrounds b WHERE b.object_key = c.object_key);
  RETURN FOUND;
END;
$$;

CREATE FUNCTION public.fail_profile_background_cleanup(p_object_key TEXT, p_claim_token UUID, p_error TEXT)
RETURNS BOOLEAN LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
BEGIN
  IF p_error IS NULL OR p_error NOT IN ('storage_unavailable', 'invalid_job', 'cleanup_unavailable') THEN
    RAISE EXCEPTION 'Invalid failure code' USING ERRCODE = '23514';
  END IF;
  UPDATE public.profile_background_cleanup c
    SET claim_token = NULL, lease_until = NULL, available_at = now() + interval '1 minute', last_error = p_error
    WHERE c.object_key = p_object_key AND c.claim_token = p_claim_token AND c.lease_until > now();
  RETURN FOUND;
END;
$$;

REVOKE ALL ON FUNCTION public.reclaim_profile_backgrounds(INTEGER),
  public.claim_profile_background_cleanup(INTEGER), public.check_profile_background_cleanup(TEXT,UUID),
  public.ack_profile_background_cleanup(TEXT,UUID), public.fail_profile_background_cleanup(TEXT,UUID,TEXT)
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.reclaim_profile_backgrounds(INTEGER),
  public.claim_profile_background_cleanup(INTEGER), public.check_profile_background_cleanup(TEXT,UUID),
  public.ack_profile_background_cleanup(TEXT,UUID), public.fail_profile_background_cleanup(TEXT,UUID,TEXT)
  TO service_role;

DO $$
BEGIN
  IF to_regclass('storage.buckets') IS NULL AND to_regclass('storage.objects') IS NULL THEN
    RAISE NOTICE 'Storage schema absent: bucket and policies skipped; apply on Supabase before enabling uploads';
    RETURN;
  END IF;
  IF to_regclass('storage.buckets') IS NULL OR to_regclass('storage.objects') IS NULL THEN
    RAISE EXCEPTION 'Incomplete Supabase Storage schema';
  END IF;
  INSERT INTO storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
    VALUES ('profile-backgrounds', 'profile-backgrounds', false, 2305536, ARRAY['image/png'])
    ON CONFLICT (id) DO NOTHING;
  IF NOT EXISTS (SELECT 1 FROM storage.buckets WHERE id = 'profile-backgrounds'
    AND public IS FALSE AND file_size_limit = 2305536 AND allowed_mime_types = ARRAY['image/png']::TEXT[]) THEN
    RAISE EXCEPTION 'Unsafe profile-backgrounds bucket configuration; operator remediation required';
  END IF;
  EXECUTE 'CREATE POLICY profile_backgrounds_service_only ON storage.objects AS RESTRICTIVE FOR ALL TO anon, authenticated USING (bucket_id <> ''profile-backgrounds'') WITH CHECK (bucket_id <> ''profile-backgrounds'')';
END;
$$;

COMMIT;
