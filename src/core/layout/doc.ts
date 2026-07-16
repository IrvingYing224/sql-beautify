import type { LeafRange } from "../syntax/leaf-range";

declare const POSITIVE_COLUMNS: unique symbol;
declare const POSITIVE_LEVELS: unique symbol;

/** Branded values can only be produced by the canonical LayoutDoc factory. */
export type PositiveColumns = number & {
    readonly [POSITIVE_COLUMNS]: true;
};

/** Branded values can only be produced by the canonical LayoutDoc factory. */
export type PositiveLevels = number & {
    readonly [POSITIVE_LEVELS]: true;
};

export type LeafTransform = "raw" | "keyword-case";

export type VerbatimTrigger =
    | {
          readonly kind: "opaque";
          readonly capabilityId: string | null;
      }
    | {
          readonly kind: "node-capability";
          readonly capabilityId: string;
      }
    | {
          readonly kind: "operator-capability";
          readonly capabilityId: string;
          readonly operatorId: string;
      };

export type LineSuffixSpacing =
    | {
          readonly kind: "space";
          readonly columns: PositiveColumns;
      }
    | {
          readonly kind: "pad-to-column";
          readonly targetColumn: PositiveColumns;
      }
    | null;

export interface LeafDoc {
    readonly kind: "leaf";
    readonly leafId: number;
    readonly transform: LeafTransform;
}

export interface VerbatimDoc {
    readonly kind: "verbatim";
    readonly ownerNodeId: number;
    readonly trigger: VerbatimTrigger;
    readonly leafRange: LeafRange;
}

export interface SpaceDoc {
    readonly kind: "space";
    readonly columns: PositiveColumns;
}

export interface HardLineDoc {
    readonly kind: "line";
    readonly mode: "hard";
}

export interface SoftLineDoc {
    readonly kind: "line";
    readonly mode: "soft";
    readonly flat: "empty" | "space";
}

export interface ConcatDoc {
    readonly kind: "concat";
    readonly parts: readonly LayoutDoc[];
}

export interface IndentDoc {
    readonly kind: "indent";
    readonly levels: PositiveLevels;
    readonly content: LayoutDoc;
}

export interface AlignDoc {
    readonly kind: "align";
    readonly columns: PositiveColumns;
    readonly content: LayoutDoc;
}

export interface PadToColumnDoc {
    readonly kind: "pad-to-column";
    readonly targetColumn: PositiveColumns;
}

export interface AutoGroupDoc {
    readonly kind: "group";
    readonly mode: "auto";
    readonly maxFlatWidth: PositiveColumns;
    readonly content: LayoutDoc;
}

export interface ForcedGroupDoc {
    readonly kind: "group";
    readonly mode: "flat" | "break";
    readonly content: LayoutDoc;
}

export interface LineSuffixDoc {
    readonly kind: "line-suffix";
    readonly commentLeafId: number;
    readonly spacing: LineSuffixSpacing;
}

export type LayoutDoc =
    | LeafDoc
    | VerbatimDoc
    | SpaceDoc
    | HardLineDoc
    | SoftLineDoc
    | ConcatDoc
    | IndentDoc
    | AlignDoc
    | PadToColumnDoc
    | AutoGroupDoc
    | ForcedGroupDoc
    | LineSuffixDoc;
