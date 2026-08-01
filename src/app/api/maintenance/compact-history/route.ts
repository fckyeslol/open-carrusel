import { NextResponse } from "next/server";
import { compactarHistorial } from "@/lib/carousels";
import { INTERNAL_TOKEN_HEADER, isHostedMode } from "@/lib/hosted";
import { MAX_VERSIONS } from "@/types/carousel";

/**
 * Recorta el historial de deshacer de todas las láminas guardadas. Se maneja con
 * `scripts/compact-carousels.mjs`, que es dry-run por defecto.
 *
 * Existe como endpoint y no como script que edita el JSON porque los datos están vivos:
 * la app escribe el store más de 1600 veces por día, así que bajar el archivo, editarlo
 * y volver a subirlo pisaría todo lo que se escribió en el medio. Entrando por acá la
 * compactación pasa por el mismo mutex que cualquier otra escritura (ver
 * `compactarHistorial`).
 *
 * EXIGE el token interno incluso en modo hosteado, donde `proxy.ts` ya dejaría pasar
 * cualquier sesión válida: esto descarta datos que no se pueden reconstruir, así que no
 * puede quedar al alcance de un click desde el navegador de una diseñadora.
 */
export async function POST(request: Request) {
  const token = process.env.INTERNAL_API_TOKEN;
  const enviado = request.headers.get(INTERNAL_TOKEN_HEADER);

  // Local (sin modo hosteado y sin token configurado) queda abierto, igual que el resto
  // de la app en la máquina de una diseñadora, donde no hay nada que aislar.
  const exigeToken = isHostedMode() || Boolean(token);
  if (exigeToken && (!token || enviado !== token)) {
    return NextResponse.json({ error: "Solo interno" }, { status: 403 });
  }

  let body: { conservar?: unknown; aplicar?: unknown } = {};
  try {
    body = await request.json();
  } catch {
    // Sin cuerpo se usa el default: dry-run con el tope actual.
  }

  const conservar = body.conservar === undefined ? MAX_VERSIONS : Number(body.conservar);
  if (!Number.isInteger(conservar) || conservar < 0) {
    return NextResponse.json(
      { error: `conservar debe ser un entero >= 0, recibí ${String(body.conservar)}` },
      { status: 400 }
    );
  }

  try {
    const resultado = await compactarHistorial(conservar, body.aplicar === true);
    return NextResponse.json(resultado);
  } catch (err) {
    return NextResponse.json(
      { error: err instanceof Error ? err.message : "La compactación falló" },
      { status: 500 }
    );
  }
}
