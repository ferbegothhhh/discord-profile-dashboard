import { handlePreferences } from "../../../lib/preferences";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export function GET(request: Request) { return handlePreferences(request); }
export function POST(request: Request) { return handlePreferences(request); }
