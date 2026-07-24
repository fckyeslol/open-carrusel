import { NextRequest, NextResponse } from "next/server";
import { getAssignment, setStatus } from "@/lib/assignments";
import { getSessionUser } from "@/lib/auth";
import { getPrewaveToken } from "@/lib/users";
import { isHostedMode } from "@/lib/hosted";
import { getCarousel } from "@/lib/carousels";
import { exportAllSlides } from "@/lib/export-slides";
import { uploadCarousel, submitEdited, resolveCarouselChecklist, PrewaveError } from "@/lib/prewave";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 120;

/**
 * Aprueba un borrador EN REVISIÓN y lo entrega a Prewave con el token de la
 * diseñadora. Dos pasos (flujo recomendado por Prewave):
 *   1. POST /agent-jobs/:id/carousel — sube las láminas (siembra la media del
 *      brief para publicación y cierra el job). Best-effort.
 *   2. POST /production/:briefId/edited — mueve el brief a "en_revisión" con
 *      driveUrl = NUESTRO editor HTML (editable por quien revisa) + checklist.
 * Re-exporta AHORA para capturar los ajustes de la revisión. Solo la dueña aprueba.
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
  if (!a.briefId) {
    return NextResponse.json({ error: "El pedido no tiene brief para entregar a Prewave" }, { status: 409 });
  }

  const token = await getPrewaveToken(user.id);
  if (!token) return NextResponse.json({ error: "Tu Prewave no está conectado" }, { status: 409 });

  const carousel = await getCarousel(a.carouselId);
  if (!carousel || carousel.slides.length === 0) {
    return NextResponse.json({ error: "El carrusel está vacío" }, { status: 409 });
  }

  // Re-exporta ahora: refleja los ajustes de la revisión.
  const files = await exportAllSlides(carousel.slides, carousel.aspectRatio);

  // 1. Media al brief (best-effort: si falla, igual entregamos el link editable).
  try {
    await uploadCarousel(jobId, files, token);
  } catch {
    /* la media es para publicar; el revisor igual ve el link del editor */
  }

  // 2. Transición a en_revisión con el link de NUESTRO editor + checklist del avatar.
  const host = request.headers.get("host") || process.env.DOMAIN || "carruseles.30x.com";
  const editorUrl = `https://${host}/carousel/${a.carouselId}`;
  const checklist = await resolveCarouselChecklist(a.avatarId, token);
  try {
    await submitEdited(a.briefId, editorUrl, checklist, token);
  } catch (e) {
    // No marcamos delivered: la entrega no cerró en Prewave, que pueda reintentar.
    const status = e instanceof PrewaveError ? e.status : 502;
    return NextResponse.json(
      { error: `No se pudo entregar a Prewave: ${(e as Error).message}` },
      { status }
    );
  }

  await setStatus(jobId, "delivered");
  return NextResponse.json({ ok: true });
}
