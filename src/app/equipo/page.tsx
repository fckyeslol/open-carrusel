import { TeamRoster } from "@/components/thirtyx/TeamRoster";

export const dynamic = "force-dynamic";

/**
 * Perfiles del equipo de diseño. Solo para las usuarias de THIRTYX_ADMIN_USERS: el permiso
 * lo aplica GET /api/thirtyx/team, así que quien entre sin acceso ve la página con el
 * mensaje del 403 y ningún dato — mismo criterio que /revisiones.
 */
export default function EquipoPage() {
  return <TeamRoster />;
}
