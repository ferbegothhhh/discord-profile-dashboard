BEGIN;

ALTER TABLE public.profile_background_cleanup
  DROP CONSTRAINT profile_background_cleanup_reason_check,
  DROP CONSTRAINT profile_background_cleanup_object_key_check,
  ADD CONSTRAINT profile_background_cleanup_reason_check CHECK (reason IN ('upload_aborted', 'slot_deleted')),
  ADD CONSTRAINT profile_background_cleanup_object_key_check CHECK (object_key ~ '^profile-images/[a-f0-9]{32}\.(png|jpg|webp)$');

CREATE FUNCTION public.delete_profile_background_slot(p_user_id TEXT, p_guild_id TEXT, p_slot INTEGER)
RETURNS JSONB LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE
  background public.profile_backgrounds%ROWTYPE;
BEGIN
  IF p_user_id IS NULL OR p_user_id !~ '^[1-9][0-9]{16,19}$'
    OR p_guild_id IS NULL OR p_guild_id !~ '^[1-9][0-9]{16,19}$'
    OR p_slot IS NULL OR p_slot NOT BETWEEN 1 AND 3 THEN
    RAISE EXCEPTION 'Invalid owner slot' USING ERRCODE = '23514';
  END IF;
  SELECT * INTO background FROM public.profile_backgrounds b
    WHERE b.owner_user_id = p_user_id AND b.owner_guild_id = p_guild_id
      AND b.slot_number = p_slot AND b.visibility = 'private' AND b.kind = 'image'
    FOR UPDATE;
  IF NOT FOUND THEN
    RETURN jsonb_build_object('removed', false, 'object_key', NULL);
  END IF;
  IF background.status NOT IN ('ready', 'failed') THEN
    RAISE EXCEPTION 'Slot processing' USING ERRCODE = '55000';
  END IF;
  INSERT INTO public.profile_background_object_keys (object_key)
    VALUES (background.object_key) ON CONFLICT (object_key) DO NOTHING;
  INSERT INTO public.profile_background_cleanup (object_key, reason)
    VALUES (background.object_key, 'slot_deleted') ON CONFLICT (object_key) DO NOTHING;
  DELETE FROM public.profile_backgrounds WHERE id = background.id;
  RETURN jsonb_build_object('removed', true, 'object_key', background.object_key);
END;
$$;

REVOKE ALL ON FUNCTION public.delete_profile_background_slot(TEXT,TEXT,INTEGER) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.delete_profile_background_slot(TEXT,TEXT,INTEGER) TO service_role;

COMMIT;
