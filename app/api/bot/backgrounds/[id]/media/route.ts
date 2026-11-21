import { handleBotBackgroundMedia } from "../../../../../../lib/bot-background-media";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

type Context = { params: Promise<{ id: string }> };
export async function GET(request: Request, context: Context) {
  return handleBotBackgroundMedia(request, (await context.params).id);
}
