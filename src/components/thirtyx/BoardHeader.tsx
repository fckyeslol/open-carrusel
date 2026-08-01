"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { cn } from "@/lib/utils";

/** Claves de sección, para marcar la activa. */
export type Section =
  | "tablero"
  | "biblioteca"
  | "manual"
  | "cuenta"
  | "carruseles"
  | "revisiones"
  | "equipo";

interface NavLink {
  href: string;
  label: string;
  key: Section;
}

/**
 * Secciones de la diseñadora en modo HOSTEADO, en el orden en que las usa.
 */
const HOSTED_LINKS: readonly NavLink[] = [
  { href: "/tablero", label: "Tablero", key: "tablero" },
  { href: "/biblioteca", label: "Biblioteca", key: "biblioteca" },
  { href: "/30x", label: "Generar manual", key: "manual" },
  { href: "/cuenta", label: "Mi cuenta", key: "cuenta" },
];

/**
 * Modo LOCAL: no hay login ni pedidos de Prewave por diseñadora, así que Tablero,
 * Biblioteca, Mi cuenta y Salir no existen — mostrarlos llevaría a pantallas que
 * responden "Solo en modo hosteado".
 */
const LOCAL_LINKS: readonly NavLink[] = [
  { href: "/", label: "Todos los carruseles", key: "carruseles" },
  { href: "/30x", label: "Generar 30x", key: "manual" },
];

/**
 * Solo para las usuarias de THIRTYX_ADMIN_USERS: las únicas secciones que muestran datos de
 * TODO el equipo. Van antes de "Mi cuenta" para no partir el bloque de trabajo diario.
 */
const ADMIN_LINKS: readonly NavLink[] = [
  { href: "/equipo", label: "Equipo", key: "equipo" },
  { href: "/revisiones", label: "Revisiones", key: "revisiones" },
];

interface BoardHeaderProps {
  /** Sección actual: se marca como activa. */
  active: Section;
}

/**
 * Barra superior de las secciones de la diseñadora (tablero, biblioteca, generar).
 *
 * Los links dependen del modo, que se pregunta a /api/auth/me: en local no hay
 * sesión ni pedidos por diseñadora. Hasta que responde no se pinta la nav, para no
 * mostrar por un instante links que no van.
 */
export function BoardHeader({ active }: BoardHeaderProps) {
  const router = useRouter();
  const [hosted, setHosted] = useState<boolean | null>(null);
  const [isAdmin, setIsAdmin] = useState(false);

  useEffect(() => {
    fetch("/api/auth/me")
      .then((r) => r.json())
      .then((b) => {
        setHosted(b?.hosted !== false);
        setIsAdmin(Boolean(b?.isAdmin));
      })
      // Sin respuesta asumimos hosteado: es donde vive esta barra.
      .catch(() => setHosted(true));
  }, []);

  const logout = async () => {
    await fetch("/api/auth/logout", { method: "POST" });
    router.replace("/login");
  };

  const base = hosted === null ? [] : hosted ? HOSTED_LINKS : LOCAL_LINKS;
  const links =
    hosted && isAdmin
      ? [...base.slice(0, -1), ...ADMIN_LINKS, ...base.slice(-1)] // antes de "Mi cuenta"
      : base;

  return (
    <header className="sticky top-0 z-10 flex shrink-0 items-center justify-between border-b border-border bg-background/90 px-6 py-3 backdrop-blur">
      <Link href={hosted === false ? "/" : "/tablero"} className="flex items-center gap-2">
        {/* eslint-disable-next-line @next/next/no-img-element */}
        <img src="/30x/logo-dark.svg" alt="30x" className="h-6 w-auto" />
        <span className="text-sm font-semibold tracking-tight">Open Carrusel</span>
      </Link>
      <nav className="flex items-center gap-4 text-sm text-muted-foreground">
        {links.map((l) => (
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
        {hosted && (
          <button onClick={logout} className="transition-colors hover:text-destructive">
            Salir
          </button>
        )}
      </nav>
    </header>
  );
}
