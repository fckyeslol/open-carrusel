import { NextRequest, NextResponse } from "next/server";
import { getPrewaveConfig, setPrewaveConfig, isConfigured } from "@/lib/prewave";
import { listAvatarPresets } from "@/lib/style-presets";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** Estado de la integración 30x: si Prewave está configurado + avatares disponibles. */
export async function GET() {
  const cfg = await getPrewaveConfig();
  const avatars = await listAvatarPresets();
  return NextResponse.json({
    prewave: {
      apiBase: cfg.apiBase,
      configured: isConfigured(cfg),
      hasToken: Boolean(cfg.token),
      hasApiKey: Boolean(cfg.apiKey),
    },
    avatars: avatars.map((p) => ({
      slug: p.avatarSlug,
      name: p.name,
      presetId: p.id,
      status: p.avatarStatus ?? "unknown",
      hasFormat: Boolean(p.exampleSlideHtml),
    })),
  });
}

/** Guarda el token de la diseñadora / API key / base URL de Prewave. */
export async function POST(request: NextRequest) {
  let body: { apiBase?: string; token?: string; apiKey?: string };
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "JSON inválido" }, { status: 400 });
  }
  const updates: { apiBase?: string; token?: string; apiKey?: string } = {};
  if (typeof body.apiBase === "string") updates.apiBase = body.apiBase.trim();
  if (typeof body.token === "string") updates.token = body.token.trim() || undefined;
  if (typeof body.apiKey === "string") updates.apiKey = body.apiKey.trim() || undefined;
  const cfg = await setPrewaveConfig(updates);
  return NextResponse.json({ ok: true, configured: isConfigured(cfg) });
}
