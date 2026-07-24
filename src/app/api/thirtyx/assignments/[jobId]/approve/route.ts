import { NextRequest, NextResponse } from "next/server";
import { getAssignment, setStatus } from "@/lib/assignments";
import { getSessionUser } from "@/lib/auth";
import { getPrewaveToken } from "@/lib/users";
import { isHostedMode } from "@/lib/hosted";
import { getCarousel } from "@/lib/carousels";
import { exportAllSlides } from "@/lib/export-slides";
import { uploadCarousel, PrewaveError } from "@/lib/prewave";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 120;

/**
 * Aprueba un borrador EN REVISIÓN y lo entrega a Prewave con el token de la
 * diseñadora. Re-exporta el carrusel AHORA (captura los ajustes que hizo durante
 * la revisión) y sube las láminas al endpoint de worker de Prewave (cierra el
 * job del lado de Prewave). Solo la dueña del pedido puede aprobarlo.
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

  // Re-exporta ahora: refleja los ajustes de la revisión.
  const files = await exportAllSlides(carousel.slides, carousel.aspectRatio);
  try {
    await uploadCarousel(jobId, files, token);
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
