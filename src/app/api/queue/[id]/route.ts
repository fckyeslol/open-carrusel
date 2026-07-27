import { NextRequest, NextResponse } from "next/server";
import { PRIORITY, cancel, setPriority as setLanePriority } from "@/lib/job-queue";
import { getAssignment, setPriority as persistPriority } from "@/lib/assignments";
import { isHostedMode } from "@/lib/hosted";
import { getSessionUser } from "@/lib/auth";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** Prioridades que se pueden pedir por nombre, para no exponer números crudos. */
const NAMED: Record<string, number> = {
  urgente: PRIORITY.URGENT,
  normal: PRIORITY.NORMAL,
  baja: PRIORITY.RESIZE,
};

/**
 * Cambia la prioridad de un trabajo del carril, o lo cancela.
 *
 *   PATCH { priority: "urgente" | "normal" | "baja" }   → reordena la fila
 *   PATCH { action: "cancel" }                          → lo saca, o aborta el activo
 *
 * Sobre "cambiar la prioridad del que se está ejecutando": subirle la prioridad a un job
 * activo no lo acelera —ya tiene el carril— pero lo PROTEGE de ser preemptado. Y subirle la
 * prioridad a uno que espera puede echar al activo, si el activo cumple las condiciones de
 * preempción (fase preemptible, pasó el quantum mínimo, no llegó al tope de preempciones).
 *
 * La prioridad se persiste en el assignment además de aplicarse en memoria: si no, un
 * reinicio del server volvería todo a NORMAL y la decisión de la diseñadora se perdería.
 */
export async function PATCH(request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;

  // Los trabajos de la cola 30x son de una diseñadora; el resto (chat, resize) no tiene
  // dueño en el store, así que basta con estar autenticada.
  const assignment = await getAssignment(id);
  if (isHostedMode()) {
    const user = await getSessionUser(request);
    if (!user) return NextResponse.json({ error: "No autenticada" }, { status: 401 });
    if (assignment && assignment.designerId !== user.id) {
      return NextResponse.json({ error: "Este pedido no es tuyo" }, { status: 403 });
    }
  }

  let body: { priority?: string | number; action?: string };
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "Body inválido" }, { status: 400 });
  }

  if (body.action === "cancel") {
    const ok = cancel(id);
    if (!ok) {
      return NextResponse.json(
        { error: "Ese trabajo no está en la cola (quizás ya terminó)" },
        { status: 404 }
      );
    }
    return NextResponse.json({ ok: true, id, action: "cancel" });
  }

  if (body.priority !== undefined) {
    const priority =
      typeof body.priority === "number" ? body.priority : NAMED[String(body.priority)];
    if (priority === undefined || !Number.isFinite(priority)) {
      return NextResponse.json(
        { error: `Prioridad inválida. Usá ${Object.keys(NAMED).join(" | ")} o un número.` },
        { status: 400 }
      );
    }
    // Nunca dejar que la cola pise al chat interactivo: si no, un job "urgente" se
    // adueñaría del carril y la diseñadora esperaría su generación entera.
    const clamped = Math.max(priority, PRIORITY.URGENT);

    const applied = setLanePriority(id, clamped);
    if (assignment) await persistPriority(id, clamped);
    if (!applied && !assignment) {
      return NextResponse.json({ error: "Ese trabajo no existe" }, { status: 404 });
    }
    return NextResponse.json({ ok: true, id, priority: clamped, applied });
  }

  return NextResponse.json(
    { error: 'Nada que hacer. Mandá { priority } o { action: "cancel" }.' },
    { status: 400 }
  );
}
