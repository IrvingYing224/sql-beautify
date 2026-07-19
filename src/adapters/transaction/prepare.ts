import type { FormatResult } from "../../core/api/format-result";
import type { Diagnostic } from "../../core/diagnostics/diagnostic";
import {
    isValidSourceMap,
    type SourceMap,
} from "../../core/source/source-map";
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

function cancelled(documentVersion: number): CancelledFormatTransaction {
    return Object.freeze({
        status: "cancelled",
        documentVersion,
        diagnostics: Object.freeze([]) as readonly [],
    });
}

function isCancelled(
    token: FormatTransactionRequest["cancellation"]
): boolean {
    return token?.isCancellationRequested === true;
}

function rejected(
    documentVersion: number,
    diagnostics: readonly TransactionDiagnostic[]
): RejectedFormatTransaction {
    return Object.freeze({
        status: "rejected",
        documentVersion,
        diagnostics: Object.freeze(Array.from(diagnostics)),
    });
}

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
        if (typeof value !== "object" || value === null) {
            return null;
        }
        const snapshot = Object.freeze({
            id: value.id,
            start: value.start,
            end: value.end,
            mode: value.mode,
        });
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
    const rawTargets = Array.from(values);
    for (const rawTarget of rawTargets) {
        const target = snapshotTarget(rawTarget, source.length);
        if (target === null || ids.has(target.id)) {
            return null;
        }
        ids.add(target.id);
        targets.push(target);
    }
    targets.sort((left, right) =>
        left.start - right.start || left.end - right.end || left.id.localeCompare(right.id)
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
    return Object.freeze({
        code: value.code,
        severity: value.severity,
        message: value.message,
        capabilityId: value.capabilityId,
        span: Object.freeze({
            start: target.start + value.span.start,
            end: target.start + value.span.end,
        }),
        recovery: value.recovery,
        targetId: target.id,
    });
}

function resultIsSafeForTarget(result: FormatResult, source: string): boolean {
    if (!Array.isArray(result.diagnostics)) {
        return false;
    }
    for (const value of result.diagnostics) {
        if (
            typeof value.code !== "string" ||
            typeof value.message !== "string" ||
            (value.capabilityId !== null && typeof value.capabilityId !== "string") ||
            (value.severity !== "info" &&
                value.severity !== "warning" &&
                value.severity !== "error") ||
            !Number.isSafeInteger(value.span.start) ||
            !Number.isSafeInteger(value.span.end) ||
            value.span.start < 0 ||
            value.span.end < value.span.start ||
            value.span.end > source.length ||
            (value.recovery !== "none" &&
                value.recovery !== "verbatim-node" &&
                value.recovery !== "preserve-statement" &&
                value.recovery !== "preserve-target")
        ) {
            return false;
        }
    }
    if (result.status === "formatted") {
        return (
            result.text !== source &&
            isValidSourceMap(result.sourceMap, source.length, result.text.length)
        );
    }
    if (result.status === "unchanged") {
        return (
            result.text === source &&
            isValidSourceMap(result.sourceMap, source.length, result.text.length)
        );
    }
    return (
        (result.status === "failed" || result.status === "preserved") &&
        result.text === source &&
        result.diagnostics.length > 0
    );
}

function snapshotSourceMap(value: SourceMap): SourceMap {
    return Object.freeze({
        entries: Object.freeze(
            value.entries.map((entry) =>
                Object.freeze({
                    source: Object.freeze({
                        start: entry.source.start,
                        end: entry.source.end,
                    }),
                    output: Object.freeze({
                        start: entry.output.start,
                        end: entry.output.end,
                    }),
                })
            )
        ),
    });
}

function snapshotFormatResult(value: FormatResult): FormatResult {
    const status = value.status;
    const text = value.text;
    const diagnostics = Object.freeze(
        value.diagnostics.map((item) =>
            Object.freeze({
                code: item.code,
                severity: item.severity,
                message: item.message,
                capabilityId: item.capabilityId,
                span: Object.freeze({
                    start: item.span.start,
                    end: item.span.end,
                }),
                recovery: item.recovery,
            })
        )
    );
    if (status === "formatted" || status === "unchanged") {
        return Object.freeze({
            status,
            text,
            diagnostics,
            sourceMap: snapshotSourceMap(value.sourceMap),
        });
    }
    return Object.freeze({ status, text, diagnostics });
}

interface ComputedTarget {
    readonly target: FormatTarget;
    readonly result: FormatResult;
    readonly sourceMap: SourceMap | null;
}

function freezeSelection(
    target: FormatTarget,
    outputStart: number,
    outputEnd: number
): TransactionSelection {
    return Object.freeze({
        targetId: target.id,
        sourceStart: target.start,
        sourceEnd: target.end,
        outputStart,
        outputEnd,
    });
}

async function prepareFormatTransactionInternal(
    request: FormatTransactionRequest,
    executor: FormatterExecutor
): Promise<FormatTransactionResult> {
    const sourceValue = request.source;
    const documentVersionValue = request.documentVersion;
    const targetsValue = request.targets;
    const optionsValue = request.options;
    const cancellationValue = request.cancellation;
    const sourceLength =
        typeof sourceValue === "string" ? sourceValue.length : 0;
    if (
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
    if (isCancelled(cancellationValue)) {
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

    const computed: ComputedTarget[] = [];
    for (const target of targets) {
        if (isCancelled(cancellationValue)) {
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
        let result: FormatResult;
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
                diagnostic(
                    targetSource.length,
                    "ADAPTER_EXECUTOR_FAILED",
                    "Formatter executor failed",
                    target.id
                ),
            ]);
        }
        if (isCancelled(cancellationValue)) {
            return cancelled(documentVersionValue);
        }
        if (!resultIsSafeForTarget(result, targetSource)) {
            return rejected(documentVersionValue, [
                diagnostic(
                    targetSource.length,
                    "ADAPTER_RESULT_CONTRACT",
                    "Formatter result violated the transaction contract",
                    target.id
                ),
            ]);
        }
        let snapshot: FormatResult;
        try {
            snapshot = snapshotFormatResult(result);
        } catch {
            return rejected(documentVersionValue, [
                diagnostic(
                    targetSource.length,
                    "ADAPTER_RESULT_SNAPSHOT",
                    "Formatter result changed while it was being inspected",
                    target.id
                ),
            ]);
        }
        if (!resultIsSafeForTarget(snapshot, targetSource)) {
            return rejected(documentVersionValue, [
                diagnostic(
                    targetSource.length,
                    "ADAPTER_RESULT_SNAPSHOT",
                    "Formatter result snapshot violated the transaction contract",
                    target.id
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
        selections.push(freezeSelection(value.target, outputStart, outputEnd));
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

    const frozenDiagnostics = Object.freeze(diagnostics);
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
    try {
        return await prepareFormatTransactionInternal(request, executor);
    } catch {
        return rejected(0, [
            diagnostic(
                0,
                "ADAPTER_TRANSACTION_READ",
                "Formatter transaction could not be inspected"
            ),
        ]);
    }
}
