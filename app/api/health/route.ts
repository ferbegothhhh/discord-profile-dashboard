import { authConfig } from "../../../lib/auth";

export const dynamic = "force-dynamic";

export function GET() {
  return Response.json({
    status: "ok",
    mode: "local-draft",
    integrations: {
      discord: authConfig() ? "configured" : "setup-required",
      supabase: "not-connected",
      bot: "not-connected",
    },
  }, { headers: { "Cache-Control": "no-store" } });
}
