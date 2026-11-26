import { handleProfileAchievements } from "../../../lib/profile-achievements";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export function GET(request: Request) { return handleProfileAchievements(request); }
export function POST(request: Request) { return handleProfileAchievements(request); }
