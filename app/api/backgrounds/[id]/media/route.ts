import { handleBackgroundMedia } from "../../../../../lib/background-media";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

type Context = { params: Promise<{ id: string }> };
export async function GET(request: Request, context: Context) {
  return handleBackgroundMedia(request, (await context.params).id);
}
