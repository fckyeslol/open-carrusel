import { NextResponse } from "next/server";
import { listAssignments } from "@/lib/assignments";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * Cola local de asignaciones (lo que llegó por webhook, con su status en vivo).
 * La UI hace poll a ESTA ruta (base local), no a Prewave — la ingesta desde
 * Prewave es 100% push.
 */
export async function GET() {
  const assignments = await listAssignments();
  return NextResponse.json({ assignments });
}
