import { handleProfilePreview } from "../../../lib/profile-preview";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export function POST(request: Request) { return handleProfilePreview(request); }
