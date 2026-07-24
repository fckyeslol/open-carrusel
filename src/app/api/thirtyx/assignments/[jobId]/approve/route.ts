import { NextRequest, NextResponse } from "next/server";
import { getAssignment, setStatus } from "@/lib/assignments";
import { getSessionUser } from "@/lib/auth";
import { getPrewaveToken } from "@/lib/users";
import { isHostedMode } from "@/lib/hosted";
import { getCarousel } from "@/lib/carousels";
import { completeJob, PrewaveError } from "@/lib/prewave";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 120;

/**
 * Aprueba un borrador EN REVISIÓN y lo entrega a Prewave con el token de la
 * diseñadora. El result_url del job apunta a NUESTRO editor (HTML editable):
 * quien revisa en Prewave abre ese link y puede hacer cambios. Marcar el job
 * `done` mueve el brief de "por diseñar" a "en revisión". Solo la dueña aprueba.
 */
export async function POST(request: NextRequest, { params }: { params: Promise<{ jobId: string }> }) {
  if (!isHostedMode()) {
    return NextResponse.json({ error: "Solo en modo hosteado" }, { status: 404 });
  }
  const user = await getSessionUser(request);
  if (!user) return NextResponse.json({ error: "No autenticada" }, { status: 401 });

  const { jobId } = await params;
  const a = await getAssignment(jobId);
  if (!a) return NextResponse.json({ error: "Pedido no encontrado" }, { status: 404 });
  if (a.designerId !== user.id) {
    return NextResponse.json({ error: "Este pedido no es tuyo" }, { status: 403 });
  }
  if (a.status !== "pending_review") {
    return NextResponse.json(
      { error: `El pedido no está en revisión (está en "${a.status}")` },
      { status: 409 }
    );
  }
  if (!a.carouselId) {
    return NextResponse.json({ error: "El pedido no tiene un carrusel asociado" }, { status: 409 });
  }

  const token = await getPrewaveToken(user.id);
  if (!token) return NextResponse.json({ error: "Tu Prewave no está conectado" }, { status: 409 });

  const carousel = await getCarousel(a.carouselId);
  if (!carousel || carousel.slides.length === 0) {
    return NextResponse.json({ error: "El carrusel está vacío" }, { status: 409 });
  }

  // Opción A: el entregable es NUESTRO editor (HTML editable). El revisor de
  // Prewave abre este link y puede seguir ajustando. `done` → el brief pasa a
  // "en revisión".
  const host = request.headers.get("host") || process.env.DOMAIN || "carruseles.30x.com";
  const editorUrl = `https://${host}/carousel/${a.carouselId}`;
  try {
    await completeJob(jobId, editorUrl, token);
  } catch (e) {
    // No marcamos delivered: la entrega no llegó a Prewave, que pueda reintentar.
    const status = e instanceof PrewaveError ? e.status : 502;
    return NextResponse.json(
      { error: `No se pudo entregar a Prewave: ${(e as Error).message}` },
      { status }
    );
  }

  await setStatus(jobId, "delivered");
  return NextResponse.json({ ok: true });
}
