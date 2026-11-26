import { handleProfileBio } from "../../../lib/profile-bio";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export function GET(request: Request) { return handleProfileBio(request); }
export function POST(request: Request) { return handleProfileBio(request); }
export function DELETE(request: Request) { return handleProfileBio(request); }
