import { backgrounds } from "../../../lib/catalog";

export function GET() {
  return Response.json({ source: "sample-solid-swatches", backgrounds });
}
