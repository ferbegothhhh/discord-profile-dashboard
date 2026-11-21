import { handleModeration } from "../../../../lib/background-moderation";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export async function GET(request: Request) {
  return handleModeration(request);
}
