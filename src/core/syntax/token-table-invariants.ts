import type { SourceLeaf } from "../lexer/token";
import type { SourceSpan } from "../source/source-span";
import type { LeafRange } from "./leaf-range";
import type {
    InvariantFailure,
    InvariantFailureCode,
    InvariantResult,
} from "./invariant-types";
import {
    canonicalNormalizedWord,
    fail,
    isDenseArray,
    isFiniteNonNegInt,
    isLeafRange,
    isObject,
    isSourceSpan,
    isStructuralCodeLeaf,
    leavesEqual,
    rangeToSpan,
    resultOf,
} from "./invariant-shared";
import { deriveExpectedTable } from "./token-table-expected";
import type { StructuralTokenTable } from "./token-table";

const REQUIRED_METHODS = [
    "leafCount",
    "syntaxLeafCount",
    "previousSyntaxLeafIndex",
    "nextSyntaxLeafIndex",
    "syntaxOrdinalOfLeaf",
    "leafIndexOfSyntaxOrdinal",
    "codeLeafCount",
    "previousCodeLeafIndex",
    "nextCodeLeafIndex",
    "codeOrdinalOfLeaf",
    "leafIndexOfCodeOrdinal",
    "depthBefore",
    "depthAfter",
    "matchingDelimiterIndex",
    "statementRanges",
    "statementBoundariesReliable",
    "structuralIssues",
    "rangeToSpan",
    "normalizedWord",
    "codeWordsEqual",
    "getLeaf",
] as const;

type RequiredMethodName = (typeof REQUIRED_METHODS)[number];

const MAX_TOKEN_TABLE_FAILURES = 32;
const STRUCT_ISSUE_CODES = new Set([
    "STRUCT_UNMATCHED_OPENER",
    "STRUCT_UNMATCHED_CLOSER",
    "STRUCT_MIXED_DELIMITER",
    "STRUCT_UNRELIABLE_STATEMENT_BOUNDARY",
]);

type TokenValidationContext = {
    readonly failures: InvariantFailure[];
    readonly invalidMethods: Set<RequiredMethodName>;
    halted: boolean;
};

/**
 * Production token-table invariant: valid-domain O(n) facts + fixed O(1)
 * representative illegal-input probes. Exhaustive misuse matrix lives in tests.
 *
 * Broken methods use one circuit per API. The first valid-domain throw, invalid
 * return type, or canonical mismatch records one primary failure and stops that
 * method without suppressing independent API checks.
 */
export function validateTokenTableInvariants(
    table: StructuralTokenTable | null | undefined,
    leaves: readonly SourceLeaf[]
): InvariantResult {
    const context = createValidationContext();

    try {
        if (table === null || table === undefined || typeof table !== "object" || Array.isArray(table)) {
            recordFailure(context, "INV_TOKEN_TABLE", "token table is missing or not an object");
            return resultOf(context.failures);
        }

        // Required API preflight must remain before every leaves-dependent operation.
        const tableRec = table as unknown as Record<string, unknown>;
        const missingMethods: RequiredMethodName[] = [];
        for (const name of REQUIRED_METHODS) {
            if (typeof tableRec[name] !== "function") {
                missingMethods.push(name);
            }
        }
        if (missingMethods.length > 0) {
            const label = missingMethods.length === 1 ? "API" : "APIs";
            recordFailure(
                context,
                "INV_TOKEN_TABLE",
                "missing required " + label + ": " + missingMethods.join(", ")
            );
            return resultOf(context.failures);
        }

        if (!Array.isArray(leaves)) {
            recordFailure(context, "INV_TOKEN_TABLE", "leaves must be an array");
            return resultOf(context.failures);
        }

        const expected = deriveExpectedTable(leaves);
        const n = leaves.length;
        // Reconstruct source once for rangeToSpan checks (O(n)).
        let source = "";
        for (let i = 0; i < n; i++) {
            source += leaves[i]!.raw;
        }

        const t = table as StructuralTokenTable;

        runMethodValidation(context, "leafCount", () => "leafCount", () => {
            const value = t.leafCount();
            validateExpectedNonNegInt(
                context,
                "leafCount",
                "leafCount",
                value,
                n,
                "INV_TOKEN_TABLE"
            );
        });

        runMethodValidation(context, "syntaxLeafCount", () => "syntaxLeafCount", () => {
            const value = t.syntaxLeafCount();
            validateExpectedNonNegInt(
                context,
                "syntaxLeafCount",
                "syntaxLeafCount",
                value,
                expected.syntaxIndexes.length,
                "INV_ORDINAL"
            );
        });

        runMethodValidation(context, "codeLeafCount", () => "codeLeafCount", () => {
            const value = t.codeLeafCount();
            validateExpectedNonNegInt(
                context,
                "codeLeafCount",
                "codeLeafCount",
                value,
                expected.codeIndexes.length,
                "INV_ORDINAL"
            );
        });

        // ---- Valid-domain O(n): getLeaf ----
        let getLeafIndex = -1;
        runMethodValidation(
            context,
            "getLeaf",
            () => "getLeaf(" + getLeafIndex + ")",
            () => {
                for (let i = 0; i < n; i++) {
                    getLeafIndex = i;
                    const got = t.getLeaf(i);
                    const exp = leaves[i]!;
                    if (!isObject(got) || !leavesEqual(got as SourceLeaf, exp)) {
                        tripMethod(
                            context,
                            "getLeaf",
                            "INV_TOKEN_TABLE",
                            "getLeaf(" + i + ") must return the canonical SourceLeaf"
                        );
                        return;
                    }
                }
            }
        );

        // ---- Valid-domain O(n): syntax ordinals, independently checked ----
        let syntaxForwardOrdinal = -1;
        runMethodValidation(
            context,
            "leafIndexOfSyntaxOrdinal",
            () => "leafIndexOfSyntaxOrdinal(" + syntaxForwardOrdinal + ")",
            () => {
                for (let ord = 0; ord < expected.syntaxIndexes.length; ord++) {
                    syntaxForwardOrdinal = ord;
                    const expIdx = expected.syntaxIndexes[ord]!;
                    const value = t.leafIndexOfSyntaxOrdinal(ord);
                    if (
                        !validateExpectedNonNegInt(
                            context,
                            "leafIndexOfSyntaxOrdinal",
                            "leafIndexOfSyntaxOrdinal(" + ord + ")",
                            value,
                            expIdx,
                            "INV_ORDINAL"
                        )
                    ) {
                        return;
                    }
                }
            }
        );

        let syntaxReverseIndex = -1;
        runMethodValidation(
            context,
            "syntaxOrdinalOfLeaf",
            () => "syntaxOrdinalOfLeaf(" + syntaxReverseIndex + ")",
            () => {
                for (let ord = 0; ord < expected.syntaxIndexes.length; ord++) {
                    const idx = expected.syntaxIndexes[ord]!;
                    syntaxReverseIndex = idx;
                    const value = t.syntaxOrdinalOfLeaf(idx);
                    if (
                        !validateExpectedNonNegInt(
                            context,
                            "syntaxOrdinalOfLeaf",
                            "syntaxOrdinalOfLeaf(" + idx + ")",
                            value,
                            ord,
                            "INV_ORDINAL"
                        )
                    ) {
                        return;
                    }
                }
            }
        );

        // ---- Valid-domain O(n): code ordinals, independently checked ----
        let codeForwardOrdinal = -1;
        runMethodValidation(
            context,
            "leafIndexOfCodeOrdinal",
            () => "leafIndexOfCodeOrdinal(" + codeForwardOrdinal + ")",
            () => {
                for (let ord = 0; ord < expected.codeIndexes.length; ord++) {
                    codeForwardOrdinal = ord;
                    const expIdx = expected.codeIndexes[ord]!;
                    const value = t.leafIndexOfCodeOrdinal(ord);
                    if (
                        !validateExpectedNonNegInt(
                            context,
                            "leafIndexOfCodeOrdinal",
                            "leafIndexOfCodeOrdinal(" + ord + ")",
                            value,
                            expIdx,
                            "INV_ORDINAL"
                        )
                    ) {
                        return;
                    }
                }
            }
        );

        let codeReverseIndex = -1;
        runMethodValidation(
            context,
            "codeOrdinalOfLeaf",
            () => "codeOrdinalOfLeaf(" + codeReverseIndex + ")",
            () => {
                for (let ord = 0; ord < expected.codeIndexes.length; ord++) {
                    const idx = expected.codeIndexes[ord]!;
                    codeReverseIndex = idx;
                    const value = t.codeOrdinalOfLeaf(idx);
                    if (
                        !validateExpectedNonNegInt(
                            context,
                            "codeOrdinalOfLeaf",
                            "codeOrdinalOfLeaf(" + idx + ")",
                            value,
                            ord,
                            "INV_ORDINAL"
                        )
                    ) {
                        return;
                    }
                }
            }
        );

        // ---- Valid-domain O(n): syntax / code adjacency, independently checked ----
        validateAdjacencyMethod(
            context,
            "previousSyntaxLeafIndex",
            expected.syntaxIndexes,
            expected.prevSyntax,
            (idx) => t.previousSyntaxLeafIndex(idx)
        );
        validateAdjacencyMethod(
            context,
            "nextSyntaxLeafIndex",
            expected.syntaxIndexes,
            expected.nextSyntax,
            (idx) => t.nextSyntaxLeafIndex(idx)
        );
        validateAdjacencyMethod(
            context,
            "previousCodeLeafIndex",
            expected.codeIndexes,
            expected.prevCode,
            (idx) => t.previousCodeLeafIndex(idx)
        );
        validateAdjacencyMethod(
            context,
            "nextCodeLeafIndex",
            expected.codeIndexes,
            expected.nextCode,
            (idx) => t.nextCodeLeafIndex(idx)
        );

        // ---- Valid-domain O(n): matching and depth, independently checked ----
        let matchingIndex = -1;
        runMethodValidation(
            context,
            "matchingDelimiterIndex",
            () => "matchingDelimiterIndex(" + matchingIndex + ")",
            () => {
                for (let i = 0; i < n; i++) {
                    matchingIndex = i;
                    const expMatch = expected.match[i] ?? null;
                    const value = t.matchingDelimiterIndex(i);
                    if (
                        !validateExpectedNullableIndex(
                            context,
                            "matchingDelimiterIndex",
                            "matchingDelimiterIndex(" + i + ")",
                            value,
                            expMatch,
                            "INV_DELIMITER_PAIR"
                        )
                    ) {
                        return;
                    }
                    if (value !== null) {
                        matchingIndex = value;
                        const back = t.matchingDelimiterIndex(value);
                        if (
                            !validateExpectedNullableIndex(
                                context,
                                "matchingDelimiterIndex",
                                "matchingDelimiterIndex(" + value + ")",
                                back,
                                i,
                                "INV_DELIMITER_PAIR"
                            )
                        ) {
                            return;
                        }
                    }
                }
            }
        );

        validateDepthMethod(
            context,
            "depthBefore",
            n,
            expected.depthBefore,
            (idx) => t.depthBefore(idx)
        );
        validateDepthMethod(
            context,
            "depthAfter",
            n,
            expected.depthAfter,
            (idx) => t.depthAfter(idx)
        );

        // ---- Collection and statement facts: one call per method ----
        validateStructuralIssuesCollection(context, t, expected.delimiterIssues, n);

        runMethodValidation(
            context,
            "statementBoundariesReliable",
            () => "statementBoundariesReliable",
            () => {
                const value = t.statementBoundariesReliable();
                if (typeof value !== "boolean") {
                    tripMethod(
                        context,
                        "statementBoundariesReliable",
                        "INV_TOKEN_TABLE",
                        "statementBoundariesReliable must return boolean, got " + typeof value
                    );
                    return;
                }
                if (value !== expected.boundariesReliable) {
                    tripMethod(
                        context,
                        "statementBoundariesReliable",
                        "INV_TOKEN_TABLE",
                        "statementBoundariesReliable expected " +
                            expected.boundariesReliable +
                            ", got " +
                            value
                    );
                }
            }
        );

        validateStatementRangesCollection(context, t, expected.statementRanges, n);

        // ---- rangeToSpan: O(n) sample set (full, single, empty, statement) ----
        let rangeLabel = "rangeToSpan";
        runMethodValidation(context, "rangeToSpan", () => rangeLabel, () => {
            const validateRange = (range: LeafRange, label: string): boolean => {
                const exp = rangeToSpan(leaves, source, range);
                if (exp === null) {
                    return true;
                }
                rangeLabel = label;
                const got = t.rangeToSpan(range);
                return validateExpectedSpan(context, "rangeToSpan", label, got, exp);
            };

            if (!validateRange({ start: 0, end: n }, "rangeToSpan(full)")) {
                return;
            }
            for (let i = 0; i < n; i++) {
                if (
                    !validateRange(
                        { start: i, end: i + 1 },
                        "rangeToSpan([" + i + "," + (i + 1) + "))"
                    )
                ) {
                    return;
                }
                if (
                    !validateRange(
                        { start: i, end: i },
                        "rangeToSpan([" + i + "," + i + "))"
                    )
                ) {
                    return;
                }
            }
            if (
                !validateRange(
                    { start: n, end: n },
                    "rangeToSpan([" + n + "," + n + "))"
                )
            ) {
                return;
            }
            for (const range of expected.statementRanges) {
                if (
                    !validateRange(
                        range,
                        "rangeToSpan(stmt [" + range.start + "," + range.end + "))"
                    )
                ) {
                    return;
                }
            }
        });

        // ---- normalizedWord valid-domain O(n) for code leaves ----
        let normalizedWordIndex = -1;
        runMethodValidation(
            context,
            "normalizedWord",
            () => "normalizedWord(" + normalizedWordIndex + ")",
            () => {
                for (const idx of expected.codeIndexes) {
                    normalizedWordIndex = idx;
                    const value = t.normalizedWord(idx);
                    const exp = canonicalNormalizedWord(leaves[idx]!);
                    if (value !== exp) {
                        tripMethod(
                            context,
                            "normalizedWord",
                            "INV_TOKEN_TABLE",
                            "normalizedWord(" +
                                idx +
                                ") expected " +
                                exp +
                                ", got " +
                                String(value)
                        );
                        return;
                    }
                }
            }
        );

        // ---- codeWordsEqual: streaming linear pairs (not all O(n^2)) ----
        let codeWordsPairLabel = "codeWordsEqual";
        runMethodValidation(context, "codeWordsEqual", () => codeWordsPairLabel, () => {
            const codes = expected.codeIndexes;
            const validatePair = (a: number, b: number): boolean => {
                codeWordsPairLabel = "codeWordsEqual(" + a + "," + b + ")";
                const got = t.codeWordsEqual(a, b);
                if (typeof got !== "boolean") {
                    tripMethod(
                        context,
                        "codeWordsEqual",
                        "INV_TOKEN_TABLE",
                        codeWordsPairLabel + " must return boolean"
                    );
                    return false;
                }
                const exp =
                    canonicalNormalizedWord(leaves[a]!) === canonicalNormalizedWord(leaves[b]!);
                if (got !== exp) {
                    tripMethod(
                        context,
                        "codeWordsEqual",
                        "INV_TOKEN_TABLE",
                        codeWordsPairLabel + " expected " + exp + ", got " + got
                    );
                    return false;
                }
                return true;
            };

            for (let i = 0; i < codes.length; i++) {
                const current = codes[i]!;
                if (!validatePair(current, current)) {
                    return;
                }
                if (i + 1 < codes.length && !validatePair(current, codes[i + 1]!)) {
                    return;
                }
            }
            if (
                codes.length >= 2 &&
                !validatePair(codes[0]!, codes[codes.length - 1]!)
            ) {
                return;
            }
        });

        // ---- Fixed O(1) representative illegal-input probes ----
        sampleIllegalInputRejections(context, t, leaves, expected, n);
    } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        recordFailure(context, "INV_TOKEN_TABLE", "Token table invariant aborted: " + message);
    }

    return resultOf(context.failures);
}

function createValidationContext(): TokenValidationContext {
    return {
        failures: [],
        invalidMethods: new Set<RequiredMethodName>(),
        halted: false,
    };
}

function recordFailure(
    context: TokenValidationContext,
    code: InvariantFailureCode,
    message: string
): void {
    if (context.halted) {
        return;
    }
    if (context.failures.length < MAX_TOKEN_TABLE_FAILURES - 1) {
        fail(context.failures, code, message);
        return;
    }
    fail(
        context.failures,
        "INV_TOKEN_TABLE",
        "token table invariant failure limit " +
            MAX_TOKEN_TABLE_FAILURES +
            " reached; further failures and checks were truncated"
    );
    context.halted = true;
}

function isMethodHealthy(
    context: TokenValidationContext,
    name: RequiredMethodName
): boolean {
    return !context.halted && !context.invalidMethods.has(name);
}

function tripMethod(
    context: TokenValidationContext,
    name: RequiredMethodName,
    code: InvariantFailureCode,
    message: string
): void {
    if (context.invalidMethods.has(name)) {
        return;
    }
    context.invalidMethods.add(name);
    recordFailure(context, code, message);
}

function runMethodValidation(
    context: TokenValidationContext,
    name: RequiredMethodName,
    describeCurrentCall: () => string,
    validate: () => void
): void {
    if (!isMethodHealthy(context, name)) {
        return;
    }
    try {
        validate();
    } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        tripMethod(
            context,
            name,
            "INV_TOKEN_TABLE",
            describeCurrentCall() + " threw: " + message
        );
    }
}

function validateExpectedNonNegInt(
    context: TokenValidationContext,
    method: RequiredMethodName,
    label: string,
    value: unknown,
    expected: number,
    mismatchCode: InvariantFailureCode
): boolean {
    if (!isFiniteNonNegInt(value)) {
        tripMethod(
            context,
            method,
            "INV_TOKEN_TABLE",
            label + " must return a non-negative integer, got " + String(value)
        );
        return false;
    }
    if (value !== expected) {
        tripMethod(
            context,
            method,
            mismatchCode,
            label + " expected " + expected + ", got " + value
        );
        return false;
    }
    return true;
}

function validateExpectedNullableIndex(
    context: TokenValidationContext,
    method: RequiredMethodName,
    label: string,
    value: unknown,
    expected: number | null,
    mismatchCode: InvariantFailureCode
): value is number | null {
    if (value !== null && !isFiniteNonNegInt(value)) {
        tripMethod(
            context,
            method,
            "INV_TOKEN_TABLE",
            label + " must return a non-negative integer or null, got " + String(value)
        );
        return false;
    }
    if (value !== expected) {
        tripMethod(
            context,
            method,
            mismatchCode,
            label + " expected " + expected + ", got " + String(value)
        );
        return false;
    }
    return true;
}

function validateExpectedSpan(
    context: TokenValidationContext,
    method: RequiredMethodName,
    label: string,
    value: unknown,
    expected: SourceSpan
): boolean {
    if (!isSourceSpan(value)) {
        tripMethod(
            context,
            method,
            "INV_TOKEN_TABLE",
            label + " must return a SourceSpan"
        );
        return false;
    }
    if (value.start !== expected.start || value.end !== expected.end) {
        tripMethod(
            context,
            method,
            "INV_TOKEN_TABLE",
            label +
                " expected span [" +
                expected.start +
                "," +
                expected.end +
                "), got [" +
                value.start +
                "," +
                value.end +
                ")"
        );
        return false;
    }
    return true;
}

function validateAdjacencyMethod(
    context: TokenValidationContext,
    method: "previousSyntaxLeafIndex" | "nextSyntaxLeafIndex" | "previousCodeLeafIndex" | "nextCodeLeafIndex",
    indexes: readonly number[],
    expectedValues: readonly (number | null)[],
    lookup: (index: number) => number | null
): void {
    let currentIndex = -1;
    runMethodValidation(context, method, () => method + "(" + currentIndex + ")", () => {
        for (const idx of indexes) {
            currentIndex = idx;
            const value = lookup(idx);
            const expected = expectedValues[idx] ?? null;
            if (
                !validateExpectedNullableIndex(
                    context,
                    method,
                    method + "(" + idx + ")",
                    value,
                    expected,
                    "INV_ADJACENCY"
                )
            ) {
                return;
            }
        }
    });
}

function validateDepthMethod(
    context: TokenValidationContext,
    method: "depthBefore" | "depthAfter",
    leafCount: number,
    expectedValues: readonly number[],
    lookup: (index: number) => number
): void {
    let currentIndex = -1;
    runMethodValidation(context, method, () => method + "(" + currentIndex + ")", () => {
        for (let i = 0; i < leafCount; i++) {
            currentIndex = i;
            const value = lookup(i);
            if (
                !validateExpectedNonNegInt(
                    context,
                    method,
                    method + "(" + i + ")",
                    value,
                    expectedValues[i]!,
                    "INV_DEPTH_CONSISTENCY"
                )
            ) {
                return;
            }
        }
    });
}

function validateStructuralIssuesCollection(
    context: TokenValidationContext,
    t: StructuralTokenTable,
    expected: readonly { code: string; leafIndex: number }[],
    leafCount: number
): void {
    runMethodValidation(context, "structuralIssues", () => "structuralIssues", () => {
        const value: unknown = t.structuralIssues();
        if (!Array.isArray(value)) {
            tripMethod(
                context,
                "structuralIssues",
                "INV_TOKEN_TABLE",
                "structuralIssues must return an array"
            );
            return;
        }
        if (value.length !== expected.length) {
            tripMethod(
                context,
                "structuralIssues",
                "INV_DELIMITER_PAIR",
                "structuralIssues length " +
                    value.length +
                    " !== expected " +
                    expected.length
            );
            return;
        }
        if (!isDenseArray(value)) {
            tripMethod(
                context,
                "structuralIssues",
                "INV_TOKEN_TABLE",
                "structuralIssues must be a dense array without holes"
            );
            return;
        }
        if (!Object.isFrozen(value)) {
            tripMethod(
                context,
                "structuralIssues",
                "INV_TOKEN_TABLE",
                "structuralIssues must return a frozen array"
            );
            return;
        }

        const seenKeys = new Set<string>();
        for (let i = 0; i < expected.length; i++) {
            const got = value[i];
            const exp = expected[i]!;
            if (got === undefined || got === null) {
                tripMethod(
                    context,
                    "structuralIssues",
                    "INV_TOKEN_TABLE",
                    "structuralIssues[" +
                        i +
                        "] must be a non-null object, got " +
                        String(got)
                );
                return;
            }
            if (!isObject(got)) {
                tripMethod(
                    context,
                    "structuralIssues",
                    "INV_TOKEN_TABLE",
                    "structuralIssues[" + i + "] must be an object"
                );
                return;
            }
            if (!isFiniteNonNegInt(got.leafIndex)) {
                tripMethod(
                    context,
                    "structuralIssues",
                    "INV_TOKEN_TABLE",
                    "structural issue leafIndex invalid at " + i
                );
                return;
            }
            if (got.leafIndex >= leafCount && !(leafCount === 0 && got.leafIndex === 0)) {
                tripMethod(
                    context,
                    "structuralIssues",
                    "INV_TOKEN_TABLE",
                    "structural issue leafIndex out of bounds: " + got.leafIndex
                );
                return;
            }
            if (
                typeof got.code !== "string" ||
                got.code.length === 0 ||
                !STRUCT_ISSUE_CODES.has(got.code)
            ) {
                tripMethod(
                    context,
                    "structuralIssues",
                    "INV_TOKEN_TABLE",
                    "structural issue code invalid at " + i
                );
                return;
            }
            if (typeof got.message !== "string" || got.message.length === 0) {
                tripMethod(
                    context,
                    "structuralIssues",
                    "INV_TOKEN_TABLE",
                    "structural issue message must be non-empty string at " + i
                );
                return;
            }
            const key = got.code + "@" + got.leafIndex;
            if (seenKeys.has(key)) {
                tripMethod(
                    context,
                    "structuralIssues",
                    "INV_DELIMITER_PAIR",
                    "duplicate structural issue " + key
                );
                return;
            }
            seenKeys.add(key);
            if (got.code !== exp.code || got.leafIndex !== exp.leafIndex) {
                tripMethod(
                    context,
                    "structuralIssues",
                    "INV_DELIMITER_PAIR",
                    "structuralIssues[" +
                        i +
                        "] expected " +
                        exp.code +
                        "@" +
                        exp.leafIndex +
                        ", got " +
                        got.code +
                        "@" +
                        got.leafIndex
                );
                return;
            }
        }
    });
}

function validateStatementRangesCollection(
    context: TokenValidationContext,
    t: StructuralTokenTable,
    expected: readonly LeafRange[],
    leafCount: number
): void {
    runMethodValidation(context, "statementRanges", () => "statementRanges", () => {
        const value: unknown = t.statementRanges();
        if (!Array.isArray(value)) {
            tripMethod(
                context,
                "statementRanges",
                "INV_STATEMENT_RANGES",
                "statementRanges must return an array"
            );
            return;
        }
        if (value.length !== expected.length) {
            tripMethod(
                context,
                "statementRanges",
                "INV_STATEMENT_RANGES",
                "statementRanges length " +
                    value.length +
                    " !== expected " +
                    expected.length
            );
            return;
        }
        if (!isDenseArray(value)) {
            tripMethod(
                context,
                "statementRanges",
                "INV_STATEMENT_RANGES",
                "statementRanges must be a dense array without holes"
            );
            return;
        }
        if (!Object.isFrozen(value)) {
            tripMethod(
                context,
                "statementRanges",
                "INV_TOKEN_TABLE",
                "statementRanges must return a frozen array"
            );
            return;
        }

        let previous: LeafRange | null = null;
        for (let i = 0; i < expected.length; i++) {
            const range = value[i];
            const exp = expected[i]!;
            if (range === undefined || range === null) {
                tripMethod(
                    context,
                    "statementRanges",
                    "INV_STATEMENT_RANGES",
                    "statementRanges[" +
                        i +
                        "] must be a non-null LeafRange, got " +
                        String(range)
                );
                return;
            }
            if (!isLeafRange(range) || range.end > leafCount) {
                tripMethod(
                    context,
                    "statementRanges",
                    "INV_STATEMENT_RANGES",
                    "statement range " + i + " is out of bounds"
                );
                return;
            }
            if (range.start !== exp.start || range.end !== exp.end) {
                tripMethod(
                    context,
                    "statementRanges",
                    "INV_STATEMENT_RANGES",
                    "statement range " +
                        i +
                        " expected [" +
                        exp.start +
                        "," +
                        exp.end +
                        "), got [" +
                        range.start +
                        "," +
                        range.end +
                        ")"
                );
                return;
            }
            if (previous !== null && range.start < previous.end) {
                tripMethod(
                    context,
                    "statementRanges",
                    "INV_STATEMENT_RANGES",
                    "statement ranges overlap or are out of order at " + i
                );
                return;
            }
            previous = range;
        }
    });
}

/**
 * Fixed number of illegal-input probes (O(1) / fixed channel samples).
 * Does not iterate every trivia/protected leaf. Each probe is gated by the
 * corresponding method circuit; a valid-domain failure prevents misuse calls.
 */
function sampleIllegalInputRejections(
    context: TokenValidationContext,
    t: StructuralTokenTable,
    leaves: readonly SourceLeaf[],
    expected: ReturnType<typeof deriveExpectedTable>,
    n: number
): void {
    if (context.halted) {
        return;
    }

    // Index OOB / non-integer representatives
    expectMethodRejects(context, "getLeaf", "getLeaf(-1)", () => t.getLeaf(-1));
    expectMethodRejects(context, "getLeaf", "getLeaf(1.5)", () =>
        t.getLeaf(1.5 as unknown as number)
    );
    expectMethodRejects(context, "getLeaf", "getLeaf(" + n + ")", () => t.getLeaf(n));

    expectMethodRejects(
        context,
        "leafIndexOfSyntaxOrdinal",
        "leafIndexOfSyntaxOrdinal(-1)",
        () => t.leafIndexOfSyntaxOrdinal(-1)
    );
    expectMethodRejects(
        context,
        "leafIndexOfSyntaxOrdinal",
        "leafIndexOfSyntaxOrdinal(count)",
        () => t.leafIndexOfSyntaxOrdinal(expected.syntaxIndexes.length)
    );
    expectMethodRejects(
        context,
        "leafIndexOfSyntaxOrdinal",
        "leafIndexOfSyntaxOrdinal(1.5)",
        () => t.leafIndexOfSyntaxOrdinal(1.5 as unknown as number)
    );
    expectMethodRejects(
        context,
        "syntaxOrdinalOfLeaf",
        "syntaxOrdinalOfLeaf(1.5)",
        () => t.syntaxOrdinalOfLeaf(1.5 as unknown as number)
    );

    expectMethodRejects(
        context,
        "leafIndexOfCodeOrdinal",
        "leafIndexOfCodeOrdinal(-1)",
        () => t.leafIndexOfCodeOrdinal(-1)
    );
    expectMethodRejects(
        context,
        "leafIndexOfCodeOrdinal",
        "leafIndexOfCodeOrdinal(count)",
        () => t.leafIndexOfCodeOrdinal(expected.codeIndexes.length)
    );
    expectMethodRejects(
        context,
        "leafIndexOfCodeOrdinal",
        "leafIndexOfCodeOrdinal(1.5)",
        () => t.leafIndexOfCodeOrdinal(1.5 as unknown as number)
    );
    expectMethodRejects(
        context,
        "codeOrdinalOfLeaf",
        "codeOrdinalOfLeaf(1.5)",
        () => t.codeOrdinalOfLeaf(1.5 as unknown as number)
    );

    expectMethodRejects(context, "depthBefore", "depthBefore(-1)", () => t.depthBefore(-1));
    expectMethodRejects(context, "depthBefore", "depthBefore(" + n + ")", () =>
        t.depthBefore(n)
    );
    expectMethodRejects(context, "depthBefore", "depthBefore(1.5)", () =>
        t.depthBefore(1.5 as unknown as number)
    );
    expectMethodRejects(context, "depthAfter", "depthAfter(-1)", () => t.depthAfter(-1));
    expectMethodRejects(context, "depthAfter", "depthAfter(" + n + ")", () => t.depthAfter(n));
    expectMethodRejects(context, "depthAfter", "depthAfter(1.5)", () =>
        t.depthAfter(1.5 as unknown as number)
    );
    expectMethodRejects(
        context,
        "matchingDelimiterIndex",
        "matchingDelimiterIndex(-1)",
        () => t.matchingDelimiterIndex(-1)
    );
    expectMethodRejects(
        context,
        "matchingDelimiterIndex",
        "matchingDelimiterIndex(" + n + ")",
        () => t.matchingDelimiterIndex(n)
    );
    expectMethodRejects(
        context,
        "matchingDelimiterIndex",
        "matchingDelimiterIndex(1.5)",
        () => t.matchingDelimiterIndex(1.5 as unknown as number)
    );

    expectMethodRejects(
        context,
        "previousSyntaxLeafIndex",
        "previousSyntaxLeafIndex(-1)",
        () => t.previousSyntaxLeafIndex(-1)
    );
    expectMethodRejects(
        context,
        "previousSyntaxLeafIndex",
        "previousSyntaxLeafIndex(" + n + ")",
        () => t.previousSyntaxLeafIndex(n)
    );
    expectMethodRejects(
        context,
        "previousSyntaxLeafIndex",
        "previousSyntaxLeafIndex(1.5)",
        () => t.previousSyntaxLeafIndex(1.5 as unknown as number)
    );
    expectMethodRejects(
        context,
        "nextSyntaxLeafIndex",
        "nextSyntaxLeafIndex(1.5)",
        () => t.nextSyntaxLeafIndex(1.5 as unknown as number)
    );
    expectMethodRejects(
        context,
        "previousCodeLeafIndex",
        "previousCodeLeafIndex(1.5)",
        () => t.previousCodeLeafIndex(1.5 as unknown as number)
    );
    expectMethodRejects(
        context,
        "nextCodeLeafIndex",
        "nextCodeLeafIndex(1.5)",
        () => t.nextCodeLeafIndex(1.5 as unknown as number)
    );

    expectMethodRejects(context, "rangeToSpan", "rangeToSpan(negative)", () =>
        t.rangeToSpan({ start: -1, end: 0 })
    );
    expectMethodRejects(context, "rangeToSpan", "rangeToSpan(reversed)", () =>
        t.rangeToSpan({ start: 1, end: 0 })
    );
    expectMethodRejects(context, "rangeToSpan", "rangeToSpan(fractional-start)", () =>
        t.rangeToSpan({ start: 0.5, end: 1 })
    );
    expectMethodRejects(context, "rangeToSpan", "rangeToSpan(fractional-end)", () =>
        t.rangeToSpan({ start: 0, end: 0.5 })
    );
    expectMethodRejects(context, "rangeToSpan", "rangeToSpan(end>leafCount)", () =>
        t.rangeToSpan({ start: 0, end: n + 1 })
    );

    expectMethodRejects(context, "normalizedWord", "normalizedWord(-1)", () =>
        t.normalizedWord(-1)
    );
    expectMethodRejects(
        context,
        "normalizedWord",
        "normalizedWord(" + n + ")",
        () => t.normalizedWord(n)
    );
    expectMethodRejects(context, "normalizedWord", "normalizedWord(1.5)", () =>
        t.normalizedWord(1.5 as unknown as number)
    );

    if (context.halted) {
        return;
    }

    // One trivia + one protected representative (not every leaf)
    let triviaIdx = -1;
    let protectedIdx = -1;
    for (let i = 0; i < n; i++) {
        const channel = leaves[i]!.channel;
        if (triviaIdx < 0 && channel === "trivia") {
            triviaIdx = i;
        }
        if (protectedIdx < 0 && channel === "protected") {
            protectedIdx = i;
        }
        if (triviaIdx >= 0 && protectedIdx >= 0) {
            break;
        }
    }
    if (triviaIdx >= 0) {
        expectMethodRejects(
            context,
            "syntaxOrdinalOfLeaf",
            "syntaxOrdinalOfLeaf(trivia " + triviaIdx + ")",
            () => t.syntaxOrdinalOfLeaf(triviaIdx)
        );
        expectMethodRejects(
            context,
            "codeOrdinalOfLeaf",
            "codeOrdinalOfLeaf(trivia " + triviaIdx + ")",
            () => t.codeOrdinalOfLeaf(triviaIdx)
        );
        expectMethodRejects(
            context,
            "previousSyntaxLeafIndex",
            "previousSyntaxLeafIndex(trivia " + triviaIdx + ")",
            () => t.previousSyntaxLeafIndex(triviaIdx)
        );
        expectMethodRejects(
            context,
            "normalizedWord",
            "normalizedWord(trivia " + triviaIdx + ")",
            () => t.normalizedWord(triviaIdx)
        );
        if (expected.codeIndexes.length > 0) {
            const peer = expected.codeIndexes[0]!;
            expectMethodRejects(
                context,
                "codeWordsEqual",
                "codeWordsEqual(trivia " + triviaIdx + ", code)",
                () => t.codeWordsEqual(triviaIdx, peer)
            );
            expectMethodRejects(
                context,
                "codeWordsEqual",
                "codeWordsEqual(code, trivia " + triviaIdx + ")",
                () => t.codeWordsEqual(peer, triviaIdx)
            );
        } else {
            expectMethodRejects(
                context,
                "codeWordsEqual",
                "codeWordsEqual(trivia " + triviaIdx + ", trivia)",
                () => t.codeWordsEqual(triviaIdx, triviaIdx)
            );
        }
    }
    if (protectedIdx >= 0) {
        expectMethodRejects(
            context,
            "codeOrdinalOfLeaf",
            "codeOrdinalOfLeaf(protected " + protectedIdx + ")",
            () => t.codeOrdinalOfLeaf(protectedIdx)
        );
        expectMethodRejects(
            context,
            "previousCodeLeafIndex",
            "previousCodeLeafIndex(protected " + protectedIdx + ")",
            () => t.previousCodeLeafIndex(protectedIdx)
        );
        expectMethodRejects(
            context,
            "normalizedWord",
            "normalizedWord(protected " + protectedIdx + ")",
            () => t.normalizedWord(protectedIdx)
        );
        if (expected.codeIndexes.length > 0) {
            const peer = expected.codeIndexes[0]!;
            expectMethodRejects(
                context,
                "codeWordsEqual",
                "codeWordsEqual(protected " + protectedIdx + ", code)",
                () => t.codeWordsEqual(protectedIdx, peer)
            );
            expectMethodRejects(
                context,
                "codeWordsEqual",
                "codeWordsEqual(code, protected " + protectedIdx + ")",
                () => t.codeWordsEqual(peer, protectedIdx)
            );
        } else {
            expectMethodRejects(
                context,
                "codeWordsEqual",
                "codeWordsEqual(protected " + protectedIdx + ", self)",
                () => t.codeWordsEqual(protectedIdx, protectedIdx)
            );
        }
    }

    if (expected.codeIndexes.length === 0) {
        expectMethodRejects(context, "codeWordsEqual", "codeWordsEqual(0,0) empty-code", () =>
            t.codeWordsEqual(0, 0)
        );
        expectMethodRejects(context, "codeWordsEqual", "codeWordsEqual(-1,0) empty-code", () =>
            t.codeWordsEqual(-1, 0)
        );
        expectMethodRejects(
            context,
            "codeWordsEqual",
            "codeWordsEqual(1.5,0) empty-code",
            () => t.codeWordsEqual(1.5 as unknown as number, 0)
        );
    } else {
        const peer = expected.codeIndexes[0]!;
        expectMethodRejects(context, "codeWordsEqual", "codeWordsEqual(-1, peer)", () =>
            t.codeWordsEqual(-1, peer)
        );
        expectMethodRejects(
            context,
            "codeWordsEqual",
            "codeWordsEqual(" + n + ", peer)",
            () => t.codeWordsEqual(n, peer)
        );
        expectMethodRejects(context, "codeWordsEqual", "codeWordsEqual(1.5, peer)", () =>
            t.codeWordsEqual(1.5 as unknown as number, peer)
        );
        expectMethodRejects(context, "codeWordsEqual", "codeWordsEqual(peer, 1.5)", () =>
            t.codeWordsEqual(peer, 1.5 as unknown as number)
        );
    }

    if (context.halted) {
        return;
    }

    // Second non-code representative when distinct from first trivia/protected
    let secondNonCode = -1;
    for (let i = 0; i < n; i++) {
        if (isStructuralCodeLeaf(leaves[i]!)) {
            continue;
        }
        if (i !== triviaIdx && i !== protectedIdx) {
            secondNonCode = i;
            break;
        }
    }
    if (secondNonCode >= 0 && expected.codeIndexes.length > 0) {
        const peer = expected.codeIndexes[0]!;
        expectMethodRejects(
            context,
            "codeWordsEqual",
            "codeWordsEqual(second-noncode " + secondNonCode + ", code)",
            () => t.codeWordsEqual(secondNonCode, peer)
        );
        expectMethodRejects(
            context,
            "codeWordsEqual",
            "codeWordsEqual(code, second-noncode " + secondNonCode + ")",
            () => t.codeWordsEqual(peer, secondNonCode)
        );
        expectMethodRejects(
            context,
            "codeOrdinalOfLeaf",
            "codeOrdinalOfLeaf(second-noncode " + secondNonCode + ")",
            () => t.codeOrdinalOfLeaf(secondNonCode)
        );
    }
}

function expectMethodRejects(
    context: TokenValidationContext,
    method: RequiredMethodName,
    label: string,
    call: () => unknown
): void {
    if (!isMethodHealthy(context, method)) {
        return;
    }
    try {
        call();
        tripMethod(
            context,
            method,
            "INV_TOKEN_TABLE",
            label + " must reject illegal input"
        );
    } catch {
        // Expected rejection keeps the method healthy for the next fixed probe.
    }
}
