import type { FormatOptions } from "../../core/config/options";
import type { Diagnostic } from "../../core/diagnostics/diagnostic";
import type { DebugEvent } from "../../core/diagnostics/debug-event";
import type { FormatResult } from "../../core/api/format-result";
import type { SourceMap } from "../../core/source/source-map";
import type { RenderNewline } from "../../core/renderer/environment";
import type { ParseMode } from "../../core/syntax/parser-backend";

export interface CancellationToken {
    readonly isCancellationRequested: boolean;
    onCancellationRequested(listener: () => void): () => void;
}

export interface FormatTarget {
    readonly id: string;
    readonly start: number;
    readonly end: number;
    readonly mode: Extract<ParseMode, "document" | "fragment">;
}

export interface FormatSelection {
    readonly id: string;
    readonly targetId: string | null;
    readonly anchor: number;
    readonly active: number;
}

export interface FormatExecutionRequest {
    readonly source: string;
    readonly options?: FormatOptions;
    readonly mode: FormatTarget["mode"];
    readonly documentVersion: number;
    readonly targetId: string;
    readonly newline?: RenderNewline;
    readonly cancellation?: CancellationToken;
    readonly debugEnabled?: boolean;
}

export interface FormatExecutionOutcome {
    readonly result: FormatResult;
    readonly debugEvents: readonly DebugEvent[];
}

export interface ValidateAndFormatExecutionRequest {
    readonly source: string;
    readonly options?: FormatOptions;
    readonly targets: readonly FormatTarget[];
    readonly documentVersion: number;
    readonly newline?: RenderNewline;
    readonly cancellation?: CancellationToken;
    readonly debugEnabled?: boolean;
}

export interface FormatBatchTargetResult {
    readonly targetId: string;
    readonly result: FormatResult;
}

export interface CompletedFormatBatchExecution {
    readonly status: "completed";
    readonly results: readonly FormatBatchTargetResult[];
    readonly debugEvents?: readonly DebugEvent[];
}

export interface InvalidFormatBatchExecution {
    readonly status: "invalid";
    readonly code: string;
    readonly targetId: string | null;
    readonly debugEvents?: readonly DebugEvent[];
}

export interface FailedFormatBatchExecution {
    readonly status: "failed";
    readonly code: string;
    readonly debugEvents?: readonly DebugEvent[];
}

export type FormatBatchExecutionResult =
    | CompletedFormatBatchExecution
    | InvalidFormatBatchExecution
    | FailedFormatBatchExecution;

export interface FormatterExecutor {
    format(request: FormatExecutionRequest): Promise<FormatResult>;
    execute?(request: FormatExecutionRequest): Promise<FormatExecutionOutcome>;
    validateAndFormat?(
        request: ValidateAndFormatExecutionRequest
    ): Promise<FormatBatchExecutionResult>;
    dispose(): Promise<void>;
}

export interface FormatTransactionRequest {
    readonly source: string;
    readonly documentVersion: number;
    readonly targets: readonly FormatTarget[];
    readonly selections?: readonly FormatSelection[];
    readonly options?: FormatOptions;
    readonly newline?: RenderNewline;
    readonly cancellation?: CancellationToken;
    readonly debugEnabled?: boolean;
}

export interface TransactionDiagnostic extends Diagnostic {
    readonly targetId: string | null;
}

export interface TransactionEdit {
    readonly targetId: string;
    readonly start: number;
    readonly end: number;
    readonly text: string;
    readonly sourceMap: SourceMap;
}

export interface TransactionSelection {
    readonly selectionId: string;
    readonly selectionAnchor: number;
    readonly selectionActive: number;
}

interface FormatTransactionResultBase<S extends string> {
    readonly status: S;
    readonly documentVersion: number;
    readonly debugEvents?: readonly DebugEvent[];
}

export interface ReadyFormatTransaction
    extends FormatTransactionResultBase<"ready"> {
    readonly edits: readonly TransactionEdit[];
    readonly selections: readonly TransactionSelection[];
    readonly diagnostics: readonly TransactionDiagnostic[];
}

export interface UnchangedFormatTransaction
    extends FormatTransactionResultBase<"unchanged"> {
    readonly edits: readonly [];
    readonly selections: readonly TransactionSelection[];
    readonly diagnostics: readonly TransactionDiagnostic[];
}

export interface RejectedFormatTransaction
    extends FormatTransactionResultBase<"rejected"> {
    readonly diagnostics: readonly TransactionDiagnostic[];
}

export interface CancelledFormatTransaction
    extends FormatTransactionResultBase<"cancelled"> {
    readonly diagnostics: readonly [];
}

export type FormatTransactionResult =
    | ReadyFormatTransaction
    | UnchangedFormatTransaction
    | RejectedFormatTransaction
    | CancelledFormatTransaction;
