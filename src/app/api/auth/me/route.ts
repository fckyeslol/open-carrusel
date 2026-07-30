import { NextRequest, NextResponse } from "next/server";
import { isAdminUser } from "@/lib/admin";
import { getSessionUser } from "@/lib/auth";
import { isHostedMode } from "@/lib/hosted";
import { toPublicUser } from "@/lib/users";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * Sesión actual. En modo local devuelve { hosted: false } para que la UI sepa
 * que no hay login ni cuenta que mostrar.
 *
 * `isAdmin` viaja acá porque es parte de quién sos, y la nav lo necesita para decidir si
 * muestra el link a /revisiones. Es solo para pintar: el permiso de verdad lo chequea de
 * nuevo cada endpoint que expone datos del equipo.
 */
export async function GET(request: NextRequest) {
  if (!isHostedMode()) {
    return NextResponse.json({ hosted: false, user: null, isAdmin: false });
  }
  const user = await getSessionUser(request);
  if (!user) {
    return NextResponse.json({ hosted: true, user: null, isAdmin: false }, { status: 401 });
  }
  return NextResponse.json({
    hosted: true,
    user: toPublicUser(user),
    isAdmin: isAdminUser(user),
  });
}
