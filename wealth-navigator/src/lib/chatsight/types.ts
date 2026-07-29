export type CanvasNodeType =
  | "chart"
  | "fundamentals"
  | "thesis"
  | "notes"
  | "technicals"
  | "news"
  | "engine";

export interface CanvasNodeSummary {
  id: string;
  type: CanvasNodeType;
  title: string;
  /**
   * Plain-text representation of the node’s current content/evidence.
   * Sent to the model so it can ground answers/build proposals.
   */
  contentText: string;
}

export interface CanvasEdgeSummary {
  from: string;
  to: string;
}

export interface CanvasContextPayload {
  symbol: string;
  nodes: CanvasNodeSummary[];
  edges: CanvasEdgeSummary[];
  /**
   * Convenience field: concatenated notes/prompt content from nodes of type
   * `"notes"` (and potentially other future node types).
   */
  notesText: string;
}

export interface ChatsightAskRequest {
  symbol: string;
  question: string;
  context: CanvasContextPayload;
}

export interface ChatsightAskResponse {
  ok: boolean;
  configured: boolean;
  provider?: string | null;
  model?: string | null;
  answer?: string;
  error?: string;
}

export type CanvasBuildOperation =
  | {
      type: "add_edge";
      from: string;
      to: string;
    }
  | {
      type: "remove_edge";
      from: string;
      to: string;
    }
  | {
      type: "update_node";
      id: string;
      patch: {
        title?: string;
        contentText?: string;
      };
    }
  | {
      type: "add_node";
      node: {
        id: string;
        type: CanvasNodeType;
        title: string;
        contentText: string;
        /**
         * Optional placement hint. The UI can still fall back to a default
         * placement if omitted/invalid.
         */
        position?: { x: number; y: number };
      };
    };

export interface CanvasBuildProposal {
  summary: string;
  operations: CanvasBuildOperation[];
}

export interface ChatsightBuildRequest {
  symbol: string;
  instruction: string;
  context: CanvasContextPayload;
}

export interface ChatsightBuildResponse {
  ok: boolean;
  configured: boolean;
  provider?: string | string | null;
  model?: string | null;
  proposal?: CanvasBuildProposal;
  error?: string;
}

