import type { Diagnostic } from "../../core/diagnostics/diagnostic";
import { lexSql } from "../../core/lexer/lossless-lexer";
import type {
    ExtractDdlResult,
    HiveDdlResult,
} from "../../experimental/ddl/types";
import { snapshotDataProperties, snapshotDenseDataArray } from "../boundary/data-snapshot";
import { convertDiagnostic, sortDiagnostics } from "../diagnostics/convert";
import {
    buildTextLineIndex,
    lineBoundsAtOffset,
    type TextLineIndex,
} from "../text/line-index";
import { observeCancellation } from "./cancellation";
import {
    sameDocument,
    snapshotDocument,
    type DocumentSnapshot,
} from "./document-snapshot";
import type {
    CancellationToken,
    TransactionDiagnostic,
} from "./types";

export type ExperimentalDdlResult = HiveDdlResult | ExtractDdlResult;

export interface ExperimentalDdlTarget {
    readonly id: string;
    readonly start: number;
    readonly end: number;
}

export interface ExperimentalDdlTransactionRequest {
    readonly document: DocumentSnapshot;
    readonly targets: readonly ExperimentalDdlTarget[];
    readonly cancellation?: CancellationToken;
}

export interface ExperimentalDdlEdit {
    readonly targetId: string;
    readonly start: number;
    readonly end: number;
    readonly text: string;
}

interface ExperimentalDdlTransactionBase<S extends string> {
    readonly status: S;
    readonly documentVersion: number;
    readonly diagnostics: readonly TransactionDiagnostic[];
}

export interface ReadyExperimentalDdlTransaction
    extends ExperimentalDdlTransactionBase<"ready"> {
    readonly edits: readonly ExperimentalDdlEdit[];
}

export interface UnchangedExperimentalDdlTransaction
    extends ExperimentalDdlTransactionBase<"unchanged"> {
    readonly edits: readonly [];
}

export interface RejectedExperimentalDdlTransaction
    extends ExperimentalDdlTransactionBase<"rejected"> {
    readonly edits?: never;
}

export interface CancelledExperimentalDdlTransaction
    extends ExperimentalDdlTransactionBase<"cancelled"> {
    readonly diagnostics: readonly [];
    readonly edits?: never;
}

export type ExperimentalDdlTransactionResult =
    | ReadyExperimentalDdlTransaction
    | UnchangedExperimentalDdlTransaction
    | RejectedExperimentalDdlTransaction
    | CancelledExperimentalDdlTransaction;

export type ExperimentalDdlOperation = (
    source: string
) => ExperimentalDdlResult | Promise<ExperimentalDdlResult>;

export interface ExperimentalDdlCommit {
    readonly currentDocument: () => DocumentSnapshot | null;
    readonly apply: (
        result: ReadyExperimentalDdlTransaction,
        expected: DocumentSnapshot
    ) => Promise<boolean>;
}

interface SnapshottedDdlResult {
    readonly target: ExperimentalDdlTarget;
    readonly result: {
        readonly status: string;
        readonly source: string;
        readonly text: string;
        readonly diagnostics: readonly TransactionDiagnostic[];
    };
}

const TARGET_KEYS: ReadonlySet<string> = new Set(["id", "start", "end"]);
const RESULT_KEYS: ReadonlySet<string> = new Set([
    "status",
    "source",
    "text",
    "diagnostics",
]);
const RESULT_STATUSES: ReadonlySet<string> = new Set([
    "formatted",
    "unchanged",
    "preserved",
    "failed",
    "extracted",
    "unsupported",
    "ambiguous",
    "empty",
]);

function compareString(left: string, right: string): number {
    return left < right ? -1 : left > right ? 1 : 0;
}

function diagnostic(
    target: ExperimentalDdlTarget,
    code: string,
    message: string,
    severity: "warning" | "error" = "error"
): TransactionDiagnostic {
    return Object.freeze({
        code,
        severity,
        message,
        capabilityId: null,
        span: Object.freeze({ start: target.start, end: target.end }),
        recovery: "preserve-target" as const,
        targetId: target.id,
    });
}

function rejected(
    version: number,
    diagnostics: readonly TransactionDiagnostic[]
): RejectedExperimentalDdlTransaction {
    return Object.freeze({
        status: "rejected",
        documentVersion: version,
        diagnostics: sortDiagnostics(diagnostics),
    });
}

function cancelled(version: number): CancelledExperimentalDdlTransaction {
    return Object.freeze({
        status: "cancelled",
        documentVersion: version,
        diagnostics: Object.freeze([]) as readonly [],
    });
}

function snapshotTarget(
    value: ExperimentalDdlTarget,
    sourceLength: number
): ExperimentalDdlTarget | null {
    const snapshot = snapshotDataProperties(value, TARGET_KEYS, ["id", "start", "end"]);
    const start = snapshot?.start;
    const end = snapshot?.end;
    if (
        snapshot === null ||
        typeof snapshot.id !== "string" ||
        snapshot.id.length === 0 ||
        typeof start !== "number" ||
        typeof end !== "number" ||
        !Number.isSafeInteger(start) ||
        !Number.isSafeInteger(end) ||
        start < 0 ||
        end < start ||
        end > sourceLength
    ) {
        return null;
    }
    return Object.freeze({
        id: snapshot.id as string,
        start,
        end,
    });
}

function sortedTargets(
    source: string,
    values: readonly ExperimentalDdlTarget[]
): readonly ExperimentalDdlTarget[] | null {
    const rawTargets = snapshotDenseDataArray(values);
    if (rawTargets === null || rawTargets.length === 0) {
        return null;
    }
    const ids = new Set<string>();
    const targets: ExperimentalDdlTarget[] = [];
    for (const rawTarget of rawTargets) {
        const target = snapshotTarget(rawTarget as ExperimentalDdlTarget, source.length);
        if (target === null || ids.has(target.id)) {
            return null;
        }
        ids.add(target.id);
        targets.push(target);
    }
    targets.sort((left, right) =>
        left.start - right.start ||
        left.end - right.end ||
        compareString(left.id, right.id)
    );
    for (let index = 1; index < targets.length; index++) {
        if (targets[index - 1]!.end > targets[index]!.start) {
            return null;
        }
    }
    return Object.freeze(targets);
}

function isHorizontalWhitespaceRange(
    source: string,
    start: number,
    end: number
): boolean {
    for (let index = start; index < end; index++) {
        const code = source.charCodeAt(index);
        if (code !== 0x20 && code !== 0x09) {
            return false;
        }
    }
    return true;
}

type DdlTargetValidation =
    | { readonly status: "valid" }
    | { readonly status: "cancelled" }
    | { readonly status: "invalid"; readonly target: ExperimentalDdlTarget };

const VALID_DDL_TARGETS: DdlTargetValidation = Object.freeze({ status: "valid" });
const CANCELLED_DDL_TARGETS: DdlTargetValidation = Object.freeze({ status: "cancelled" });

function invalidDdlLineRange(
    source: string,
    target: ExperimentalDdlTarget,
    lineIndex: TextLineIndex
): boolean {
    if (target.start === target.end) {
        return true;
    }
    const startLine = lineBoundsAtOffset(lineIndex, target.start);
    const endLine = lineBoundsAtOffset(lineIndex, target.end);
    return startLine === null ||
        endLine === null ||
        !isHorizontalWhitespaceRange(source, startLine.start, target.start) ||
        !isHorizontalWhitespaceRange(source, target.end, endLine.end);
}

function validateDdlTargets(
    source: string,
    targets: readonly ExperimentalDdlTarget[],
    isCancelled: () => boolean
): DdlTargetValidation {
    try {
        if (isCancelled()) {
            return CANCELLED_DDL_TARGETS;
        }
        const lexical = lexSql(source, { dialect: "hive" });
        if (isCancelled()) {
            return CANCELLED_DDL_TARGETS;
        }
        const lineIndex = buildTextLineIndex(source);
        if (isCancelled()) {
            return CANCELLED_DDL_TARGETS;
        }
        let diagnosticIndex = 0;
        let leafIndex = 0;
        let visitedLeaves = 0;
        for (const target of targets) {
            if (isCancelled()) {
                return CANCELLED_DDL_TARGETS;
            }
            if (invalidDdlLineRange(source, target, lineIndex)) {
                return Object.freeze({ status: "invalid", target });
            }

            while (
                diagnosticIndex < lexical.diagnostics.length &&
                lexical.diagnostics[diagnosticIndex]!.span.end <= target.start
            ) {
                diagnosticIndex += 1;
                visitedLeaves += 1;
                if ((visitedLeaves & 2047) === 0 && isCancelled()) {
                    return CANCELLED_DDL_TARGETS;
                }
            }
            const overlappingDiagnostic = lexical.diagnostics[diagnosticIndex];
            if (
                overlappingDiagnostic !== undefined &&
                overlappingDiagnostic.span.start < target.end &&
                target.start < overlappingDiagnostic.span.end
            ) {
                return Object.freeze({ status: "invalid", target });
            }

            while (
                leafIndex < lexical.leaves.length &&
                lexical.leaves[leafIndex]!.span.end <= target.start
            ) {
                leafIndex += 1;
                visitedLeaves += 1;
                if ((visitedLeaves & 2047) === 0 && isCancelled()) {
                    return CANCELLED_DDL_TARGETS;
                }
            }
            let scanIndex = leafIndex;
            let containsCode = false;
            while (
                scanIndex < lexical.leaves.length &&
                lexical.leaves[scanIndex]!.span.start < target.end
            ) {
                const leaf = lexical.leaves[scanIndex]!;
                const protectedBoundary = leaf.channel === "protected" ||
                    leaf.kind === "line-comment" ||
                    leaf.kind === "block-comment";
                if (protectedBoundary && (
                    (leaf.span.start < target.start && target.start < leaf.span.end) ||
                    (leaf.span.start < target.end && target.end < leaf.span.end)
                )) {
                    return Object.freeze({ status: "invalid", target });
                }
                if (
                    leaf.channel === "code" &&
                    leaf.span.end > target.start
                ) {
                    containsCode = true;
                }
                scanIndex += 1;
                visitedLeaves += 1;
                if ((visitedLeaves & 2047) === 0 && isCancelled()) {
                    return CANCELLED_DDL_TARGETS;
                }
            }
            while (
                leafIndex < scanIndex &&
                lexical.leaves[leafIndex]!.span.end <= target.end
            ) {
                leafIndex += 1;
            }
            if (!containsCode) {
                return Object.freeze({ status: "invalid", target });
            }
        }
        return isCancelled() ? CANCELLED_DDL_TARGETS : VALID_DDL_TARGETS;
    } catch {
        return Object.freeze({ status: "invalid", target: targets[0]! });
    }
}

function snapshotResult(
    value: ExperimentalDdlResult,
    target: ExperimentalDdlTarget
): { readonly status: string; readonly source: string; readonly text: string; readonly diagnostics: readonly TransactionDiagnostic[] } | null {
    const raw = snapshotDataProperties(value, RESULT_KEYS, [
        "status",
        "source",
        "text",
        "diagnostics",
    ]);
    if (
        raw === null ||
        typeof raw.status !== "string" ||
        !RESULT_STATUSES.has(raw.status) ||
        typeof raw.source !== "string" ||
        typeof raw.text !== "string"
    ) {
        return null;
    }
    const diagnostics = snapshotDenseDataArray(raw.diagnostics);
    if (diagnostics === null) {
        return null;
    }
    const converted: TransactionDiagnostic[] = [];
    for (const value of diagnostics) {
        const convertedDiagnostic = convertDiagnostic(
            value as Diagnostic,
            target.id,
            target.start,
            target.end - target.start
        );
        if (convertedDiagnostic === null) {
            return null;
        }
        converted.push(convertedDiagnostic);
    }
    return Object.freeze({
        status: raw.status,
        source: raw.source,
        text: raw.text,
        diagnostics: sortDiagnostics(converted),
    });
}

function prepareExperimentalDdlTransactionInternal(
    expected: DocumentSnapshot,
    snapshots: readonly SnapshottedDdlResult[]
): ExperimentalDdlTransactionResult {
    const diagnostics: TransactionDiagnostic[] = [];
    for (const value of snapshots) {
        if (value.result.diagnostics.length === 0) {
            continue;
        }
        diagnostics.push(...value.result.diagnostics);
        diagnostics.push(diagnostic(
            value.target,
            "ADAPTER_DDL_RESULT",
            "Experimental DDL result must be diagnostic-free"
        ));
    }
    if (diagnostics.length !== 0) {
        return rejected(expected.version, diagnostics);
    }

    const edits: ExperimentalDdlEdit[] = [];
    for (const value of snapshots) {
        const { target, result } = value;
        if (result.status === "formatted" || result.status === "extracted") {
            if (result.text.length === 0) {
                return rejected(expected.version, [
                    diagnostic(
                        target,
                        "ADAPTER_DDL_RESULT",
                        "Editable experimental DDL result must be non-empty"
                    ),
                ]);
            }
            if (result.text !== result.source) {
                edits.push(Object.freeze({
                    targetId: target.id,
                    start: target.start,
                    end: target.end,
                    text: result.text,
                }));
            }
            continue;
        }
        if (result.status === "unchanged" && result.text === result.source) {
            continue;
        }
        if (result.text !== result.source) {
            return rejected(expected.version, [
                diagnostic(
                    target,
                    "ADAPTER_DDL_RESULT",
                    "Non-editable experimental DDL result must retain source"
                ),
            ]);
        }
        return rejected(expected.version, [
            diagnostic(
                target,
                "ADAPTER_DDL_NOT_EDITABLE",
                "Experimental DDL result is not editable in this transaction",
                result.status === "failed" ? "error" : "warning"
            ),
        ]);
    }
    if (edits.length === 0) {
        return Object.freeze({
            status: "unchanged",
            documentVersion: expected.version,
            edits: Object.freeze([]) as readonly [],
            diagnostics: Object.freeze([]),
        });
    }
    return Object.freeze({
        status: "ready",
        documentVersion: expected.version,
        edits: Object.freeze(edits),
        diagnostics: Object.freeze([]),
    });
}

async function runExperimentalDdlTransactionInternal(
    request: ExperimentalDdlTransactionRequest,
    operation: ExperimentalDdlOperation,
    commit: ExperimentalDdlCommit
): Promise<ExperimentalDdlTransactionResult> {
    const expected = snapshotDocument(request.document);
    if (expected === null) {
        return rejected(0, [
            diagnostic(
                { id: "document", start: 0, end: 0 },
                "ADAPTER_DOCUMENT_SNAPSHOT",
                "Document snapshot is invalid"
            ),
        ]);
    }
    const cancellation = observeCancellation(request.cancellation);
    try {
        if (cancellation.isCancelled()) {
            return cancelled(expected.version);
        }
        const targets = sortedTargets(expected.source, request.targets);
        if (targets === null) {
            return rejected(expected.version, [
                diagnostic(
                    { id: "document", start: 0, end: expected.source.length },
                    "ADAPTER_DDL_TARGET",
                    "Experimental DDL targets are invalid or overlapping"
                ),
            ]);
        }
        if (cancellation.isCancelled()) {
            return cancelled(expected.version);
        }
        const targetValidation = validateDdlTargets(
            expected.source,
            targets,
            () => cancellation.isCancelled()
        );
        if (targetValidation.status === "cancelled") {
            return cancelled(expected.version);
        }
        if (targetValidation.status === "invalid") {
            return rejected(expected.version, [
                diagnostic(
                    targetValidation.target,
                    "ADAPTER_DDL_RANGE",
                    "Experimental DDL target is not a complete safe source range"
                ),
            ]);
        }
        const operationResults: SnapshottedDdlResult[] = [];
        const operationDiagnostics: TransactionDiagnostic[] = [];
        for (const target of targets) {
            try {
                const operationResult = await operation(
                    expected.source.slice(target.start, target.end)
                );
                const result = snapshotResult(operationResult, target);
                if (
                    result === null ||
                    result.source !== expected.source.slice(target.start, target.end)
                ) {
                    operationDiagnostics.push(diagnostic(
                        target,
                        "ADAPTER_DDL_RESULT",
                        "Experimental DDL result violated the source identity contract"
                    ));
                } else {
                    operationResults.push(Object.freeze({ target, result }));
                }
            } catch {
                operationDiagnostics.push(diagnostic(
                    target,
                    "ADAPTER_DDL_OPERATION",
                    "Experimental DDL operation failed"
                ));
            }
            if (cancellation.isCancelled()) {
                return cancelled(expected.version);
            }
        }
        if (operationDiagnostics.length !== 0) {
            return rejected(expected.version, operationDiagnostics);
        }
        const prepared = prepareExperimentalDdlTransactionInternal(
            expected,
            Object.freeze(operationResults)
        );
        if (prepared.status !== "ready") {
            return prepared;
        }
        if (!sameDocument(expected, snapshotDocument(commit.currentDocument()))) {
            return rejected(expected.version, [
                diagnostic(
                    { id: "document", start: 0, end: expected.source.length },
                    "ADAPTER_STALE_DOCUMENT",
                    "Document changed before the experimental DDL edit could be applied",
                    "warning"
                ),
            ]);
        }
        if (cancellation.isCancelled()) {
            return cancelled(expected.version);
        }
        try {
            if (await commit.apply(prepared, expected) !== true) {
                return rejected(expected.version, [
                    diagnostic(
                        { id: "document", start: 0, end: expected.source.length },
                        "ADAPTER_EDIT_REJECTED",
                        "Host rejected the experimental DDL edits"
                    ),
                ]);
            }
        } catch {
            return rejected(expected.version, [
                diagnostic(
                    { id: "document", start: 0, end: expected.source.length },
                    "ADAPTER_EDIT_REJECTED",
                    "Host rejected the experimental DDL edits"
                ),
            ]);
        }
        return prepared;
    } finally {
        cancellation.dispose();
    }
}

export async function runExperimentalDdlTransaction(
    request: ExperimentalDdlTransactionRequest,
    operation: ExperimentalDdlOperation,
    commit: ExperimentalDdlCommit
): Promise<ExperimentalDdlTransactionResult> {
    try {
        return await runExperimentalDdlTransactionInternal(request, operation, commit);
    } catch {
        return rejected(0, [
            diagnostic(
                { id: "document", start: 0, end: 0 },
                "ADAPTER_DDL_TRANSACTION",
                "Experimental DDL transaction failed safely"
            ),
        ]);
    }
}
