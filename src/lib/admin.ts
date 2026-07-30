/**
 * Quién puede ver los datos de TODO el equipo.
 *
 * El resto de la app está scopeada por diseñadora: cada una ve sus pedidos, su historial,
 * sus lotes. El dashboard de revisiones (/revisiones) es la primera pantalla que cruza esa
 * línea, así que necesita una lista explícita en vez de asumir que "toda usuaria logueada
 * puede".
 *
 * Se configura con THIRTYX_ADMIN_USERS (usuarias separadas por coma; en modo hosteado el
 * `username` es el email). Es una env var y no una constante para que sumar a alguien no
 * exija tocar código: se cambia la variable y se reinicia. Si no está seteada — o queda
 * vacía — vale el default, para que un typo en el deploy no deje a nadie adentro.
 */
const DEFAULT_ADMINS: readonly string[] = ["isabella@30x.com"];

/** Las usuarias con acceso al dashboard del equipo, normalizadas a minúscula. */
export function adminUsernames(): string[] {
  const configuradas = (process.env.THIRTYX_ADMIN_USERS || "")
    .split(",")
    .map((u) => u.trim().toLowerCase())
    .filter(Boolean);
  return configuradas.length > 0 ? configuradas : [...DEFAULT_ADMINS];
}

/**
 * `username` se compara en minúscula porque `users.ts` lo guarda así al crear la usuaria,
 * pero la env var la escribe una persona y bien puede venir con mayúsculas.
 */
export function isAdminUser(user: { username: string } | null | undefined): boolean {
  if (!user) return false;
  return adminUsernames().includes(user.username.trim().toLowerCase());
}
