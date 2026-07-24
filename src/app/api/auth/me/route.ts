import { NextRequest, NextResponse } from "next/server";
import { getSessionUser } from "@/lib/auth";
import { isHostedMode } from "@/lib/hosted";
import { toPublicUser } from "@/lib/users";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * Sesión actual. En modo local devuelve { hosted: false } para que la UI sepa
 * que no hay login ni cuenta que mostrar.
 */
export async function GET(request: NextRequest) {
  if (!isHostedMode()) {
    return NextResponse.json({ hosted: false, user: null });
  }
  const user = await getSessionUser(request);
  if (!user) {
    return NextResponse.json({ hosted: true, user: null }, { status: 401 });
  }
  return NextResponse.json({ hosted: true, user: toPublicUser(user) });
}
