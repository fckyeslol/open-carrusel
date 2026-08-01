import { NextRequest, NextResponse } from "next/server";
import { getSessionUser } from "@/lib/auth";
import { isHostedMode } from "@/lib/hosted";
import { buildLibraryItems } from "@/lib/library";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * Las piezas de la Biblioteca: los carruseles, con el estado del pedido que tenga detrás.
 *
 * Es una ruta aparte de `GET /api/thirtyx/mine` a propósito. `mine` es lo que el tablero
 * pollea sin parar y por eso solo lee el store de asignaciones (chico); esto lee además el
 * de carruseles, que es el archivo más grande del proyecto. Meterlo en el poll del tablero
 * sería pagar ese archivo cada pocos segundos para una vista que se abre y se lee una vez.
 */
export async function GET(request: NextRequest) {
  let designerId: string | null = null;

  if (isHostedMode()) {
    const user = await getSessionUser(request);
    if (!user) {
      return NextResponse.json({ error: "No autenticada", items: [] }, { status: 401 });
    }
    designerId = user.id;
  }

  return NextResponse.json({ items: await buildLibraryItems(designerId) });
}
