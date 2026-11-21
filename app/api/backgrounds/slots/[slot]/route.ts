import { handleBackgroundDelete } from "../../../../../lib/background-delete";
import { handleBackgroundUpload } from "../../../../../lib/background-upload";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

type Context = { params: Promise<{ slot: string }> };
export async function PUT(request: Request, context: Context) {
  return handleBackgroundUpload(request, (await context.params).slot);
}

export async function DELETE(request: Request, context: Context) {
  return handleBackgroundDelete(request, (await context.params).slot);
}
