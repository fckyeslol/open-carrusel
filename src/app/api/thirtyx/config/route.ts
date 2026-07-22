import { NextRequest, NextResponse } from "next/server";
import { getPrewaveConfig, setPrewaveConfig, isConfigured } from "@/lib/prewave";
import {
  getHiggsfieldConfig,
  setHiggsfieldConfig,
  isConfigured as isHiggsfieldConfigured,
} from "@/lib/higgsfield";
import { listAvatarPresets } from "@/lib/style-presets";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** Estado de la integración 30x: si Prewave está configurado + avatares disponibles. */
export async function GET() {
  const cfg = await getPrewaveConfig();
  const hf = await getHiggsfieldConfig();
  const avatars = await listAvatarPresets();
  return NextResponse.json({
    prewave: {
      apiBase: cfg.apiBase,
      configured: isConfigured(cfg),
      hasToken: Boolean(cfg.token),
      hasApiKey: Boolean(cfg.apiKey),
    },
    higgsfield: {
      configured: isHiggsfieldConfigured(hf),
      hasApiKey: Boolean(hf.apiKey),
      hasApiSecret: Boolean(hf.apiSecret),
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

/** Guarda config de Prewave y/o las claves de Higgsfield (todo desde el panel /30x). */
export async function POST(request: NextRequest) {
  let body: {
    apiBase?: string;
    token?: string;
    apiKey?: string;
    higgsfield?: { apiKey?: string; apiSecret?: string };
  };
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

  // Higgsfield: solo actualizamos los campos que llegan NO vacíos (para no borrar
  // una clave ya guardada al mandar el form con el campo en blanco).
  let hfConfigured: boolean | undefined;
  if (body.higgsfield && typeof body.higgsfield === "object") {
    const hfUpdates: { apiKey?: string; apiSecret?: string } = {};
    if (typeof body.higgsfield.apiKey === "string" && body.higgsfield.apiKey.trim())
      hfUpdates.apiKey = body.higgsfield.apiKey.trim();
    if (typeof body.higgsfield.apiSecret === "string" && body.higgsfield.apiSecret.trim())
      hfUpdates.apiSecret = body.higgsfield.apiSecret.trim();
    if (Object.keys(hfUpdates).length) {
      const hf = await setHiggsfieldConfig(hfUpdates);
      hfConfigured = isHiggsfieldConfigured(hf);
    }
  }

  return NextResponse.json({
    ok: true,
    configured: isConfigured(cfg),
    ...(hfConfigured !== undefined ? { higgsfieldConfigured: hfConfigured } : {}),
  });
}
