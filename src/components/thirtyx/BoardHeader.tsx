"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { cn } from "@/lib/utils";

/** Secciones de la diseñadora, en el orden en que las usa. */
const LINKS = [
  { href: "/tablero", label: "Tablero", key: "tablero" },
  { href: "/biblioteca", label: "Biblioteca", key: "biblioteca" },
  { href: "/30x", label: "Generar manual", key: "manual" },
  { href: "/cuenta", label: "Mi cuenta", key: "cuenta" },
] as const;

interface BoardHeaderProps {
  /** Sección actual: se marca como activa y no se navega a sí misma. */
  active: (typeof LINKS)[number]["key"];
}

/** Barra superior compartida por el tablero y la biblioteca. */
export function BoardHeader({ active }: BoardHeaderProps) {
  const router = useRouter();

  const logout = async () => {
    await fetch("/api/auth/logout", { method: "POST" });
    router.replace("/login");
  };

  return (
    <header className="sticky top-0 z-10 flex items-center justify-between border-b border-border bg-background/90 px-6 py-3 backdrop-blur">
      <div className="flex items-center gap-2">
        {/* eslint-disable-next-line @next/next/no-img-element */}
        <img src="/30x/logo-dark.svg" alt="30x" className="h-6 w-auto" />
        <span className="text-sm font-semibold tracking-tight">Open Carrusel</span>
      </div>
      <nav className="flex items-center gap-4 text-sm text-muted-foreground">
        {LINKS.map((l) => (
          <Link
            key={l.key}
            href={l.href}
            aria-current={l.key === active ? "page" : undefined}
            className={cn(
              "transition-colors hover:text-foreground",
              l.key === active && "font-medium text-foreground"
            )}
          >
            {l.label}
          </Link>
        ))}
        <button onClick={logout} className="transition-colors hover:text-destructive">
          Salir
        </button>
      </nav>
    </header>
  );
}
