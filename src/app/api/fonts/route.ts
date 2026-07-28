import { NextResponse } from "next/server";

// Curated list of Google Fonts that work well for social media carousels.
// Las primeras son las tipografías de marca de los avengers 30x (fuente: los
// adn.json de 30x/avatars/): tienen que estar en el selector o la marca de un
// avatar no se puede elegir a mano en la config. Deben coincidir con EDITOR_FONTS
// de src/lib/slide-editor.ts.
const POPULAR_FONTS = [
  // avengers 30x
  { name: "Instrument Serif", category: "serif" }, // Cinthya Sánchez
  { name: "Open Sans", category: "sans-serif" }, // Guillermo Jaramillo
  { name: "Inter", category: "sans-serif" }, // Andrés Bilbao
  { name: "Arimo", category: "sans-serif" }, // Daniel Bilbao
  { name: "Playfair Display", category: "serif" }, // Cora Bilbao (titulares) · Alejandra Deik
  { name: "Poppins", category: "sans-serif" }, // Cora Bilbao (cuerpo) · María José Echeverry
  { name: "Bricolage Grotesque", category: "sans-serif" }, // Dylan Rosemberg
  { name: "Nunito Sans", category: "sans-serif" }, // Liz Hernández
  // resto
  { name: "Montserrat", category: "sans-serif" },
  { name: "Roboto", category: "sans-serif" },
  { name: "Lato", category: "sans-serif" },
  { name: "Oswald", category: "sans-serif" },
  { name: "Raleway", category: "sans-serif" },
  { name: "Merriweather", category: "serif" },
  { name: "Nunito", category: "sans-serif" },
  { name: "Ubuntu", category: "sans-serif" },
  { name: "Rubik", category: "sans-serif" },
  { name: "Work Sans", category: "sans-serif" },
  { name: "DM Sans", category: "sans-serif" },
  { name: "Space Grotesk", category: "sans-serif" },
  { name: "Outfit", category: "sans-serif" },
  { name: "Sora", category: "sans-serif" },
  { name: "Manrope", category: "sans-serif" },
  { name: "Plus Jakarta Sans", category: "sans-serif" },
  { name: "Bebas Neue", category: "sans-serif" },
  { name: "Anton", category: "sans-serif" },
  { name: "Abril Fatface", category: "display" },
  { name: "Cormorant Garamond", category: "serif" },
  { name: "Libre Baskerville", category: "serif" },
  { name: "Lora", category: "serif" },
  { name: "EB Garamond", category: "serif" },
  { name: "Crimson Text", category: "serif" },
  { name: "Source Serif Pro", category: "serif" },
  { name: "DM Serif Display", category: "serif" },
  { name: "Bitter", category: "serif" },
  { name: "Vollkorn", category: "serif" },
  { name: "Caveat", category: "handwriting" },
  { name: "Dancing Script", category: "handwriting" },
  { name: "Pacifico", category: "handwriting" },
  { name: "Satisfy", category: "handwriting" },
  { name: "Great Vibes", category: "handwriting" },
  { name: "JetBrains Mono", category: "monospace" },
  { name: "Fira Code", category: "monospace" },
  { name: "Space Mono", category: "monospace" },
];

export async function GET() {
  return NextResponse.json({ fonts: POPULAR_FONTS });
}
