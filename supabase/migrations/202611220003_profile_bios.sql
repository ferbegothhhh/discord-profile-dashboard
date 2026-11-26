BEGIN;

CREATE TABLE public.profile_bios (
  user_id TEXT PRIMARY KEY CHECK (user_id ~ '^[1-9][0-9]{16,19}$'),
  bio TEXT NOT NULL CHECK (char_length(bio) <= 120 AND bio = normalize(bio, NFC) AND bio !~ '[[:cntrl:]]'),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

ALTER TABLE public.profile_bios ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.profile_bios FROM PUBLIC, anon, authenticated;
GRANT SELECT (user_id, bio), INSERT (user_id, bio, updated_at), UPDATE (bio, updated_at), DELETE ON public.profile_bios TO profile_dashboard;
CREATE POLICY profile_dashboard_bio_select ON public.profile_bios FOR SELECT TO profile_dashboard USING (true);
CREATE POLICY profile_dashboard_bio_insert ON public.profile_bios FOR INSERT TO profile_dashboard WITH CHECK (true);
CREATE POLICY profile_dashboard_bio_update ON public.profile_bios FOR UPDATE TO profile_dashboard USING (true) WITH CHECK (true);
CREATE POLICY profile_dashboard_bio_delete ON public.profile_bios FOR DELETE TO profile_dashboard USING (true);

COMMIT;
