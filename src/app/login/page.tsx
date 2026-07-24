"use client";

/**
 * Login del modo hosteado. En modo local esta página no se usa (el proxy no
 * redirige acá) — si alguien la abre igual, el POST devuelve 404 y se muestra
 * el error tal cual.
 */
import { FormEvent, Suspense, useState } from "react";
import { useRouter, useSearchParams } from "next/navigation";

function LoginForm() {
  const router = useRouter();
  const searchParams = useSearchParams();
  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);

  async function handleSubmit(e: FormEvent) {
    e.preventDefault();
    if (submitting) return;
    setSubmitting(true);
    setError(null);
    try {
      const res = await fetch("/api/auth/login", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ username, password }),
      });
      const body = await res.json().catch(() => ({}));
      if (!res.ok) {
        setError(body.error || `Error ${res.status}`);
        return;
      }
      const next = searchParams.get("next");
      // Solo rutas internas — nunca redirigir a un dominio externo. Default: el tablero.
      router.push(next && next.startsWith("/") && !next.startsWith("//") ? next : "/tablero");
      router.refresh();
    } catch {
      setError("No se pudo conectar con el servidor");
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <form onSubmit={handleSubmit} className="w-full max-w-sm space-y-5">
      <div className="space-y-1.5">
        <label htmlFor="username" className="block text-sm font-medium text-zinc-300">
          Usuaria
        </label>
        <input
          id="username"
          type="text"
          autoComplete="username"
          autoFocus
          value={username}
          onChange={(e) => setUsername(e.target.value)}
          className="w-full rounded-lg border border-zinc-700 bg-zinc-900 px-3.5 py-2.5 text-zinc-100 outline-none transition focus:border-[#E9FF7B] focus:ring-2 focus:ring-[#E9FF7B]/20"
        />
      </div>
      <div className="space-y-1.5">
        <label htmlFor="password" className="block text-sm font-medium text-zinc-300">
          Contraseña
        </label>
        <input
          id="password"
          type="password"
          autoComplete="current-password"
          value={password}
          onChange={(e) => setPassword(e.target.value)}
          className="w-full rounded-lg border border-zinc-700 bg-zinc-900 px-3.5 py-2.5 text-zinc-100 outline-none transition focus:border-[#E9FF7B] focus:ring-2 focus:ring-[#E9FF7B]/20"
        />
      </div>
      {error && (
        <p role="alert" className="rounded-lg border border-red-900/60 bg-red-950/40 px-3.5 py-2.5 text-sm text-red-300">
          {error}
        </p>
      )}
      <button
        type="submit"
        disabled={submitting || !username || !password}
        className="w-full rounded-lg bg-[#E9FF7B] px-4 py-2.5 font-semibold text-zinc-950 transition hover:bg-[#dff25f] disabled:cursor-not-allowed disabled:opacity-50"
      >
        {submitting ? "Entrando…" : "Entrar"}
      </button>
    </form>
  );
}

export default function LoginPage() {
  return (
    <main className="flex min-h-screen flex-col items-center justify-center bg-zinc-950 px-6">
      <div className="mb-10 text-center">
        {/* eslint-disable-next-line @next/next/no-img-element */}
        <img src="/30x/logo-accent.svg" alt="30x" className="mx-auto mb-4 h-10 w-auto" />
        <h1 className="text-2xl font-semibold tracking-tight text-zinc-100">Open Carrusel</h1>
        <p className="mt-1 text-sm text-zinc-500">Entrá con tu cuenta del equipo</p>
      </div>
      <Suspense>
        <LoginForm />
      </Suspense>
    </main>
  );
}
