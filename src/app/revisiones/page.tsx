import { ReviewStats } from "@/components/thirtyx/ReviewStats";

export const dynamic = "force-dynamic";

/**
 * Panel de revisiones del equipo. Solo para las usuarias de THIRTYX_ADMIN_USERS: el
 * permiso lo aplica GET /api/thirtyx/reviews, así que quien entre sin acceso ve la página
 * con el mensaje del 403 y ningún dato.
 */
export default function RevisionesPage() {
  return <ReviewStats />;
}
