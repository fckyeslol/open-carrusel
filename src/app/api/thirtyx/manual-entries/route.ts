import { NextRequest, NextResponse } from "next/server";
import {
  listManualEntries,
  listManualEntriesForDesigner,
} from "@/lib/manual-entries";
import { getSessionUser } from "@/lib/auth";
import { isHostedMode } from "@/lib/hosted";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * Historial de entradas manuales (lo que se generó pegando una URL en /30x).
 * El equivalente de /api/thirtyx/assignments para el flujo manual: la UI hace
 * poll acá y nunca a Instagram.
 *
 * En modo hosteado cada diseñadora ve lo suyo más las entradas sin dueña (las
 * sembradas desde carruseles anteriores al historial), marcadas con `shared` para
 * que la UI pueda decir que son del equipo. En local no hay sesión ni dueñas: el
 * historial es de la máquina y `shared` no viaja.
 */
export async function GET(request: NextRequest) {
  if (!isHostedMode()) {
    return NextResponse.json({ entries: await listManualEntries() });
  }
  const user = await getSessionUser(request);
  if (!user) {
    return NextResponse.json({ error: "No autenticada", entries: [] }, { status: 401 });
  }
  const entries = (await listManualEntriesForDesigner(user.id)).map((e) => ({
    ...e,
    shared: e.designerId === null,
  }));
  return NextResponse.json({ entries });
}
