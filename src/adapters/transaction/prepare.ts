import type { FormatResult } from "../../core/api/format-result";
import {
    inferRenderNewline,
    isRenderNewline,
} from "../../core/renderer/environment";
import type { Diagnostic } from "../../core/diagnostics/diagnostic";
import { resolveFormatOptions } from "../../core/config/resolve-options";
import type { SourceMap } from "../../core/source/source-map";
import {
    snapshotDataProperties,
    snapshotDenseDataArray,
} from "../boundary/data-snapshot";
import {
    isFormatResultSafeForSource,
    snapshotFormatResult,
} from "../boundary/format-result-snapshot";
import { mapSelectionThroughSourceMap } from "./cursor";
import {
    convertDiagnostic,
    sortDiagnostics,
} from "../diagnostics/convert";
import { observeCancellation } from "./cancellation";
import { validateFormatTargetRanges } from "./range";

function compareString(left: string, right: string): number {
    return left < right ? -1 : left > right ? 1 : 0;
}
import type {
    CancelledFormatTransaction,
    FormatSelection,
    FormatTarget,
    FormatTransactionRequest,
    FormatTransactionResult,
    FormatterExecutor,
    RejectedFormatTransaction,
    TransactionDiagnostic,
    TransactionEdit,
    TransactionSelection,
} from "./types";

function diagnostic(
    sourceLength: number,
    code: string,
    message: string,
    targetId: string | null = null
): TransactionDiagnostic {
    return Object.freeze({
        code,
        severity: "error" as const,
        message,
        capabilityId: null,
        span: Object.freeze({ start: 0, end: sourceLength }),
        recovery: "preserve-target" as const,
        targetId,
    });
}

function targetDiagnostic(
    target: FormatTarget,
    code: string,
    message: string
): TransactionDiagnostic {
    return Object.freeze({
        code,
        severity: "error" as const,
        message,
        capabilityId: null,
        span: Object.freeze({ start: target.start, end: target.end }),
        recovery: "preserve-target" as const,
        targetId: target.id,
    });
}

function cancelled(documentVersion: number): CancelledFormatTransaction {
    return Object.freeze({
        status: "cancelled",
        documentVersion,
        diagnostics: Object.freeze([]) as readonly [],
    });
}

function optionSnapshot(value: FormatTransactionRequest["options"]): FormatTransactionRequest["options"] | null {
    if (value === undefined) {
        return undefined;
    }
    const resolved = resolveFormatOptions(value);
    return resolved.ok ? resolved.options : null;
}

function rejected(
    documentVersion: number,
    diagnostics: readonly TransactionDiagnostic[]
): RejectedFormatTransaction {
    return Object.freeze({
        status: "rejected",
        documentVersion,
        diagnostics: sortDiagnostics(diagnostics),
    });
}

const TARGET_KEYS: ReadonlySet<string> = new Set([
    "id",
    "start",
    "end",
    "mode",
]);
const SELECTION_KEYS: ReadonlySet<string> = new Set([
    "id",
    "targetId",
    "anchor",
    "active",
]);
function validTarget(target: FormatTarget, sourceLength: number): boolean {
    return (
        typeof target.id === "string" &&
        target.id.length > 0 &&
        Number.isSafeInteger(target.start) &&
        Number.isSafeInteger(target.end) &&
        target.start >= 0 &&
        target.end >= target.start &&
        target.end <= sourceLength &&
        (target.mode === "document" || target.mode === "fragment") &&
        (target.mode !== "document" ||
            (target.start === 0 && target.end === sourceLength))
    );
}

function snapshotTarget(
    value: FormatTarget,
    sourceLength: number
): FormatTarget | null {
    try {
        const raw = snapshotDataProperties(value, TARGET_KEYS, ["id", "start", "end", "mode"]);
        if (raw === null) {
            return null;
        }
        const snapshot = Object.freeze({
            id: raw.id,
            start: raw.start,
            end: raw.end,
            mode: raw.mode,
        }) as FormatTarget;
        return validTarget(snapshot, sourceLength) ? snapshot : null;
    } catch {
        return null;
    }
}

function snapshotSelections(
    values: readonly FormatSelection[] | undefined,
    sourceLength: number,
    targets: readonly FormatTarget[]
): readonly FormatSelection[] | null {
    if (values === undefined) {
        return Object.freeze([]);
    }
    const rawSelections = snapshotDenseDataArray(values);
    if (rawSelections === null) {
        return null;
    }
    const ids = new Set<string>();
    const selections: FormatSelection[] = [];
    for (const rawSelection of rawSelections) {
        const raw = snapshotDataProperties(
            rawSelection,
            SELECTION_KEYS,
            ["id", "targetId", "anchor", "active"]
        );
        const targetId = raw?.targetId;
        const target = typeof targetId === "string"
            ? targets.find((value) => value.id === targetId) ?? null
            : null;
        if (
            raw === null ||
            typeof raw.id !== "string" ||
            raw.id.length === 0 ||
            ids.has(raw.id) ||
            (targetId !== null && typeof targetId !== "string") ||
            (typeof targetId === "string" && target === null) ||
            !Number.isSafeInteger(raw.anchor) ||
            !Number.isSafeInteger(raw.active) ||
            (raw.anchor as number) < 0 ||
            (raw.active as number) < 0 ||
            (raw.anchor as number) > sourceLength ||
            (raw.active as number) > sourceLength ||
            (target !== null && (
                (raw.anchor as number) < target.start ||
                (raw.anchor as number) > target.end ||
                (raw.active as number) < target.start ||
                (raw.active as number) > target.end
            ))
        ) {
            return null;
        }
        ids.add(raw.id);
        selections.push(Object.freeze({
            id: raw.id,
            targetId: targetId as string | null,
            anchor: raw.anchor as number,
            active: raw.active as number,
        }));
    }
    return Object.freeze(selections);
}

function sortedTargets(
    source: string,
    values: readonly FormatTarget[]
): readonly FormatTarget[] | null {
    const ids = new Set<string>();
    const targets: FormatTarget[] = [];
    const rawTargets = snapshotDenseDataArray(values);
    if (rawTargets === null) {
        return null;
    }
    for (const rawTarget of rawTargets) {
        const target = snapshotTarget(rawTarget as FormatTarget, source.length);
        if (target === null || ids.has(target.id)) {
            return null;
        }
        ids.add(target.id);
        targets.push(target);
    }
    targets.sort((left, right) =>
        left.start - right.start || left.end - right.end || compareString(left.id, right.id)
    );
    for (let index = 1; index < targets.length; index++) {
        if (targets[index - 1]!.end > targets[index]!.start) {
            return null;
        }
    }
    if (
        targets.some((target) => target.mode === "document") &&
        targets.length !== 1
    ) {
        return null;
    }
    return Object.freeze(targets);
}

function absoluteDiagnostic(
    value: Diagnostic,
    target: FormatTarget
): TransactionDiagnostic {
    return convertDiagnostic(
        value,
        target.id,
        target.start,
        target.end - target.start
    ) ?? targetDiagnostic(
        target,
        "ADAPTER_DIAGNOSTIC_CONTRACT",
        "Formatter diagnostic violated the adapter contract"
    );
}

interface ComputedTarget {
    readonly target: FormatTarget;
    readonly result: FormatResult;
    readonly sourceMap: SourceMap | null;
}

function freezeSelection(
    selectionId: string,
    selectionAnchor: number,
    selectionActive: number
): TransactionSelection {
    return Object.freeze({
        selectionId,
        selectionAnchor,
        selectionActive,
    });
}

function appendSourceMapEntry(
    entries: Array<{
        readonly source: Readonly<{ readonly start: number; readonly end: number }>;
        readonly output: Readonly<{ readonly start: number; readonly end: number }>;
    }>,
    sourceStart: number,
    sourceEnd: number,
    outputStart: number,
    outputEnd: number
): void {
    if (sourceEnd <= sourceStart || outputEnd <= outputStart) {
        return;
    }
    const previous = entries[entries.length - 1];
    if (
        previous !== undefined &&
        previous.source.end === sourceStart &&
        previous.output.end === outputStart
    ) {
        entries[entries.length - 1] = Object.freeze({
            source: Object.freeze({ start: previous.source.start, end: sourceEnd }),
            output: Object.freeze({ start: previous.output.start, end: outputEnd }),
        });
        return;
    }
    entries.push(Object.freeze({
        source: Object.freeze({ start: sourceStart, end: sourceEnd }),
        output: Object.freeze({ start: outputStart, end: outputEnd }),
    }));
}

function documentSourceMap(
    sourceLength: number,
    computed: readonly ComputedTarget[]
): Readonly<{ readonly sourceMap: SourceMap; readonly outputLength: number }> | null {
    const entries: Array<{
        readonly source: Readonly<{ readonly start: number; readonly end: number }>;
        readonly output: Readonly<{ readonly start: number; readonly end: number }>;
    }> = [];
    let sourceCursor = 0;
    let outputCursor = 0;
    for (const value of computed) {
        const sourceMap = value.sourceMap;
        if (sourceMap === null) {
            return null;
        }
        const gapLength = value.target.start - sourceCursor;
        appendSourceMapEntry(
            entries,
            sourceCursor,
            value.target.start,
            outputCursor,
            outputCursor + gapLength
        );
        outputCursor += gapLength;
        const targetOutputStart = outputCursor;
        for (const entry of sourceMap.entries) {
            appendSourceMapEntry(
                entries,
                value.target.start + entry.source.start,
                value.target.start + entry.source.end,
                targetOutputStart + entry.output.start,
                targetOutputStart + entry.output.end
            );
        }
        sourceCursor = value.target.end;
        outputCursor = targetOutputStart + value.result.text.length;
    }
    const tailLength = sourceLength - sourceCursor;
    appendSourceMapEntry(
        entries,
        sourceCursor,
        sourceLength,
        outputCursor,
        outputCursor + tailLength
    );
    return Object.freeze({
        sourceMap: Object.freeze({ entries: Object.freeze(entries) }),
        outputLength: outputCursor + tailLength,
    });
}

async function prepareFormatTransactionInternal(
    request: FormatTransactionRequest,
    executor: FormatterExecutor,
    cancellationValue: FormatTransactionRequest["cancellation"],
    isCancelledNow: () => boolean
): Promise<FormatTransactionResult> {
    const sourceValue = request.source;
    const documentVersionValue = request.documentVersion;
    const targetsValue = request.targets;
    const selectionsValue = request.selections;
    const optionsValue = optionSnapshot(request.options);
    const requestedNewline = request.newline;
    const sourceLength =
        typeof sourceValue === "string" ? sourceValue.length : 0;
    if (optionsValue === null ||
        typeof sourceValue !== "string" ||
        !Number.isSafeInteger(documentVersionValue) ||
        documentVersionValue < 0 ||
        !Array.isArray(targetsValue) ||
        (requestedNewline !== undefined && !isRenderNewline(requestedNewline))
    ) {
        return rejected(
            Number.isSafeInteger(documentVersionValue)
                ? documentVersionValue
                : 0,
            [
                diagnostic(
                    sourceLength,
                    "ADAPTER_TRANSACTION_REQUEST",
                    "Formatter transaction request is invalid"
                ),
            ]
        );
    }
    const newline = requestedNewline ?? inferRenderNewline(sourceValue);
    if (isCancelledNow()) {
        return cancelled(documentVersionValue);
    }
    const targets = sortedTargets(sourceValue, targetsValue);
    if (targets === null) {
        return rejected(documentVersionValue, [
            diagnostic(
                sourceLength,
                "ADAPTER_TRANSACTION_TARGET",
                "Formatter transaction targets are invalid or overlapping"
            ),
        ]);
    }
    const requestedSelections = snapshotSelections(
        selectionsValue,
        sourceValue.length,
        targets
    );
    if (requestedSelections === null) {
        return rejected(documentVersionValue, [
            diagnostic(
                sourceLength,
                "ADAPTER_TRANSACTION_SELECTION",
                "Formatter transaction selections are invalid"
            ),
        ]);
    }
    const rangeValidation = validateFormatTargetRanges(
        sourceValue,
        targets,
        optionsValue
    );
    if (!rangeValidation.safe) {
        const rangeTarget = rangeValidation.targetId === null
            ? null
            : targets.find((target) => target.id === rangeValidation.targetId) ?? null;
        return rejected(documentVersionValue, [
            rangeTarget === null
                ? diagnostic(
                      sourceLength,
                      rangeValidation.code,
                      rangeValidation.message,
                      rangeValidation.targetId
                  )
                : targetDiagnostic(
                      rangeTarget,
                      rangeValidation.code,
                      rangeValidation.message
                  ),
        ]);
    }

    const computed: ComputedTarget[] = [];
    for (const target of targets) {
        if (isCancelledNow()) {
            return cancelled(documentVersionValue);
        }
        const targetSource = sourceValue.slice(target.start, target.end);
        if (target.start === target.end) {
            computed.push(
                Object.freeze({
                    target,
                    result: Object.freeze({
                        status: "unchanged" as const,
                        text: "",
                        diagnostics: Object.freeze([]),
                        sourceMap: Object.freeze({ entries: Object.freeze([]) }),
                    }),
                    sourceMap: Object.freeze({ entries: Object.freeze([]) }),
                })
            );
            continue;
        }
        let result: unknown;
        try {
            const executionRequest = {
                source: targetSource,
                mode: target.mode,
                documentVersion: documentVersionValue,
                targetId: target.id,
                newline,
                ...(optionsValue === undefined
                    ? {}
                    : { options: optionsValue }),
                ...(cancellationValue === undefined
                    ? {}
                    : { cancellation: cancellationValue }),
            };
            result = await executor.format(executionRequest);
        } catch {
            return rejected(documentVersionValue, [
                targetDiagnostic(
                    target,
                    "ADAPTER_EXECUTOR_FAILED",
                    "Formatter executor failed"
                ),
            ]);
        }
        if (isCancelledNow()) {
            return cancelled(documentVersionValue);
        }
        let snapshot: FormatResult;
        try {
            const value = snapshotFormatResult(result);
            if (value === null) {
                throw new TypeError("unsafe formatter result snapshot");
            }
            snapshot = value;
        } catch {
            return rejected(documentVersionValue, [
                targetDiagnostic(
                    target,
                    "ADAPTER_RESULT_SNAPSHOT",
                    "Formatter result could not be inspected safely"
                ),
            ]);
        }
        if (!isFormatResultSafeForSource(snapshot, targetSource)) {
            return rejected(documentVersionValue, [
                targetDiagnostic(
                    target,
                    "ADAPTER_RESULT_CONTRACT",
                    "Formatter result violated the transaction contract"
                ),
            ]);
        }
        computed.push(
            Object.freeze({
                target,
                result: snapshot,
                sourceMap:
                    snapshot.status === "formatted" || snapshot.status === "unchanged"
                        ? snapshot.sourceMap
                        : null,
            })
        );
    }

    const diagnostics: TransactionDiagnostic[] = [];
    for (const value of computed) {
        for (const item of value.result.diagnostics) {
            diagnostics.push(absoluteDiagnostic(item, value.target));
        }
    }
    if (diagnostics.some((item) => item.severity === "error")) {
        return rejected(documentVersionValue, diagnostics);
    }
    for (const value of computed) {
        if (value.result.status === "failed" || value.result.status === "preserved") {
            return rejected(documentVersionValue, diagnostics);
        }
    }

    const edits: TransactionEdit[] = [];
    const outputStartByTargetId = new Map<string, number>();
    let outputDelta = 0;
    for (const value of computed) {
        outputStartByTargetId.set(value.target.id, value.target.start + outputDelta);
        outputDelta += value.result.text.length -
            (value.target.end - value.target.start);
        if (value.result.status === "formatted") {
            edits.push(
                Object.freeze({
                    targetId: value.target.id,
                    start: value.target.start,
                    end: value.target.end,
                    text: value.result.text,
                    sourceMap: value.sourceMap!,
                })
            );
        }
    }

    const combinedMap = documentSourceMap(sourceValue.length, computed);
    if (combinedMap === null) {
        return rejected(documentVersionValue, [
            diagnostic(
                sourceLength,
                "ADAPTER_SELECTION_MAP",
                "Formatter selections could not be mapped safely"
            ),
        ]);
    }
    const selections: TransactionSelection[] = [];
    for (const selection of requestedSelections) {
        const target = selection.targetId === null
            ? null
            : computed.find((value) => value.target.id === selection.targetId) ?? null;
        const targetOutputStart = target === null
            ? null
            : outputStartByTargetId.get(target.target.id) ?? null;
        const mapped = target === null || targetOutputStart === null
            ? mapSelectionThroughSourceMap(
                  selection,
                  combinedMap.sourceMap,
                  sourceValue.length,
                  combinedMap.outputLength
              )
            : (() => {
                  const local = mapSelectionThroughSourceMap(
                      Object.freeze({
                          anchor: selection.anchor - target.target.start,
                          active: selection.active - target.target.start,
                      }),
                      target.sourceMap!,
                      target.target.end - target.target.start,
                      target.result.text.length
                  );
                  return local === null ? null : Object.freeze({
                      anchor: targetOutputStart + local.anchor,
                      active: targetOutputStart + local.active,
                  });
              })();
        if (mapped === null) {
            return rejected(documentVersionValue, [
                diagnostic(
                    sourceLength,
                    "ADAPTER_SELECTION_MAP",
                    "Formatter selection could not be mapped safely"
                ),
            ]);
        }
        selections.push(freezeSelection(
            selection.id,
            mapped.anchor,
            mapped.active
        ));
    }

    const frozenDiagnostics = sortDiagnostics(diagnostics);
    const frozenSelections = Object.freeze(selections);
    if (edits.length === 0) {
        return Object.freeze({
            status: "unchanged",
            documentVersion: documentVersionValue,
            edits: Object.freeze([]) as readonly [],
            selections: frozenSelections,
            diagnostics: frozenDiagnostics,
        });
    }
    return Object.freeze({
        status: "ready",
        documentVersion: documentVersionValue,
        edits: Object.freeze(edits),
        selections: frozenSelections,
        diagnostics: frozenDiagnostics,
    });
}

export async function prepareFormatTransaction(
    request: FormatTransactionRequest,
    executor: FormatterExecutor
): Promise<FormatTransactionResult> {
    let observation: ReturnType<typeof observeCancellation> | null = null;
    try {
        const cancellationValue = request.cancellation;
        observation = observeCancellation(cancellationValue);
        return await prepareFormatTransactionInternal(
            request,
            executor,
            cancellationValue,
            observation.isCancelled
        );
    } catch {
        return rejected(0, [
            diagnostic(
                0,
                "ADAPTER_TRANSACTION_READ",
                "Formatter transaction could not be inspected"
            ),
        ]);
    } finally {
        observation?.dispose();
    }
}
