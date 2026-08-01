import { NextRequest, NextResponse } from "next/server";
import { isAdminUser } from "@/lib/admin";
import { getSessionUser } from "@/lib/auth";
import { isHostedMode } from "@/lib/hosted";
import { buildLibraryItems } from "@/lib/library";
import { buildTeamRoster } from "@/lib/team";
import { listUsers } from "@/lib/users";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * Los perfiles del equipo de diseño: una carpeta por diseñadora con lo que tiene.
 *
 * Solo para las usuarias de THIRTYX_ADMIN_USERS (ver admin.ts) — junto con /revisiones es
 * la única pantalla que cruza el scope por diseñadora.
 */
export async function GET(request: NextRequest) {
  if (!isHostedMode()) {
    return NextResponse.json(
      { error: "Solo en modo hosteado", members: [], sinDueno: 0 },
      { status: 404 }
    );
  }
  const user = await getSessionUser(request);
  if (!user) {
    return NextResponse.json(
      { error: "No autenticada", members: [], sinDueno: 0 },
      { status: 401 }
    );
  }
  if (!isAdminUser(user)) {
    return NextResponse.json(
      { error: "No tenés acceso a los perfiles del equipo", members: [], sinDueno: 0 },
      { status: 403 }
    );
  }

  const [users, items] = await Promise.all([listUsers(), buildLibraryItems(user.id)]);
  return NextResponse.json(buildTeamRoster(users, items));
}
