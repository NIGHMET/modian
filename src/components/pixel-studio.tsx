import { useEffect, useLayoutEffect, useRef, useState, type PointerEvent as ReactPointerEvent, type ReactNode } from "react";
import {
  Download,
  Eraser,
  Grid3x3,
  Minus,
  PaintBucket,
  Pencil,
  Plus,
  Redo2,
  Trash2,
  Undo2,
} from "lucide-react";
import {
  DEFAULT_PALETTE_ID,
  HISTORY_LIMIT,
  INITIAL_SIZE,
  PALETTES,
  blit,
  clampSize,
  decodeDoc,
  floodFill,
  forLine,
  hasInk,
  hexOf,
  pack,
  paletteById,
  resample,
  type Snapshot,
  type Tool,
  type Pixels,
} from "@/lib/pixel";

const STORAGE_KEY = "modian.v1";

const TOOLS: { id: Tool; label: string; shortcut: string; icon: typeof Pencil }[] = [
  { id: "brush", label: "画笔", shortcut: "B", icon: Pencil },
  { id: "eraser", label: "橡皮", shortcut: "E", icon: Eraser },
  { id: "fill", label: "填充", shortcut: "F", icon: PaintBucket },
];

const PRESETS = [16, 24, 32, 48, 64] as const;

type Handlers = {
  down: (event: ReactPointerEvent<HTMLDivElement>) => void;
  move: (event: ReactPointerEvent<HTMLDivElement>) => void;
  up: (event: ReactPointerEvent<HTMLDivElement>) => void;
  undo: () => void;
  redo: () => void;
};

function cellFrom(event: { clientX: number; clientY: number }, el: HTMLElement, w: number, h: number) {
  const rect = el.getBoundingClientRect();
  if (rect.width <= 0 || rect.height <= 0) return null;
  const x = Math.floor(((event.clientX - rect.left) / rect.width) * w);
  const y = Math.floor(((event.clientY - rect.top) / rect.height) * h);
  if (x < 0 || y < 0 || x >= w || y >= h) return null;
  return { x, y };
}

function trim(stack: Snapshot[]) {
  if (stack.length > HISTORY_LIMIT) stack.splice(0, stack.length - HISTORY_LIMIT);
}

export function PixelStudio() {
  const initialPalette = paletteById(DEFAULT_PALETTE_ID);
  const initialColor = pack(initialPalette.colors[6] ?? initialPalette.colors[0]);

  const pixelsRef = useRef<Pixels>(new Uint32Array(INITIAL_SIZE * INITIAL_SIZE));
  const wRef = useRef(INITIAL_SIZE);
  const hRef = useRef(INITIAL_SIZE);
  const colorRef = useRef(initialColor);
  const toolRef = useRef<Tool>("brush");
  const showGridRef = useRef(true);
  const scaleRef = useRef(8);
  const hoverRef = useRef<{ x: number; y: number } | null>(null);
  const drawingRef = useRef(false);
  const dirtyRef = useRef(false);
  const beforeRef = useRef<Pixels | null>(null);
  const pointerRef = useRef<number | null>(null);
  const lastRef = useRef<{ x: number; y: number } | null>(null);
  const pastRef = useRef<Snapshot[]>([]);
  const futureRef = useRef<Snapshot[]>([]);
  const confirmRef = useRef(false);
  const readyRef = useRef(false);
  const pixRef = useRef<HTMLCanvasElement>(null);
  const ovRef = useRef<HTMLCanvasElement>(null);
  const frameRef = useRef<HTMLDivElement>(null);
  const stageRef = useRef<HTMLDivElement>(null);
  const coordRef = useRef<HTMLSpanElement>(null);
  const cancelRef = useRef<HTMLButtonElement>(null);

  const [w, setW] = useState(INITIAL_SIZE);
  const [h, setH] = useState(INITIAL_SIZE);
  const [tool, setTool] = useState<Tool>("brush");
  const [color, setColor] = useState(initialColor);
  const [paletteId, setPaletteId] = useState(DEFAULT_PALETTE_ID);
  const [showGrid, setShowGrid] = useState(true);
  const [ink, setInk] = useState(false);
  const [hist, setHist] = useState(0);
  const [rev, setRev] = useState(0);
  const [ready, setReady] = useState(false);
  const [confirmClear, setConfirmClear] = useState(false);
  const [exported, setExported] = useState(false);
  const [box, setBox] = useState({ scale: 8, left: 0, top: 0 });

  const palette = paletteById(paletteId);
  const canUndo = pastRef.current.length > 0;
  const canRedo = futureRef.current.length > 0;
  void hist;

  wRef.current = w;
  hRef.current = h;
  colorRef.current = color;
  toolRef.current = tool;
  showGridRef.current = showGrid;
  scaleRef.current = box.scale;
  confirmRef.current = confirmClear;
  readyRef.current = ready;

  function paint() {
    const canvas = pixRef.current;
    if (!canvas) return;
    blit(canvas, pixelsRef.current, wRef.current, hRef.current);
  }

  function drawOverlay() {
    const overlay = ovRef.current;
    if (!overlay) return;
    const width = wRef.current;
    const height = hRef.current;
    const scale = scaleRef.current;
    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    const bitmapW = Math.max(1, Math.round(width * scale * dpr));
    const bitmapH = Math.max(1, Math.round(height * scale * dpr));
    if (overlay.width !== bitmapW || overlay.height !== bitmapH) {
      overlay.width = bitmapW;
      overlay.height = bitmapH;
    }
    const ctx = overlay.getContext("2d");
    if (!ctx) return;
    ctx.clearRect(0, 0, bitmapW, bitmapH);
    const cell = scale * dpr;
    if (showGridRef.current) {
      ctx.beginPath();
      ctx.strokeStyle = "rgba(243, 239, 230, 0.22)";
      ctx.lineWidth = 1;
      for (let x = 0; x <= width; x++) {
        const p = Math.round(x * cell) + 0.5;
        ctx.moveTo(p, 0);
        ctx.lineTo(p, bitmapH);
      }
      for (let y = 0; y <= height; y++) {
        const p = Math.round(y * cell) + 0.5;
        ctx.moveTo(0, p);
        ctx.lineTo(bitmapW, p);
      }
      ctx.stroke();
    }
    const hover = hoverRef.current;
    if (!hover) return;
    const x0 = Math.round(hover.x * cell);
    const y0 = Math.round(hover.y * cell);
    const x1 = Math.round((hover.x + 1) * cell);
    const y1 = Math.round((hover.y + 1) * cell);
    if (toolRef.current === "eraser") {
      ctx.fillStyle = "rgba(243, 239, 230, 0.2)";
    } else {
      const current = colorRef.current;
      const r = (current >>> 16) & 255;
      const g = (current >>> 8) & 255;
      const b = current & 255;
      ctx.fillStyle = `rgba(${r}, ${g}, ${b}, 0.55)`;
    }
    ctx.fillRect(x0, y0, Math.max(1, x1 - x0), Math.max(1, y1 - y0));
  }

  function setHover(cell: { x: number; y: number } | null) {
    hoverRef.current = cell;
    if (coordRef.current) {
      coordRef.current.textContent = cell ? `${cell.x}, ${cell.y}` : "—";
    }
    drawOverlay();
  }

  function bumpHistory() {
    setHist((value) => value + 1);
    setInk(hasInk(pixelsRef.current));
    setRev((value) => value + 1);
  }

  function pushPast(snapshot: Snapshot) {
    pastRef.current.push(snapshot);
    trim(pastRef.current);
    futureRef.current = [];
  }

  function restore(snapshot: Snapshot) {
    pixelsRef.current = snapshot.data.slice();
    wRef.current = snapshot.w;
    hRef.current = snapshot.h;
    setW(snapshot.w);
    setH(snapshot.h);
    bumpHistory();
  }

  function undo() {
    if (drawingRef.current) return;
    const snapshot = pastRef.current.pop();
    if (!snapshot) return;
    futureRef.current.push({
      w: wRef.current,
      h: hRef.current,
      data: pixelsRef.current.slice(),
    });
    restore(snapshot);
  }

  function redo() {
    if (drawingRef.current) return;
    const snapshot = futureRef.current.pop();
    if (!snapshot) return;
    pastRef.current.push({
      w: wRef.current,
      h: hRef.current,
      data: pixelsRef.current.slice(),
    });
    restore(snapshot);
  }

  function plotSegment(from: { x: number; y: number }, to: { x: number; y: number }) {
    const pixels = pixelsRef.current;
    const width = wRef.current;
    const next = toolRef.current === "eraser" ? 0 : colorRef.current;
    forLine(from.x, from.y, to.x, to.y, (x, y) => {
      const index = y * width + x;
      if (pixels[index] !== next) {
        pixels[index] = next;
        dirtyRef.current = true;
      }
    });
  }

  function finishStroke() {
    if (!drawingRef.current) return;
    drawingRef.current = false;
    pointerRef.current = null;
    if (dirtyRef.current && beforeRef.current) {
      pushPast({ w: wRef.current, h: hRef.current, data: beforeRef.current });
      bumpHistory();
    }
    beforeRef.current = null;
    dirtyRef.current = false;
    lastRef.current = null;
  }

  function resizeTo(nextW: number, nextH: number) {
    const width = clampSize(nextW);
    const height = clampSize(nextH);
    if (width === wRef.current && height === hRef.current) return;
    if (drawingRef.current) finishStroke();
    pushPast({ w: wRef.current, h: hRef.current, data: pixelsRef.current.slice() });
    pixelsRef.current = resample(pixelsRef.current, wRef.current, hRef.current, width, height);
    wRef.current = width;
    hRef.current = height;
    setW(width);
    setH(height);
    bumpHistory();
  }

  function clearCanvas() {
    if (!hasInk(pixelsRef.current)) {
      setConfirmClear(false);
      return;
    }
    pushPast({ w: wRef.current, h: hRef.current, data: pixelsRef.current.slice() });
    pixelsRef.current = new Uint32Array(wRef.current * hRef.current);
    setConfirmClear(false);
    bumpHistory();
  }

  function choosePalette(id: string) {
    const next = paletteById(id);
    setPaletteId(next.id);
    const packed = next.colors.map((hex) => pack(hex));
    if (!packed.includes(colorRef.current)) {
      setColor(packed[0] ?? colorRef.current);
    }
  }

  function download() {
    const width = wRef.current;
    const height = hRef.current;
    const source = document.createElement("canvas");
    blit(source, pixelsRef.current, width, height);
    const factor = Math.max(1, Math.round(512 / Math.max(width, height)));
    const out = document.createElement("canvas");
    out.width = width * factor;
    out.height = height * factor;
    const ctx = out.getContext("2d");
    if (!ctx) return;
    ctx.imageSmoothingEnabled = false;
    ctx.drawImage(source, 0, 0, out.width, out.height);
    const link = document.createElement("a");
    link.href = out.toDataURL("image/png");
    link.download = `墨点-${width}x${height}.png`;
    link.click();
    setExported(true);
    window.setTimeout(() => setExported(false), 1400);
  }

  const apiRef = useRef<Handlers>({
    down() {},
    move() {},
    up() {},
    undo() {},
    redo() {},
  });

  apiRef.current = {
    undo,
    redo,
    down(event) {
      if (event.button !== 0 || confirmRef.current) return;
      const frame = frameRef.current;
      if (!frame) return;
      event.preventDefault();
      try {
        frame.setPointerCapture(event.pointerId);
      } catch {
        /* pointer already inactive */
      }
      const cell = cellFrom(event, frame, wRef.current, hRef.current);
      if (!cell) return;
      pointerRef.current = event.pointerId;
      drawingRef.current = true;
      dirtyRef.current = false;
      beforeRef.current = pixelsRef.current.slice();
      lastRef.current = cell;
      setHover(cell);
      if (toolRef.current === "fill") {
        dirtyRef.current = floodFill(
          pixelsRef.current,
          wRef.current,
          hRef.current,
          cell.x,
          cell.y,
          colorRef.current,
        );
        paint();
        finishStroke();
        return;
      }
      plotSegment(cell, cell);
      paint();
    },
    move(event) {
      const frame = frameRef.current;
      if (!frame) return;
      const cell = cellFrom(event, frame, wRef.current, hRef.current);
      if (!drawingRef.current || event.pointerId !== pointerRef.current) {
        setHover(cell);
        return;
      }
      if (!cell || !lastRef.current) {
        setHover(cell);
        return;
      }
      if (toolRef.current !== "fill") {
        plotSegment(lastRef.current, cell);
        paint();
      }
      lastRef.current = cell;
      setHover(cell);
    },
    up(event) {
      if (pointerRef.current !== null && event.pointerId !== pointerRef.current) return;
      finishStroke();
    },
  };

  useLayoutEffect(() => {
    const stage = stageRef.current;
    if (!stage) return;
    const measure = () => {
      const rect = stage.getBoundingClientRect();
      const availW = Math.max(1, rect.width - 32);
      const availH = Math.max(1, rect.height - 32);
      const scale = Math.max(1, Math.floor(Math.min(availW / wRef.current, availH / hRef.current)));
      const cssW = wRef.current * scale;
      const cssH = hRef.current * scale;
      const left = Math.floor((rect.width - cssW) / 2);
      const top = Math.floor((rect.height - cssH) / 2);
      scaleRef.current = scale;
      setBox((prev) =>
        prev.scale === scale && prev.left === left && prev.top === top ? prev : { scale, left, top },
      );
    };
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(stage);
    return () => observer.disconnect();
  }, [w, h]);

  useEffect(() => {
    paint();
    drawOverlay();
    // Redraw when the document, viewport scale, tool, or grid changes.
    // paint/drawOverlay close over the latest refs from this render.
  }, [rev, w, h, box.scale, showGrid, tool, color]);

  useEffect(() => {
    try {
      const saved = decodeDoc(JSON.parse(localStorage.getItem(STORAGE_KEY) ?? "null"));
      if (saved) {
        pixelsRef.current = saved.pixels;
        wRef.current = saved.w;
        hRef.current = saved.h;
        colorRef.current = saved.color;
        toolRef.current = saved.tool;
        showGridRef.current = saved.showGrid;
        setW(saved.w);
        setH(saved.h);
        setColor(saved.color);
        setTool(saved.tool);
        setPaletteId(saved.paletteId);
        setShowGrid(saved.showGrid);
        setInk(hasInk(saved.pixels));
        setRev((value) => value + 1);
      }
    } catch {
      /* ignore broken storage */
    }
    setReady(true);
  }, []);

  useEffect(() => {
    if (!ready) return;
    const id = window.setTimeout(() => {
      try {
        const payload = {
          v: 1,
          w: wRef.current,
          h: hRef.current,
          pixels: Array.from(pixelsRef.current),
          paletteId,
          color: colorRef.current,
          tool: toolRef.current,
          showGrid: showGridRef.current,
        };
        localStorage.setItem(STORAGE_KEY, JSON.stringify(payload));
      } catch {
        /* quota or private mode */
      }
    }, 200);
    return () => window.clearTimeout(id);
  }, [ready, rev, paletteId, color, tool, showGrid, w, h]);

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      const target = event.target;
      if (target instanceof HTMLElement && (target.tagName === "INPUT" || target.tagName === "TEXTAREA")) return;
      if (confirmRef.current) return;
      const meta = event.metaKey || event.ctrlKey;
      if (meta && event.code === "KeyZ") {
        event.preventDefault();
        if (event.shiftKey) apiRef.current.redo();
        else apiRef.current.undo();
        return;
      }
      if (meta && event.code === "KeyY") {
        event.preventDefault();
        apiRef.current.redo();
        return;
      }
      if (meta || event.repeat) return;
      if (event.code === "KeyB") setTool("brush");
      else if (event.code === "KeyE") setTool("eraser");
      else if (event.code === "KeyF") setTool("fill");
      else if (event.code === "KeyG") setShowGrid((value) => !value);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  useEffect(() => {
    if (!confirmClear) return;
    cancelRef.current?.focus();
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") setConfirmClear(false);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [confirmClear]);

  const toolName = TOOLS.find((item) => item.id === tool)?.label ?? "画笔";

  return (
    <div className="flex h-dvh select-none flex-col overflow-hidden bg-bg text-fg">
      <header className="flex h-14 shrink-0 items-center gap-3 border-b border-border px-3 sm:px-4">
        <div className="flex items-center gap-2">
          <span className="grid size-4 grid-cols-2 gap-px" aria-hidden>
            <span className="bg-fg" />
            <span className="bg-muted" />
            <span className="bg-muted" />
            <span className="bg-fg" />
          </span>
          <h1 className="text-base font-semibold tracking-tight">墨点</h1>
          <span className="text-sm text-muted">{toolName}</span>
        </div>
        <div className="ml-auto flex items-center gap-2">
          <button
            type="button"
            className="pressable h-11 whitespace-nowrap rounded-md bg-fg px-4 text-sm font-medium text-bg"
            onClick={download}
          >
            <span className="inline-flex items-center gap-2">
              <Download className="size-4" strokeWidth={1.75} />
              {exported ? "已导出" : "导出 PNG"}
            </span>
          </button>
        </div>
      </header>

      <div className="flex min-h-0 flex-1">
        <aside className="hidden w-16 shrink-0 flex-col items-center gap-1 border-r border-border py-2 sm:flex">
          <ToolCluster
            tool={tool}
            showGrid={showGrid}
            canUndo={canUndo}
            canRedo={canRedo}
            canClear={ink}
            onTool={setTool}
            onUndo={() => apiRef.current.undo()}
            onRedo={() => apiRef.current.redo()}
            onGrid={() => setShowGrid((value) => !value)}
            onClear={() => setConfirmClear(true)}
            layout="col"
          />
        </aside>

        <div ref={stageRef} className="relative min-h-0 min-w-0 flex-1 bg-stage">
          {!ink && (
            <p className="pointer-events-none absolute inset-x-0 top-4 text-center text-xs text-muted">
              在格子上按住拖动即可绘制
            </p>
          )}
          <div
            ref={frameRef}
            role="application"
            aria-label="画布"
            data-canvas=""
            className="checker absolute cursor-crosshair"
            style={{
              left: box.left,
              top: box.top,
              width: w * box.scale,
              height: h * box.scale,
              backgroundSize: `${box.scale * 2}px ${box.scale * 2}px`,
            }}
            onPointerDown={(event) => apiRef.current.down(event)}
            onPointerMove={(event) => apiRef.current.move(event)}
            onPointerUp={(event) => apiRef.current.up(event)}
            onPointerCancel={(event) => apiRef.current.up(event)}
            onLostPointerCapture={() => {
              if (drawingRef.current) finishStroke();
            }}
            onPointerLeave={() => {
              if (!drawingRef.current) setHover(null);
            }}
            onContextMenu={(event) => event.preventDefault()}
          >
            <canvas ref={pixRef} className="pixels absolute inset-0 size-full" width={w} height={h} />
            <canvas ref={ovRef} className="pointer-events-none absolute inset-0 size-full" />
          </div>
          <span
            ref={coordRef}
            className="pointer-events-none absolute bottom-3 left-3 font-mono text-xs text-muted tabular-nums"
          >
            —
          </span>
        </div>
      </div>

      <footer className="dock shrink-0 border-t border-border bg-surface">
        <div className="flex items-center gap-1 overflow-x-auto px-3 py-2">
          <div role="radiogroup" aria-label="色板" className="flex items-center gap-1">
            {PALETTES.map((item) => {
              const selected = item.id === paletteId;
              return (
                <button
                  key={item.id}
                  type="button"
                  role="radio"
                  aria-checked={selected}
                  className={`pressable h-11 shrink-0 rounded-md px-3 text-sm ${selected ? "bg-fg font-medium text-bg" : "text-muted hover:bg-elevated"}`}
                  onClick={() => choosePalette(item.id)}
                >
                  {item.name}
                </button>
              );
            })}
          </div>
          <span className="ml-auto shrink-0 font-mono text-xs text-subtle tabular-nums">{hexOf(color)}</span>
        </div>
        <div role="radiogroup" aria-label="颜色" className="grid grid-cols-8 gap-1 px-3 pb-3 sm:flex sm:flex-wrap">
          {palette.colors.map((hex) => {
            const packed = pack(hex);
            const selected = packed === color;
            return (
              <button
                key={hex}
                type="button"
                role="radio"
                aria-checked={selected}
                aria-label={hex.toUpperCase()}
                className="swatch pressable aspect-square w-full rounded-sm sm:size-11 sm:w-11"
                style={{ backgroundColor: hex }}
                onClick={() => setColor(packed)}
              />
            );
          })}
        </div>
        <div className="flex items-center gap-2 overflow-x-auto border-t border-border px-3 py-2">
          <span className="shrink-0 text-sm text-muted">尺寸</span>
          <Stepper label="宽度" value={w} onCommit={(next) => resizeTo(next, h)} />
          <span className="shrink-0 font-mono text-xs text-subtle">×</span>
          <Stepper label="高度" value={h} onCommit={(next) => resizeTo(w, next)} />
          <div className="flex shrink-0 items-center gap-1">
            {PRESETS.map((size) => {
              const selected = w === size && h === size;
              return (
                <button
                  key={size}
                  type="button"
                  aria-pressed={selected}
                  className={`pressable h-11 shrink-0 rounded-md px-3 font-mono text-sm tabular-nums ${selected ? "bg-fg font-medium text-bg" : "text-muted hover:bg-elevated"}`}
                  onClick={() => resizeTo(size, size)}
                >
                  {size}
                </button>
              );
            })}
          </div>
          <p className="ml-auto hidden shrink-0 font-mono text-xs text-subtle lg:block">
            B 画笔 · E 橡皮 · F 填充 · G 网格 · Ctrl Z 撤销
          </p>
        </div>
        <div className="flex items-center gap-1 overflow-x-auto border-t border-border px-2 py-2 sm:hidden">
          <ToolCluster
            tool={tool}
            showGrid={showGrid}
            canUndo={canUndo}
            canRedo={canRedo}
            canClear={ink}
            onTool={setTool}
            onUndo={() => apiRef.current.undo()}
            onRedo={() => apiRef.current.redo()}
            onGrid={() => setShowGrid((value) => !value)}
            onClear={() => setConfirmClear(true)}
            layout="row"
          />
        </div>
      </footer>

      {confirmClear && (
        <div
          className="fixed inset-0 z-30 grid place-items-center bg-bg/80 p-4"
          onPointerDown={(event) => {
            if (event.target === event.currentTarget) setConfirmClear(false);
          }}
        >
          <div
            role="dialog"
            aria-modal="true"
            aria-labelledby="clear-title"
            className="dialog-card w-full max-w-sm rounded-xl border border-border bg-surface p-4"
          >
            <h2 id="clear-title" className="text-base font-medium">
              清空画布？
            </h2>
            <p className="mt-2 text-sm text-muted">格子上的像素会被擦掉。这一步可以撤销。</p>
            <div className="mt-6 flex justify-end gap-2">
              <button
                ref={cancelRef}
                type="button"
                className="pressable h-11 rounded-md px-4 text-sm text-muted hover:bg-elevated"
                onClick={() => setConfirmClear(false)}
              >
                取消
              </button>
              <button
                type="button"
                className="pressable h-11 rounded-md bg-fg px-4 text-sm font-medium text-bg"
                onClick={clearCanvas}
              >
                清空
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

function ToolCluster({
  tool,
  showGrid,
  canUndo,
  canRedo,
  canClear,
  onTool,
  onUndo,
  onRedo,
  onGrid,
  onClear,
  layout,
}: {
  tool: Tool;
  showGrid: boolean;
  canUndo: boolean;
  canRedo: boolean;
  canClear: boolean;
  onTool: (tool: Tool) => void;
  onUndo: () => void;
  onRedo: () => void;
  onGrid: () => void;
  onClear: () => void;
  layout: "row" | "col";
}) {
  const vertical = layout === "col";
  return (
    <div
      role="toolbar"
      aria-label="工具"
      className={vertical ? "flex flex-col items-center gap-1" : "flex items-center gap-1"}
    >
      {TOOLS.map((item) => (
        <IconButton
          key={item.id}
          label={`${item.label} (${item.shortcut})`}
          pressed={tool === item.id}
          onClick={() => onTool(item.id)}
        >
          <item.icon className="size-5" strokeWidth={1.75} />
        </IconButton>
      ))}
      <Sep vertical={!vertical} />
      <IconButton label="撤销 (Ctrl Z)" disabled={!canUndo} onClick={onUndo}>
        <Undo2 className="size-5" strokeWidth={1.75} />
      </IconButton>
      <IconButton label="重做 (Ctrl Shift Z)" disabled={!canRedo} onClick={onRedo}>
        <Redo2 className="size-5" strokeWidth={1.75} />
      </IconButton>
      <Sep vertical={!vertical} />
      <IconButton label="网格 (G)" pressed={showGrid} onClick={onGrid}>
        <Grid3x3 className="size-5" strokeWidth={1.75} />
      </IconButton>
      <IconButton label="清空画布" disabled={!canClear} onClick={onClear}>
        <Trash2 className="size-5" strokeWidth={1.75} />
      </IconButton>
    </div>
  );
}

function Sep({ vertical }: { vertical: boolean }) {
  return <span aria-hidden className={vertical ? "mx-1 h-6 w-px shrink-0 bg-border" : "my-1 h-px w-6 shrink-0 bg-border"} />;
}

function IconButton({
  label,
  pressed,
  disabled,
  onClick,
  children,
}: {
  label: string;
  pressed?: boolean;
  disabled?: boolean;
  onClick: () => void;
  children: ReactNode;
}) {
  return (
    <button
      type="button"
      aria-label={label}
      aria-pressed={pressed}
      title={label}
      disabled={disabled}
      onClick={onClick}
      className={`pressable grid size-11 shrink-0 place-items-center rounded-md ${
        pressed ? "bg-fg text-bg" : "text-fg hover:bg-elevated"
      } disabled:opacity-30`}
    >
      {children}
    </button>
  );
}

function Stepper({
  label,
  value,
  onCommit,
}: {
  label: string;
  value: number;
  onCommit: (value: number) => void;
}) {
  const [draft, setDraft] = useState(String(value));
  const focused = useRef(false);

  useEffect(() => {
    if (!focused.current) setDraft(String(value));
  }, [value]);

  return (
    <div className="flex shrink-0 items-center">
      <button
        type="button"
        aria-label={`减小${label}`}
        className="pressable grid size-11 place-items-center rounded-md text-fg hover:bg-elevated"
        onClick={() => onCommit(value - 1)}
      >
        <Minus className="size-4" strokeWidth={1.75} />
      </button>
      <input
        aria-label={label}
        inputMode="numeric"
        autoComplete="off"
        value={draft}
        onFocus={() => {
          focused.current = true;
        }}
        onChange={(event) => setDraft(event.target.value.replace(/[^\d]/g, "").slice(0, 3))}
        onBlur={() => {
          focused.current = false;
          const next = Number.parseInt(draft, 10);
          if (Number.isFinite(next)) onCommit(next);
          else setDraft(String(value));
        }}
        onKeyDown={(event) => {
          if (event.key === "Enter") event.currentTarget.blur();
        }}
        className="h-11 w-12 rounded-md border border-border bg-bg text-center font-mono text-sm text-fg tabular-nums"
      />
      <button
        type="button"
        aria-label={`增大${label}`}
        className="pressable grid size-11 place-items-center rounded-md text-fg hover:bg-elevated"
        onClick={() => onCommit(value + 1)}
      >
        <Plus className="size-4" strokeWidth={1.75} />
      </button>
    </div>
  );
}
