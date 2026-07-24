"use client";

/**
 * Cuenta de la usuaria (modo hosteado): conectar su Claude (token de
 * `claude setup-token`) y cambiar la contraseña. El token nunca se muestra de
 * vuelta — solo el estado conectado/no conectado.
 */
import { FormEvent, useEffect, useState } from "react";
import { useRouter } from "next/navigation";

interface PublicUser {
  id: string;
  username: string;
  displayName: string;
  hasClaudeToken: boolean;
  mustChangePassword: boolean;
}

export default function CuentaPage() {
  const router = useRouter();
  const [user, setUser] = useState<PublicUser | null>(null);
  const [loading, setLoading] = useState(true);

  const [token, setToken] = useState("");
  const [tokenMsg, setTokenMsg] = useState<{ ok: boolean; text: string } | null>(null);
  const [savingToken, setSavingToken] = useState(false);

  const [currentPass, setCurrentPass] = useState("");
  const [newPass, setNewPass] = useState("");
  const [passMsg, setPassMsg] = useState<{ ok: boolean; text: string } | null>(null);
  const [savingPass, setSavingPass] = useState(false);

  useEffect(() => {
    fetch("/api/auth/me")
      .then((r) => (r.ok ? r.json() : Promise.reject(r.status)))
      .then((body) => {
        if (!body.hosted) {
          router.replace("/");
          return;
        }
        setUser(body.user);
      })
      .catch(() => router.replace("/login"))
      .finally(() => setLoading(false));
  }, [router]);

  async function saveToken(e: FormEvent) {
    e.preventDefault();
    if (savingToken) return;
    setSavingToken(true);
    setTokenMsg(null);
    try {
      const res = await fetch("/api/auth/claude-token", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ token }),
      });
      const body = await res.json().catch(() => ({}));
      if (!res.ok) {
        setTokenMsg({ ok: false, text: body.error || `Error ${res.status}` });
        return;
      }
      setUser(body.user);
      setToken("");
      setTokenMsg({ ok: true, text: "Tu Claude quedó conectado — ya podés generar carruseles." });
    } catch {
      setTokenMsg({ ok: false, text: "No se pudo conectar con el servidor" });
    } finally {
      setSavingToken(false);
    }
  }

  async function savePassword(e: FormEvent) {
    e.preventDefault();
    if (savingPass) return;
    setSavingPass(true);
    setPassMsg(null);
    try {
      const res = await fetch("/api/auth/password", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ current: currentPass, next: newPass }),
      });
      const body = await res.json().catch(() => ({}));
      if (!res.ok) {
        setPassMsg({ ok: false, text: body.error || `Error ${res.status}` });
        return;
      }
      setUser(body.user);
      setCurrentPass("");
      setNewPass("");
      setPassMsg({ ok: true, text: "Contraseña actualizada." });
    } catch {
      setPassMsg({ ok: false, text: "No se pudo conectar con el servidor" });
    } finally {
      setSavingPass(false);
    }
  }

  async function logout() {
    await fetch("/api/auth/logout", { method: "POST" });
    router.replace("/login");
  }

  if (loading || !user) {
    return (
      <main className="flex min-h-screen items-center justify-center bg-zinc-950 text-zinc-500">
        Cargando…
      </main>
    );
  }

  const inputCls =
    "w-full rounded-lg border border-zinc-700 bg-zinc-900 px-3.5 py-2.5 text-zinc-100 outline-none transition focus:border-[#E9FF7B] focus:ring-2 focus:ring-[#E9FF7B]/20";
  const btnCls =
    "rounded-lg bg-[#E9FF7B] px-4 py-2.5 font-semibold text-zinc-950 transition hover:bg-[#dff25f] disabled:cursor-not-allowed disabled:opacity-50";

  return (
    <main className="min-h-screen bg-zinc-950 px-6 py-10">
      <div className="mx-auto w-full max-w-2xl space-y-10">
        <header className="flex items-center justify-between">
          <div>
            <h1 className="text-2xl font-semibold tracking-tight text-zinc-100">
              Hola, {user.displayName}
            </h1>
            <p className="mt-1 text-sm text-zinc-500">@{user.username}</p>
          </div>
          <div className="flex items-center gap-3">
            <a href="/" className="text-sm text-zinc-400 transition hover:text-zinc-200">
              ← Volver a la app
            </a>
            <button onClick={logout} className="text-sm text-zinc-400 transition hover:text-red-300">
              Salir
            </button>
          </div>
        </header>

        {user.mustChangePassword && (
          <p className="rounded-lg border border-amber-900/60 bg-amber-950/40 px-4 py-3 text-sm text-amber-300">
            Estás usando la contraseña temporal — cambiala acá abajo antes de seguir.
          </p>
        )}

        <section className="rounded-xl border border-zinc-800 bg-zinc-900/50 p-6">
          <div className="mb-4 flex items-center justify-between">
            <h2 className="text-lg font-semibold text-zinc-100">Tu Claude</h2>
            <span
              className={
                user.hasClaudeToken
                  ? "rounded-full bg-emerald-950/60 px-3 py-1 text-xs font-medium text-emerald-300"
                  : "rounded-full bg-zinc-800 px-3 py-1 text-xs font-medium text-zinc-400"
              }
            >
              {user.hasClaudeToken ? "Conectado" : "Sin conectar"}
            </span>
          </div>
          <ol className="mb-5 list-decimal space-y-1.5 pl-5 text-sm text-zinc-400">
            <li>
              En tu compu, abrí una terminal y corré{" "}
              <code className="rounded bg-zinc-800 px-1.5 py-0.5 font-mono text-xs text-[#E9FF7B]">
                claude setup-token
              </code>
            </li>
            <li>Logueate con tu cuenta del equipo cuando se abra el navegador</li>
            <li>Copiá el token que te muestra y pegalo acá:</li>
          </ol>
          <form onSubmit={saveToken} className="space-y-3">
            <input
              type="password"
              autoComplete="off"
              placeholder="Pegá tu token acá"
              value={token}
              onChange={(e) => setToken(e.target.value)}
              className={inputCls}
            />
            {tokenMsg && (
              <p
                role="alert"
                className={
                  tokenMsg.ok
                    ? "rounded-lg border border-emerald-900/60 bg-emerald-950/40 px-3.5 py-2.5 text-sm text-emerald-300"
                    : "rounded-lg border border-red-900/60 bg-red-950/40 px-3.5 py-2.5 text-sm text-red-300"
                }
              >
                {tokenMsg.text}
              </p>
            )}
            <button type="submit" disabled={savingToken || !token.trim()} className={btnCls}>
              {savingToken ? "Guardando…" : user.hasClaudeToken ? "Reemplazar token" : "Conectar mi Claude"}
            </button>
          </form>
          <p className="mt-4 text-xs text-zinc-600">
            El token se guarda cifrado y solo se usa para generar TUS carruseles. Dura ~1 año; si lo
            regenerás, pegá el nuevo acá.
          </p>
        </section>

        <section className="rounded-xl border border-zinc-800 bg-zinc-900/50 p-6">
          <h2 className="mb-4 text-lg font-semibold text-zinc-100">Cambiar contraseña</h2>
          <form onSubmit={savePassword} className="space-y-3">
            <input
              type="password"
              autoComplete="current-password"
              placeholder="Contraseña actual"
              value={currentPass}
              onChange={(e) => setCurrentPass(e.target.value)}
              className={inputCls}
            />
            <input
              type="password"
              autoComplete="new-password"
              placeholder="Contraseña nueva (mínimo 8 caracteres)"
              value={newPass}
              onChange={(e) => setNewPass(e.target.value)}
              className={inputCls}
            />
            {passMsg && (
              <p
                role="alert"
                className={
                  passMsg.ok
                    ? "rounded-lg border border-emerald-900/60 bg-emerald-950/40 px-3.5 py-2.5 text-sm text-emerald-300"
                    : "rounded-lg border border-red-900/60 bg-red-950/40 px-3.5 py-2.5 text-sm text-red-300"
                }
              >
                {passMsg.text}
              </p>
            )}
            <button
              type="submit"
              disabled={savingPass || !currentPass || newPass.length < 8}
              className={btnCls}
            >
              {savingPass ? "Guardando…" : "Cambiar contraseña"}
            </button>
          </form>
        </section>
      </div>
    </main>
  );
}
