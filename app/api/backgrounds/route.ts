import { handleBackgroundLibrary } from "../../../lib/background-library";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export function GET(request: Request) { return handleBackgroundLibrary(request); }
