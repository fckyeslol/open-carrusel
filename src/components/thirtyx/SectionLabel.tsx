/**
 * Encabezado de sección editorial: número + rótulo + regla + meta a la derecha.
 * Es el recurso que le da ritmo a /30x y la saca del look "card genérica".
 */
export function SectionLabel({
  index,
  children,
  aside,
}: {
  index: string;
  children: React.ReactNode;
  aside?: React.ReactNode;
}) {
  return (
    <div className="mb-4 flex items-baseline gap-3">
      {/* accent-strong, no accent: este es TEXTO y necesita 4.5:1 (ver globals.css). */}
      <span className="font-mono text-[11px] tabular-nums text-accent-strong">{index}</span>
      <h2 className="text-[11px] font-semibold uppercase tracking-[0.18em]">{children}</h2>
      <span aria-hidden="true" className="h-px flex-1 bg-border" />
      {aside && <span className="text-[11px] text-muted-foreground">{aside}</span>}
    </div>
  );
}
