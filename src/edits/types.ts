import type { CanonicalFormatOptions } from "../core/config/options";
import type { DebugEvent } from "../core/diagnostics/debug-event";
import type { Diagnostic } from "../core/diagnostics/diagnostic";
import type { RenderNewline, RenderTabSize } from "../core/renderer/environment";
import type { ExtractDdlOptions, HiveDdlFormatOptions } from "../ddl/types";

/** A range of the document to rewrite. `document` mode is only the whole document. */
export interface EditTarget {
    readonly id: string;
    readonly start: number;
    readonly end: number;
    readonly mode: "document" | "fragment";
}

/** A selection to carry through the edits; `targetId` names the target that contains it. */
export interface EditSelection {
    readonly targetId: string | null;
    readonly anchor: number;
    readonly active: number;
}

interface ComputeRequestBase {
    readonly source: string;
    readonly targets: readonly EditTarget[];
    readonly selections: readonly EditSelection[];
    readonly newline: RenderNewline;
    readonly tabSize: RenderTabSize;
}

export type ComputeRequest =
    | (ComputeRequestBase & { readonly op: "format"; readonly options: CanonicalFormatOptions })
    | (ComputeRequestBase & { readonly op: "hive-ddl"; readonly options: HiveDdlFormatOptions | undefined })
    | (ComputeRequestBase & { readonly op: "extract"; readonly options: ExtractDdlOptions | undefined });

export interface Edit {
    readonly targetId: string;
    readonly start: number;
    readonly end: number;
    readonly text: string;
}

/** A core diagnostic with a document span and the target it came from (null for the document). */
export interface EditDiagnostic extends Diagnostic {
    readonly targetId: string | null;
}

/**
 * `ready` carries the edits, the selections after them and the diagnostics in output coordinates;
 * the other statuses carry no edits and source coordinates. `cancelled` comes only from the executor.
 */
export interface ComputeResult {
    readonly status: "ready" | "unchanged" | "rejected" | "cancelled";
    readonly edits: readonly Edit[];
    readonly selections: readonly { readonly anchor: number; readonly active: number }[];
    readonly diagnostics: readonly EditDiagnostic[];
    readonly debugEvents: readonly DebugEvent[];
}
