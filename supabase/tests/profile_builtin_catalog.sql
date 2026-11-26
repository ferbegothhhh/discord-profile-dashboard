BEGIN;

SET LOCAL ROLE profile_dashboard;

DO $$
DECLARE
  selected_id text;
BEGIN
  INSERT INTO public.profile_preferences (user_id, guild_id, background_id)
  VALUES ('911111111111111118', '922222222222222228', 'catalog-background-1');

  UPDATE public.profile_preferences SET background_id = 'catalog-background-2'
  WHERE user_id = '911111111111111118' AND guild_id = '922222222222222228';

  SELECT background_id INTO selected_id FROM public.profile_preferences
  WHERE user_id = '911111111111111118' AND guild_id = '922222222222222228';
  IF selected_id IS DISTINCT FROM 'catalog-background-2' THEN
    RAISE EXCEPTION 'Expected second built-in background';
  END IF;
END;
$$;

RESET ROLE;

DO $$
BEGIN
  BEGIN
    UPDATE public.profile_backgrounds SET width = NULL WHERE id = 'catalog-background-1';
    RAISE EXCEPTION 'Accepted missing catalog image width';
  EXCEPTION WHEN check_violation THEN
    NULL;
  END;

  UPDATE public.profile_backgrounds SET is_active = false WHERE id = 'catalog-background-1';
END;
$$;

SET LOCAL ROLE profile_dashboard;

DO $$
BEGIN
  UPDATE public.profile_preferences SET background_id = 'sample-carbon'
  WHERE user_id = '911111111111111118' AND guild_id = '922222222222222228';

  BEGIN
    UPDATE public.profile_preferences SET background_id = 'catalog-background-1'
    WHERE user_id = '911111111111111118' AND guild_id = '922222222222222228';
    RAISE EXCEPTION 'Accepted inactive catalog image';
  EXCEPTION WHEN check_violation THEN
    NULL;
  END;
END;
$$;

ROLLBACK;
