export interface CanvasViewState {
  scale: number;
  tx: number;
  ty: number;
}

const PREFIX = "wn-canvas-view:";

export function loadCanvasView(key: string): CanvasViewState | null {
  if (typeof window === "undefined") return null;
  try {
    const raw = sessionStorage.getItem(PREFIX + key);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as CanvasViewState;
    if (
      typeof parsed.scale === "number" &&
      typeof parsed.tx === "number" &&
      typeof parsed.ty === "number" &&
      Number.isFinite(parsed.scale) &&
      Number.isFinite(parsed.tx) &&
      Number.isFinite(parsed.ty)
    ) {
      return parsed;
    }
  } catch {
    /* ignore */
  }
  return null;
}

export function saveCanvasView(key: string, view: CanvasViewState) {
  if (typeof window === "undefined") return;
  try {
    sessionStorage.setItem(PREFIX + key, JSON.stringify(view));
  } catch {
    /* ignore */
  }
}
