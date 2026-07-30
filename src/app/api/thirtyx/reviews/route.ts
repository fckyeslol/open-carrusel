import { NextRequest, NextResponse } from "next/server";
import { isAdminUser } from "@/lib/admin";
import { getSessionUser } from "@/lib/auth";
import { isHostedMode } from "@/lib/hosted";
import { countsByDesigner, localDay, recentDays, RANGE_DAYS } from "@/lib/reviews";
import { listUsers } from "@/lib/users";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** Ventana por defecto: dos semanas entran cómodas en la barrita y muestran la tendencia. */
const DEFAULT_DAYS = 14;

export interface DesignerReviewStats {
  id: string;
  displayName: string;
  username: string;
  /** Conteo por día, alineado con `days`. */
  counts: number[];
  today: number;
  total: number;
}

/**
 * Dashboard de revisiones del equipo: cuántos carruseles revisó cada diseñadora, por día.
 *
 * Solo para las usuarias de THIRTYX_ADMIN_USERS (ver admin.ts) — es la única pantalla que
 * cruza el scope por diseñadora.
 *
 * Van TODAS las usuarias, incluso las que no revisaron nada: un cero explícito es
 * información (alguien no está revisando), mientras que una fila ausente se lee como si
 * esa persona no existiera.
 */
export async function GET(request: NextRequest) {
  if (!isHostedMode()) {
    return NextResponse.json({ error: "Solo en modo hosteado" }, { status: 404 });
  }
  const user = await getSessionUser(request);
  if (!user) return NextResponse.json({ error: "No autenticada" }, { status: 401 });
  if (!isAdminUser(user)) {
    return NextResponse.json({ error: "No tenés acceso a este panel" }, { status: 403 });
  }

  const pedido = Number(request.nextUrl.searchParams.get("days"));
  const rango = RANGE_DAYS.includes(pedido) ? pedido : DEFAULT_DAYS;

  const days = recentDays(rango);
  const today = localDay();
  const hoyIndex = days.length - 1;

  const [usuarias, counts] = await Promise.all([listUsers(), countsByDesigner(days)]);
  const vacio = new Array<number>(days.length).fill(0);

  const designers: DesignerReviewStats[] = usuarias
    .map((u) => {
      const serie = counts.get(u.id) ?? vacio;
      return {
        id: u.id,
        displayName: u.displayName,
        username: u.username,
        counts: serie,
        today: serie[hoyIndex] ?? 0,
        total: serie.reduce((a, b) => a + b, 0),
      };
    })
    // Primero quien más revisó HOY (que es la pregunta del día a día), y el total como
    // desempate para que las que hoy están en cero no queden ordenadas al azar.
    .sort((a, b) => b.today - a.today || b.total - a.total || a.displayName.localeCompare(b.displayName));

  return NextResponse.json({
    days,
    today,
    rangeDays: rango,
    ranges: RANGE_DAYS,
    designers,
    totals: {
      today: designers.reduce((sum, d) => sum + d.today, 0),
      range: designers.reduce((sum, d) => sum + d.total, 0),
      activeToday: designers.filter((d) => d.today > 0).length,
    },
  });
}
