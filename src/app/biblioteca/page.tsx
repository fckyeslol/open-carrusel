import { Library } from "@/components/thirtyx/Library";

export const dynamic = "force-dynamic";

/**
 * Historial de la diseñadora, en carpetas por avenger: entregados + eliminados.
 *
 * La carpeta abierta viaja en `?avenger=` y se lee ACÁ, en el server, en vez de con
 * `useSearchParams()` en el cliente: así el shell se pinta del lado del server (con
 * `useSearchParams` toda la página tendría que ir dentro de un Suspense y se vería un
 * parpadeo en blanco en cada carga). Navegar entre carpetas es una navegación blanda:
 * `Library` no se remonta, así que no vuelve a pedir los pedidos.
 */
export default async function BibliotecaPage({
  searchParams,
}: {
  searchParams: Promise<{ avenger?: string | string[] }>;
}) {
  const { avenger } = await searchParams;
  const openKey = Array.isArray(avenger) ? avenger[0] : avenger;
  return <Library openKey={openKey || null} />;
}
