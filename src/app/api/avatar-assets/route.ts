import { NextResponse } from "next/server";
import { listAvatarAssets } from "@/lib/avatar-assets";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** Lista todos los avatares con sus assets de marca (logo/fotos/fondos/referencias). */
export async function GET() {
  try {
    const avatars = await listAvatarAssets();
    return NextResponse.json({ avatars });
  } catch (err) {
    console.error("[avatar-assets] error listando:", err);
    return NextResponse.json({ error: "No se pudieron listar los assets" }, { status: 500 });
  }
}
