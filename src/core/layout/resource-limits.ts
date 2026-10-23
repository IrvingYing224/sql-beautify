import type { AnalyzedArtifact } from "../analysis/types";
import type { LayoutDoc } from "./doc";
import { createLayoutResourceBudget } from "./resource-budget";
import type { LayoutResourceBudget } from "./resource-budget";

export type LayoutResourceCheck =
    | { readonly ok: true; readonly budget: LayoutResourceBudget }
    | { readonly ok: false; readonly message: string };

interface WorkItem {
    readonly doc: LayoutDoc;
    readonly depth: number;
    readonly cumulativeIndent: number;
    readonly cumulativeAlignColumns: number;
    readonly softLineMode: "flat" | "break" | "unknown";
}

class ResourceExceeded extends Error {}

function isPositiveSafeInteger(value: number, maximum: number): boolean {
    return Number.isSafeInteger(value) && value > 0 && value <= maximum;
}

/**
 * Numeric resource limits of one compiled LayoutDoc (plan §4 floor 4): node count, nesting,
 * cumulative indent and align, generated columns per line, pending line suffixes, generated
 * whitespace and total output. Walks the doc once, accounting generated whitespace the way the
 * renderer emits it.
 */
export function checkLayoutResources(
    analysis: AnalyzedArtifact,
    root: LayoutDoc
): LayoutResourceCheck {
    const budget = createLayoutResourceBudget(
        analysis.source.length,
        analysis.leaves.length,
        analysis.index.nodes().length
    );
    if (budget === null) {
        return { ok: false, message: "Layout resource budget could not be derived" };
    }
    const work: WorkItem[] = [
        {
            doc: root,
            depth: 1,
            cumulativeIndent: 0,
            cumulativeAlignColumns: 0,
            softLineMode: "unknown",
        },
    ];
    let docNodeCount = 0;
    let pendingLineSuffixCount = 0;
    let pendingLineComment = false;
    let generatedColumnsOnLine = 0;
    let generatedWhitespaceCodeUnits = 0;

    const exceeded = (message: string): never => {
        throw new ResourceExceeded(message);
    };

    const accountGeneratedCodeUnits = (amount: number): void => {
        if (
            amount < 0 ||
            !Number.isSafeInteger(amount) ||
            generatedWhitespaceCodeUnits >
                budget.maxGeneratedWhitespaceCodeUnits - amount
        ) {
            exceeded("Layout exceeds the total generated-whitespace budget");
        }
        generatedWhitespaceCodeUnits += amount;
    };

    const accountGeneratedColumns = (amount: number): void => {
        if (
            amount < 0 ||
            !Number.isSafeInteger(amount) ||
            generatedColumnsOnLine > budget.maxGeneratedColumnsPerLine - amount
        ) {
            exceeded("Layout exceeds the generated-column budget on one physical line");
        }
        generatedColumnsOnLine += amount;
    };

    const accountGeneratedInlineWhitespace = (amount: number): void => {
        accountGeneratedCodeUnits(amount);
        accountGeneratedColumns(amount);
    };

    const generatedLinePrefixColumns = (item: WorkItem): number => {
        const columns = item.cumulativeIndent * 4 + item.cumulativeAlignColumns;
        if (!Number.isSafeInteger(columns) || columns > budget.maxGeneratedColumnsPerLine) {
            exceeded("Layout line prefix exceeds the generated-column budget");
        }
        return columns;
    };

    const accountGeneratedBreak = (item: WorkItem): void => {
        const prefixColumns = generatedLinePrefixColumns(item);
        accountGeneratedCodeUnits(1 + prefixColumns);
        pendingLineSuffixCount = 0;
        pendingLineComment = false;
        generatedColumnsOnLine = 0;
        accountGeneratedColumns(prefixColumns);
    };

    const accountSourceDerivedLineEnding = (item: WorkItem): void => {
        const prefixColumns = generatedLinePrefixColumns(item);
        pendingLineSuffixCount = 0;
        pendingLineComment = false;
        generatedColumnsOnLine = 0;
        accountGeneratedCodeUnits(prefixColumns);
        accountGeneratedColumns(prefixColumns);
    };

    // A pending line comment forces a break before the next source emission; block-only
    // suffixes flush in source order without one.
    const beforeSourceEmission = (item: WorkItem, startsWithLineBreak: boolean): void => {
        if ((pendingLineSuffixCount === 0 && !pendingLineComment) || startsWithLineBreak) {
            return;
        }
        if (pendingLineComment) {
            accountGeneratedBreak(item);
        } else {
            pendingLineSuffixCount = 0;
        }
    };

    const emitSource = (
        item: WorkItem,
        containsLineBreak: boolean,
        startsWithLineBreak: boolean,
        endsWithLineBreak: boolean,
        endsWithLineComment: boolean
    ): void => {
        beforeSourceEmission(item, startsWithLineBreak);
        if (containsLineBreak) {
            pendingLineSuffixCount = 0;
            pendingLineComment = false;
            generatedColumnsOnLine = 0;
        }
        if (endsWithLineBreak) {
            accountSourceDerivedLineEnding(item);
        } else if (endsWithLineComment) {
            pendingLineComment = true;
        }
    };

    const child = (item: WorkItem, doc: LayoutDoc, change: Partial<WorkItem> = {}): void => {
        work.push({ ...item, doc, depth: item.depth + 1, ...change });
    };

    const checkPositive = (value: number, maximum: number, message: string): void => {
        if (!isPositiveSafeInteger(value, maximum)) {
            exceeded(message);
        }
    };

    try {
        while (work.length > 0) {
            const item = work.pop()!;
            const doc = item.doc;
            docNodeCount += 1;
            if (docNodeCount > budget.maxDocNodes) {
                exceeded("Layout graph exceeds the document-node budget");
            }
            if (item.depth > budget.maxGraphNesting) {
                exceeded("Layout graph exceeds the nesting budget");
            }
            if (item.cumulativeIndent > budget.maxCumulativeIndentLevels) {
                exceeded("Layout graph exceeds the cumulative indent budget");
            }
            if (item.cumulativeAlignColumns > budget.maxGeneratedColumnsPerLine) {
                exceeded("Layout graph exceeds the cumulative align-column budget");
            }

            switch (doc.kind) {
                case "leaf":
                    emitSource(
                        item,
                        analysis.index.leafContainsLineBreak(doc.leafId),
                        analysis.index.leafStartsWithLineBreak(doc.leafId),
                        analysis.index.leafEndsWithLineBreak(doc.leafId),
                        analysis.leaves[doc.leafId]!.kind === "line-comment"
                    );
                    break;

                case "verbatim":
                    emitSource(
                        item,
                        analysis.index.rangeContainsLineBreak(doc.leafRange),
                        analysis.index.rangeStartsWithLineBreak(doc.leafRange),
                        analysis.index.rangeEndsWithLineBreak(doc.leafRange),
                        analysis.leaves[doc.leafRange.end - 1]?.kind === "line-comment"
                    );
                    break;

                case "space":
                    checkPositive(
                        doc.columns,
                        budget.maxGeneratedColumnsPerLine,
                        "Space columns are outside the generated-column budget"
                    );
                    accountGeneratedInlineWhitespace(doc.columns);
                    break;

                case "line":
                    if (doc.mode === "hard" || item.softLineMode === "break") {
                        accountGeneratedBreak(item);
                    } else if (item.softLineMode === "flat") {
                        accountGeneratedInlineWhitespace(doc.flat === "space" ? 1 : 0);
                    } else {
                        accountGeneratedCodeUnits(1 + generatedLinePrefixColumns(item));
                        accountGeneratedColumns(doc.flat === "space" ? 1 : 0);
                    }
                    break;

                case "concat":
                    for (let index = doc.parts.length - 1; index >= 0; index--) {
                        child(item, doc.parts[index]!);
                    }
                    break;

                case "indent":
                    checkPositive(
                        doc.levels,
                        budget.maxCumulativeIndentLevels,
                        "Indent levels are outside the cumulative-indent budget"
                    );
                    child(item, doc.content, {
                        cumulativeIndent: item.cumulativeIndent + doc.levels,
                    });
                    break;

                case "align":
                    checkPositive(
                        doc.columns,
                        budget.maxGeneratedColumnsPerLine,
                        "Align columns are outside the generated-column budget"
                    );
                    child(item, doc.content, {
                        cumulativeAlignColumns: item.cumulativeAlignColumns + doc.columns,
                    });
                    break;

                case "pad-to-column":
                    checkPositive(
                        doc.targetColumn,
                        budget.maxGeneratedColumnsPerLine,
                        "Pad target is outside the generated-column budget"
                    );
                    accountGeneratedInlineWhitespace(doc.targetColumn);
                    break;

                case "group":
                    if (doc.mode === "auto") {
                        checkPositive(
                            doc.maxFlatWidth,
                            budget.maxGeneratedColumnsPerLine,
                            "Auto-group width is outside the generated-column budget"
                        );
                    }
                    child(item, doc.content, {
                        softLineMode:
                            item.softLineMode === "flat" || doc.mode === "flat"
                                ? "flat"
                                : doc.mode === "break"
                                  ? "break"
                                  : "unknown",
                    });
                    break;

                case "line-suffix": {
                    pendingLineSuffixCount += 1;
                    if (pendingLineSuffixCount > budget.maxPendingLineSuffixes) {
                        exceeded("Layout exceeds the line-suffix budget");
                    }
                    if (doc.spacing !== null) {
                        accountGeneratedInlineWhitespace(
                            doc.spacing.kind === "space"
                                ? doc.spacing.columns
                                : doc.spacing.targetColumn
                        );
                    }
                    if (analysis.index.leafContainsLineBreak(doc.commentLeafId)) {
                        pendingLineSuffixCount = 0;
                        pendingLineComment = false;
                        generatedColumnsOnLine = 0;
                    }
                    if (analysis.index.leafEndsWithLineBreak(doc.commentLeafId)) {
                        accountSourceDerivedLineEnding(item);
                    } else if (analysis.leaves[doc.commentLeafId]!.kind === "line-comment") {
                        pendingLineComment = true;
                    }
                    break;
                }
            }
        }
        if (analysis.source.length > budget.maxOutputCodeUnits - generatedWhitespaceCodeUnits) {
            exceeded("Layout exceeds the total output-code-unit budget");
        }
    } catch (error) {
        if (error instanceof ResourceExceeded) {
            return { ok: false, message: error.message };
        }
        throw error;
    }
    return { ok: true, budget };
}
