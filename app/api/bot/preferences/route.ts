import { handleBotPreferences } from "../../../../lib/preferences";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export function GET(request: Request) { return handleBotPreferences(request); }
