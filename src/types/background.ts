/**
 * Fondos reutilizables para las láminas.
 *
 * A diferencia de `ReferenceImage` (que vive dentro de un carrusel y existe para
 * que Claude la mire), un `Background` es global: se sube una vez y se puede
 * aplicar como fondo en cualquier lámina de cualquier carrusel.
 */
export interface Background {
  id: string;
  name: string;
  /** Ruta pública servida por Next, siempre `/uploads/backgrounds/…`. */
  url: string;
  /**
   * Agrupador libre. Al importar desde una carpeta, el nombre de la subcarpeta
   * se convierte en la categoría (ej. `pinterest`, `referencia`, o el slug de un
   * avenger como `cinthya`).
   */
  category: string;
  width: number;
  height: number;
  createdAt: string;
}

export interface BackgroundsData {
  backgrounds: Background[];
}
