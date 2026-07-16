export interface LayoutResourceBudget {
    readonly inputUnits: number;
    readonly sourceLength: number;
    readonly maxDocNodes: number;
    readonly maxPlanActions: number;
    readonly maxGraphNesting: number;
    readonly maxCumulativeIndentLevels: number;
    readonly maxPendingLineSuffixes: number;
    readonly maxGeneratedColumnsPerLine: number;
    readonly maxGeneratedWhitespaceCodeUnits: number;
    readonly maxOutputCodeUnits: number;
}

function checkedLinear(
    multiplier: number,
    value: number,
    extra: number
): number | null {
    const result = multiplier * value + extra;
    return Number.isSafeInteger(result) && result >= 0 ? result : null;
}

/** Exact Wave 3 resource formula frozen by the design contract. */
export function createLayoutResourceBudget(
    sourceLength: number,
    leafCount: number,
    syntaxNodeCount: number
): LayoutResourceBudget | null {
    if (
        !Number.isSafeInteger(sourceLength) ||
        !Number.isSafeInteger(leafCount) ||
        !Number.isSafeInteger(syntaxNodeCount) ||
        sourceLength < 0 ||
        leafCount < 0 ||
        syntaxNodeCount < 0
    ) {
        return null;
    }

    const combinedUnits = leafCount + syntaxNodeCount;
    if (!Number.isSafeInteger(combinedUnits)) {
        return null;
    }
    const inputUnits = Math.max(1, combinedUnits);
    const maxDocNodes = checkedLinear(24, inputUnits, 64);
    const maxPlanActions = checkedLinear(16, inputUnits, 64);
    const maxGeneratedColumnsPerLine = checkedLinear(4, inputUnits, 256);
    const generatedFromUnits = checkedLinear(32, inputUnits, 4096);
    const generatedFromSource = checkedLinear(2, sourceLength, 0);
    if (
        maxDocNodes === null ||
        maxPlanActions === null ||
        maxGeneratedColumnsPerLine === null ||
        generatedFromUnits === null ||
        generatedFromSource === null
    ) {
        return null;
    }
    const maxGeneratedWhitespaceCodeUnits = generatedFromUnits + generatedFromSource;
    const maxOutputCodeUnits = sourceLength + maxGeneratedWhitespaceCodeUnits;
    if (
        !Number.isSafeInteger(maxGeneratedWhitespaceCodeUnits) ||
        !Number.isSafeInteger(maxOutputCodeUnits)
    ) {
        return null;
    }

    return Object.freeze({
        inputUnits,
        sourceLength,
        maxDocNodes,
        maxPlanActions,
        maxGraphNesting: Math.min(4096, inputUnits + 64),
        maxCumulativeIndentLevels: Math.min(512, inputUnits + 32),
        maxPendingLineSuffixes: Math.min(4096, inputUnits),
        maxGeneratedColumnsPerLine,
        maxGeneratedWhitespaceCodeUnits,
        maxOutputCodeUnits,
    });
}
