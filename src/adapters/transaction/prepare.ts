import type { FormatResult } from "../../core/api/format-result";
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
    "selection",
]);
const SELECTION_KEYS: ReadonlySet<string> = new Set(["start", "end"]);
function validTarget(target: FormatTarget, sourceLength: number): boolean {
    const selection = target.selection;
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
            (target.start === 0 && target.end === sourceLength)) &&
        (selection === undefined ||
            (Number.isSafeInteger(selection.start) &&
                Number.isSafeInteger(selection.end) &&
                selection.start >= 0 &&
                selection.end >= selection.start &&
                selection.end <= target.end - target.start))
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
        const rawSelection = raw.selection;
        let selection: FormatTarget["selection"];
        if (rawSelection !== undefined) {
            const rawSelectionProperties = snapshotDataProperties(
                rawSelection,
                SELECTION_KEYS,
                ["start", "end"]
            );
            if (rawSelectionProperties === null) {
                return null;
            }
            selection = Object.freeze({
                start: rawSelectionProperties.start as number,
                end: rawSelectionProperties.end as number,
            });
        }
        const snapshot = Object.freeze({
            id: raw.id,
            start: raw.start,
            end: raw.end,
            mode: raw.mode,
            ...(selection === undefined
                ? {}
                : { selection }),
        }) as FormatTarget;
        return validTarget(snapshot, sourceLength) ? snapshot : null;
    } catch {
        return null;
    }
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
    target: FormatTarget,
    outputStart: number,
    outputEnd: number,
    selectionStart: number,
    selectionEnd: number
): TransactionSelection {
    return Object.freeze({
        targetId: target.id,
        sourceStart: target.start,
        sourceEnd: target.end,
        outputStart,
        outputEnd,
        selectionStart,
        selectionEnd,
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
    const optionsValue = optionSnapshot(request.options);
    const sourceLength =
        typeof sourceValue === "string" ? sourceValue.length : 0;
    if (optionsValue === null ||
        typeof sourceValue !== "string" ||
        !Number.isSafeInteger(documentVersionValue) ||
        documentVersionValue < 0 ||
        !Array.isArray(targetsValue)
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
    const selections: TransactionSelection[] = [];
    let cumulativeDelta = 0;
    for (const value of computed) {
        const outputStart = value.target.start + cumulativeDelta;
        const outputEnd = outputStart + value.result.text.length;
        const sourceSelection = value.target.selection ?? Object.freeze({
            start: 0,
            end: value.target.end - value.target.start,
        });
        const mappedSelection = value.sourceMap === null
            ? null
            : mapSelectionThroughSourceMap(
                  sourceSelection,
                  value.sourceMap,
                  value.target.end - value.target.start,
                  value.result.text.length
              );
        if (mappedSelection === null) {
            return rejected(documentVersionValue, [
                targetDiagnostic(
                    value.target,
                    "ADAPTER_SELECTION_MAP",
                    "Formatter selection could not be mapped safely"
                ),
            ]);
        }
        selections.push(freezeSelection(
            value.target,
            outputStart,
            outputEnd,
            outputStart + mappedSelection.start,
            outputStart + mappedSelection.end
        ));
        cumulativeDelta +=
            value.result.text.length - (value.target.end - value.target.start);
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
