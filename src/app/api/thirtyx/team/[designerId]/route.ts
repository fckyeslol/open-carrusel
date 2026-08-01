import { NextRequest, NextResponse } from "next/server";
import { isAdminUser } from "@/lib/admin";
import { getSessionUser } from "@/lib/auth";
import { isHostedMode } from "@/lib/hosted";
import { buildLibraryItems } from "@/lib/library";
import { getUserById, toPublicUser } from "@/lib/users";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * El perfil de UNA diseñadora: todas las piezas que se le pueden atribuir.
 *
 * Solo lee. Las acciones del pedido (aprobar, reintentar, eliminar, restaurar) siguen
 * siendo de su dueña y se chequean en sus propias rutas: aprobar dispara el writeback a
 * Prewave y cierra el job del otro lado, así que no es algo para hacer de pasada desde el
 * perfil de otra persona. Editar el carrusel sí funciona — `/carousel/[id]` y
 * `/api/carousels/[id]` nunca estuvieron scopeados, porque el contenido de la pieza no es
 * de nadie en particular.
 */
export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ designerId: string }> }
) {
  if (!isHostedMode()) {
    return NextResponse.json({ error: "Solo en modo hosteado", items: [] }, { status: 404 });
  }
  const user = await getSessionUser(request);
  if (!user) {
    return NextResponse.json({ error: "No autenticada", items: [] }, { status: 401 });
  }
  if (!isAdminUser(user)) {
    return NextResponse.json(
      { error: "No tenés acceso a los perfiles del equipo", items: [] },
      { status: 403 }
    );
  }

  const { designerId } = await params;
  const designer = await getUserById(designerId);
  if (!designer) {
    return NextResponse.json({ error: "Esa diseñadora no existe", items: [] }, { status: 404 });
  }

  return NextResponse.json({
    designer: toPublicUser(designer),
    items: await buildLibraryItems(user.id, { ownedBy: designerId }),
  });
}
