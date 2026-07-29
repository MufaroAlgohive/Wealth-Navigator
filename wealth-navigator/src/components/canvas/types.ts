import type { CanvasNodeType } from "@/lib/chatsight/types";

export interface CanvasNode {
  id: string;
  type: CanvasNodeType;
  title: string;
  x: number;
  y: number;
  /** Optional override width (px). Falls back to default for type. */
  w?: number;
  /** Optional override height (px). Falls back to default for type. */
  h?: number;
  /**
   * Plain-text representation to feed Chatsight.
   * For `"notes"` nodes this is the editable text itself.
   */
  contentText: string;
  /**
   * Optional structured data for rendering (e.g. notes text).
   */
  data: {
    text?: string;
  };
}

export interface CanvasEdge {
  id: string;
  from: string;
  to: string;
}

export interface CanvasBoardSettings {
  snapToGrid: boolean;
  showWires: boolean;
  gridDensity: number;
  defaultNodeW: number;
  defaultNodeH: number;
}

export const DEFAULT_BOARD_SETTINGS: CanvasBoardSettings = {
  snapToGrid: true,
  showWires: true,
  gridDensity: 28,
  defaultNodeW: 420,
  defaultNodeH: 360,
};

/** Spacious card footprint — room to breathe between nodes on a ~70vh board. */
export const NODE_SIZE = { w: 420, h: 360 };
export const ENGINE_NODE_SIZE = { w: 240, h: 88 };
export const COMPACT_NODE_SIZE = { w: 320, h: 280 };
export const PORT_OFFSET_Y = 44; // align with header / mid-chrome, not card center
export const BOARD_PAD = 48;

export const MIN_ZOOM = 0.35;
export const MAX_ZOOM = 2.25;
export const ZOOM_STEP = 0.1;

export function nodeDims(
  node: CanvasNode,
  settings: Pick<CanvasBoardSettings, "defaultNodeW" | "defaultNodeH"> = DEFAULT_BOARD_SETTINGS,
): { w: number; h: number } {
  if (node.type === "engine") {
    return { w: node.w ?? ENGINE_NODE_SIZE.w, h: node.h ?? ENGINE_NODE_SIZE.h };
  }
  if (node.type === "technicals" || node.type === "news") {
    return {
      w: node.w ?? COMPACT_NODE_SIZE.w,
      h: node.h ?? COMPACT_NODE_SIZE.h,
    };
  }
  return {
    w: node.w ?? settings.defaultNodeW,
    h: node.h ?? settings.defaultNodeH,
  };
}
