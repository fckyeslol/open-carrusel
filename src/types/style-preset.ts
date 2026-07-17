import type { AspectRatio } from "./carousel";
import type { BrandConfig } from "./brand";

export interface StylePreset {
  id: string;
  name: string;
  description: string;
  brand: BrandConfig;
  designRules: string;
  exampleSlideHtml: string;
  aspectRatio: AspectRatio;
  tags: string[];
  createdAt: string;
  // ── Integración 30x (presente en los presets de avatar importados) ──────────
  avatarSlug?: string; // slug del avatar (cinthya, guillermo, …)
  avatarStatus?: string; // status del ADN (ready | draft)
}

export interface StylePresetsData {
  presets: StylePreset[];
}
