import { DesignerProfile } from "@/components/thirtyx/DesignerProfile";

export const dynamic = "force-dynamic";

/**
 * El perfil de una diseñadora. El id viaja en la ruta y se lee acá, en el server, para que
 * el componente cliente no tenga que pasar por `useParams()` y su Suspense.
 *
 * El permiso lo aplica GET /api/thirtyx/team/[designerId].
 */
export default async function DesignerPage({
  params,
}: {
  params: Promise<{ designerId: string }>;
}) {
  const { designerId } = await params;
  return <DesignerProfile designerId={designerId} />;
}
