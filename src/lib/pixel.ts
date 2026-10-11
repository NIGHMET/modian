/** Pixel buffer helpers. Opaque colors are stored as 0xffRRGGBB; 0 is transparent. */

export type Tool = "brush" | "eraser" | "fill";

export const MIN_SIZE = 8;
export const MAX_SIZE = 128;
export const INITIAL_SIZE = 32;
export const HISTORY_LIMIT = 80;

export type Palette = {
  id: string;
  name: string;
  colors: readonly string[];
};

/** Official limited sets — DawnBringer 16, PICO-8, Game Boy, Commodore 64. */
export const PALETTES: readonly Palette[] = [
  {
    id: "db16",
    name: "黎明",
    colors: [
      "#140c1c",
      "#442434",
      "#30346d",
      "#4e4a4e",
      "#854c30",
      "#346524",
      "#d04648",
      "#757161",
      "#597dce",
      "#d27d2c",
      "#8595a1",
      "#6daa2c",
      "#d2aa99",
      "#6dc2ca",
      "#dad45e",
      "#deeed6",
    ],
  },
  {
    id: "pico8",
    name: "PICO-8",
    colors: [
      "#000000",
      "#1d2b53",
      "#7e2553",
      "#008751",
      "#ab5236",
      "#5f574f",
      "#c2c3c7",
      "#fff1e8",
      "#ff004d",
      "#ffa300",
      "#ffec27",
      "#00e436",
      "#29adff",
      "#83769c",
      "#ff77a8",
      "#ffccaa",
    ],
  },
  {
    id: "gb",
    name: "掌机",
    colors: ["#0f380f", "#306230", "#8bac0f", "#9bbc0f"],
  },
  {
    id: "c64",
    name: "C64",
    colors: [
      "#000000",
      "#ffffff",
      "#880000",
      "#aaffee",
      "#cc44cc",
      "#00cc55",
      "#0000aa",
      "#eeee77",
      "#dd8855",
      "#664400",
      "#ff7777",
      "#333333",
      "#777777",
      "#aaff66",
      "#0088ff",
      "#bbbbbb",
    ],
  },
] as const;

export const DEFAULT_PALETTE_ID = "db16";

export function paletteById(id: string): Palette {
  return PALETTES.find((palette) => palette.id === id) ?? PALETTES[0];
}

export function clampSize(value: number): number {
  if (!Number.isFinite(value)) return MIN_SIZE;
  return Math.max(MIN_SIZE, Math.min(MAX_SIZE, Math.round(value)));
}

/** Pack #rrggbb into an unsigned 0xffRRGGBB so it matches Uint32Array reads. */
export function pack(hex: string): number {
  const rgb = Number.parseInt(hex.slice(1), 16);
  return (0xff000000 | rgb) >>> 0;
}

export function hexOf(color: number): string {
  return `#${(color & 0xffffff).toString(16).padStart(6, "0").toUpperCase()}`;
}

export function forLine(
  x0: number,
  y0: number,
  x1: number,
  y1: number,
  plot: (x: number, y: number) => void,
): void {
  const dx = Math.abs(x1 - x0);
  const sx = x0 < x1 ? 1 : -1;
  const dy = -Math.abs(y1 - y0);
  const sy = y0 < y1 ? 1 : -1;
  let err = dx + dy;
  for (;;) {
    plot(x0, y0);
    if (x0 === x1 && y0 === y1) break;
    const e2 = err * 2;
    if (e2 >= dy) {
      err += dy;
      x0 += sx;
    }
    if (e2 <= dx) {
      err += dx;
      y0 += sy;
    }
  }
}

export function floodFill(
  pixels: Pixels,
  w: number,
  h: number,
  x: number,
  y: number,
  replacement: number,
): boolean {
  const start = y * w + x;
  const target = pixels[start] ?? 0;
  if (target === replacement) return false;
  const stack = [start];
  const seen = new Uint8Array(pixels.length);
  let changed = false;
  while (stack.length > 0) {
    const index = stack.pop() as number;
    if (seen[index]) continue;
    seen[index] = 1;
    if (pixels[index] !== target) continue;
    pixels[index] = replacement;
    changed = true;
    const cx = index % w;
    const cy = (index / w) | 0;
    if (cx > 0) stack.push(index - 1);
    if (cx + 1 < w) stack.push(index + 1);
    if (cy > 0) stack.push(index - w);
    if (cy + 1 < h) stack.push(index + w);
  }
  return changed;
}

export function resample(src: Pixels, sw: number, sh: number, dw: number, dh: number): Pixels {
  const dst = new Uint32Array(dw * dh);
  for (let y = 0; y < dh; y++) {
    const sy = Math.min(sh - 1, Math.floor((y * sh) / dh));
    for (let x = 0; x < dw; x++) {
      const sx = Math.min(sw - 1, Math.floor((x * sw) / dw));
      dst[y * dw + x] = src[sy * sw + sx] ?? 0;
    }
  }
  return dst;
}

export function blit(canvas: HTMLCanvasElement, pixels: Pixels, w: number, h: number): void {
  if (canvas.width !== w) canvas.width = w;
  if (canvas.height !== h) canvas.height = h;
  const ctx = canvas.getContext("2d");
  if (!ctx) return;
  const image = ctx.createImageData(w, h);
  const data = image.data;
  for (let i = 0; i < pixels.length; i++) {
    const color = pixels[i] ?? 0;
    const offset = i * 4;
    if (color === 0) {
      data[offset] = 0;
      data[offset + 1] = 0;
      data[offset + 2] = 0;
      data[offset + 3] = 0;
      continue;
    }
    data[offset] = (color >>> 16) & 255;
    data[offset + 1] = (color >>> 8) & 255;
    data[offset + 2] = color & 255;
    data[offset + 3] = 255;
  }
  ctx.putImageData(image, 0, 0);
}

export function hasInk(pixels: Pixels): boolean {
  for (let i = 0; i < pixels.length; i++) {
    if (pixels[i] !== 0) return true;
  }
  return false;
}

export type Pixels = Uint32Array<ArrayBufferLike>;

export type Snapshot = { w: number; h: number; data: Pixels };

const TOOLS: readonly Tool[] = ["brush", "eraser", "fill"];

export type StoredDoc = {
  w: number;
  h: number;
  pixels: Pixels;
  paletteId: string;
  color: number;
  tool: Tool;
  showGrid: boolean;
};

export function decodeDoc(raw: unknown): StoredDoc | null {
  if (!raw || typeof raw !== "object") return null;
  const record = raw as Record<string, unknown>;
  const w = record.w;
  const h = record.h;
  if (typeof w !== "number" || typeof h !== "number") return null;
  if (w < MIN_SIZE || w > MAX_SIZE || h < MIN_SIZE || h > MAX_SIZE) return null;
  if (!Number.isInteger(w) || !Number.isInteger(h)) return null;
  if (!Array.isArray(record.pixels) || record.pixels.length !== w * h) return null;
  const pixels: Pixels = new Uint32Array(w * h);
  for (let i = 0; i < record.pixels.length; i++) {
    const value = record.pixels[i];
    pixels[i] = typeof value === "number" && Number.isFinite(value) ? value >>> 0 : 0;
  }
  const paletteId =
    typeof record.paletteId === "string" && PALETTES.some((palette) => palette.id === record.paletteId)
      ? record.paletteId
      : DEFAULT_PALETTE_ID;
  const color = typeof record.color === "number" && Number.isFinite(record.color) ? record.color >>> 0 : pack(paletteById(paletteId).colors[6] ?? paletteById(paletteId).colors[0]);
  const tool = TOOLS.includes(record.tool as Tool) ? (record.tool as Tool) : "brush";
  const showGrid = typeof record.showGrid === "boolean" ? record.showGrid : true;
  return { w, h, pixels, paletteId, color, tool, showGrid };
}
