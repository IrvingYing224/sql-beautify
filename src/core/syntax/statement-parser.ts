import type {
    CapabilityIdentity,
    RecoveryAction,
} from "../diagnostics/diagnostic";
import { isParserStructuredCapabilityState } from "../dialects/capability-state";
import { getDialect } from "../dialects/registry";
import type { LeafRange } from "./leaf-range";
import type { QueryNode, StatementNode } from "./node";
import {
    ParserSyntaxError,
    addDiagnostic,
    isCodeWord,
    isSyntaxLeaf,
    lastSyntaxIndex,
    nextSyntaxIndex,
    nodeFacts,
    syntaxMarkers,
    trimToSyntax,
} from "./parser-context";
import type { ParserContext, SyntaxDiagnosticCode } from "./parser-context";
import { parseInsertQueryRange, parseQueryRange } from "./query-parser";
import {
    createOpaqueWithDiagnostic,
    createParserCheckpoint,
    rollbackParserCheckpoint,
} from "./recovery";
import { classifyUnsupportedStatementStart } from "./unsupported-recognizer";

function statementRecovery(
    context: ParserContext
): "preserve-statement" | "preserve-target" {
    return context.mode === "fragment" ? "preserve-target" : "preserve-statement";
}

function statementFacts(context: ParserContext, range: LeafRange) {
    const last = lastSyntaxIndex(context.leaves, range);
    const terminator =
        last !== null && context.leaves[last]!.channel === "code" &&
        context.leaves[last]!.raw === ";"
            ? syntaxMarkers([last], "statement-terminator", "punctuation", false)
            : [];
    return nodeFacts(null, "intrinsic-container", terminator);
}

function setStatementFacts(setLeafId: number) {
    return nodeFacts(
        "set-command",
        "capability",
        syntaxMarkers([setLeafId], "set:head")
    );
}

function setPayloadEnd(context: ParserContext, range: LeafRange): number {
    const last = lastSyntaxIndex(context.leaves, range);
    return last !== null &&
        context.leaves[last]!.channel === "code" &&
        context.leaves[last]!.raw === ";"
        ? last
        : range.end;
}

function validateSetKey(
    context: ParserContext,
    range: LeafRange
): void {
    const first = context.leaves[range.start]!;
    if (first.kind !== "identifier" && first.kind !== "keyword") {
        throw new ParserSyntaxError(
            "SYN_UNEXPECTED_TOKEN",
            range,
            "SET key must start with an unquoted word",
            "statement"
        );
    }
    let expectWord = true;
    for (let leafId = range.start; leafId < range.end; leafId++) {
        const leaf = context.leaves[leafId]!;
        const word = leaf.channel === "code" &&
            (leaf.kind === "identifier" ||
                leaf.kind === "keyword" ||
                (leaf.kind === "number" && leafId > range.start));
        const separator = leaf.channel === "code" &&
            (leaf.raw === "." || leaf.raw === ":");
        if ((expectWord && !word) || (!expectWord && !separator)) {
            throw new ParserSyntaxError(
                "SYN_UNEXPECTED_TOKEN",
                range,
                "SET key must be a dotted or namespaced configuration key",
                "statement"
            );
        }
        expectWord = !expectWord;
    }
    if (expectWord) {
        throw new ParserSyntaxError(
            "SYN_UNEXPECTED_TOKEN",
            range,
            "SET key must not end with a separator",
            "statement"
        );
    }
}

function parseSetStatementRange(
    context: ParserContext,
    statementRange: LeafRange,
    bodyRange: LeafRange
): StatementNode {
    const capability = getDialect(context.dialect).getCapability("set-command");
    if (!isParserStructuredCapabilityState(capability?.state)) {
        throw new ParserSyntaxError(
            "SYN_UNSUPPORTED_STATEMENT",
            bodyRange,
            `${context.dialect} does not declare Hive SET command syntax`
        );
    }
    const setLeafId = bodyRange.start;
    const payloadStart = nextSyntaxIndex(context, setLeafId, bodyRange.end);
    const commandEnd = setPayloadEnd(context, statementRange);
    if (payloadStart === null) {
        const command = context.factory.createSetStatement(
            { start: setLeafId, end: commandEnd },
            null,
            setStatementFacts(setLeafId)
        );
        return context.factory.createStatement(
            statementRange,
            "set",
            command,
            statementFacts(context, statementRange)
        );
    }
    const payloadEnd = commandEnd;
    let assignmentLeafId: number | null = null;
    let current: number | null = payloadStart;
    while (current !== null && current < payloadEnd) {
        const leaf = context.leaves[current]!;
        if (leaf.channel === "code" && leaf.raw === "=") {
            assignmentLeafId = current;
            break;
        }
        current = nextSyntaxIndex(context, current, payloadEnd);
    }
    const keyRange = trimToSyntax(context.leaves, {
        start: payloadStart,
        end: assignmentLeafId ?? payloadEnd,
    });
    if (keyRange === null) {
        throw new ParserSyntaxError(
            "SYN_INCOMPLETE_CLAUSE",
            { start: payloadStart, end: payloadEnd },
            "SET requires a key before assignment",
            "statement"
        );
    }
    validateSetKey(context, keyRange);
    const valueSyntaxRange = assignmentLeafId === null
        ? null
        : trimToSyntax(context.leaves, {
              start: assignmentLeafId + 1,
              end: payloadEnd,
          });
    if (assignmentLeafId !== null && valueSyntaxRange === null) {
        throw new ParserSyntaxError(
            "SYN_INCOMPLETE_CLAUSE",
            { start: assignmentLeafId, end: payloadEnd },
            "SET assignment requires a value",
            "statement"
        );
    }
    const valueRange = assignmentLeafId === null
        ? null
        : Object.freeze({ start: assignmentLeafId + 1, end: payloadEnd });
    const payload = context.factory.createSetPayload(
        { start: keyRange.start, end: payloadEnd },
        keyRange,
        assignmentLeafId,
        valueRange,
        nodeFacts(null, "intrinsic-container")
    );
    const command = context.factory.createSetStatement(
        { start: setLeafId, end: payloadEnd },
        payload,
        setStatementFacts(setLeafId)
    );
    return context.factory.createStatement(
        statementRange,
        "set",
        command,
        statementFacts(context, statementRange)
    );
}

function representsInsertQuery(query: QueryNode): boolean {
    const first = query.children[0];
    if (first?.kind === "clause" && first.clauseKind === "insert") {
        return true;
    }
    if (
        first?.kind === "clause" &&
        first.clauseKind === "with" &&
        query.children[1]?.kind === "query"
    ) {
        return representsInsertQuery(query.children[1]);
    }
    if (query.queryKind === "set" && first?.kind === "query") {
        return representsInsertQuery(first);
    }
    return false;
}

export function isEmptyStatementRange(context: ParserContext, range: LeafRange): boolean {
    let hasSemicolon = false;
    for (let i = range.start; i < range.end; i++) {
        const leaf = context.leaves[i]!;
        if (!isSyntaxLeaf(leaf)) {
            continue;
        }
        if (leaf.channel === "code" && leaf.raw === ";") {
            hasSemicolon = true;
            continue;
        }
        return false;
    }
    return hasSemicolon;
}

function queryBodyRange(context: ParserContext, statementRange: LeafRange): LeafRange | null {
    const trimmed = trimToSyntax(context.leaves, statementRange);
    if (trimmed === null) {
        return null;
    }
    const last = context.leaves[trimmed.end - 1]!;
    if (last.channel === "code" && last.raw === ";") {
        return trimToSyntax(context.leaves, {
            start: trimmed.start,
            end: trimmed.end - 1,
        });
    }
    return trimmed;
}

export function createOpaqueStatement(
    context: ParserContext,
    range: LeafRange,
    code: SyntaxDiagnosticCode,
    message: string,
    recovery: Extract<RecoveryAction, "verbatim-node" | "preserve-statement" | "preserve-target">,
    capabilityId: CapabilityIdentity = null
): StatementNode {
    if (isEmptyStatementRange(context, range)) {
        return context.factory.createStatement(range, "empty", null, statementFacts(context, range));
    }
    const opaque = createOpaqueWithDiagnostic(
        context,
        range,
        code,
        recovery === "preserve-target" ? "target" : "statement",
        message,
        recovery,
        capabilityId
    );
    return context.factory.createStatement(
        range,
        "opaque",
        opaque,
        nodeFacts(null, "intrinsic-container")
    );
}

export function parseStatementRange(
    context: ParserContext,
    range: LeafRange
): StatementNode {
    if (isEmptyStatementRange(context, range)) {
        return context.factory.createStatement(range, "empty", null, statementFacts(context, range));
    }
    const bodyRange = queryBodyRange(context, range);
    if (bodyRange === null) {
        return createOpaqueStatement(
            context,
            range,
            "SYN_UNSUPPORTED_STATEMENT",
            "Statement contains no parseable query target",
            statementRecovery(context)
        );
    }
    const startsSelect = isCodeWord(context, bodyRange.start, "select");
    const startsWith = isCodeWord(context, bodyRange.start, "with");
    const startsInsert = isCodeWord(context, bodyRange.start, "insert");
    const startsSet = isCodeWord(context, bodyRange.start, "set");
    const startsParenthesized =
        context.leaves[bodyRange.start]!.channel === "code" &&
        context.leaves[bodyRange.start]!.raw === "(";
    const unsupported = classifyUnsupportedStatementStart(context, bodyRange);
    if (unsupported?.state === "verbatim") {
        return createOpaqueStatement(
            context,
            range,
            "SYN_UNSUPPORTED_STATEMENT",
            `${context.dialect} ${unsupported.signature.capabilityId} statement is preserved verbatim`,
            "verbatim-node",
            unsupported.signature.capabilityId
        );
    }
    if (
        !startsSelect &&
        !startsWith &&
        !startsParenthesized &&
        !startsInsert &&
        !startsSet &&
        unsupported === null
    ) {
        return createOpaqueStatement(
            context,
            range,
            "SYN_UNSUPPORTED_STATEMENT",
            `${context.dialect} statement ${context.leaves[bodyRange.start]!.raw} is not structured`,
            statementRecovery(context)
        );
    }

    const checkpoint = createParserCheckpoint(context);
    try {
        if (unsupported?.state === "diagnostic") {
            throw new ParserSyntaxError(
                "SYN_UNSUPPORTED_STATEMENT",
                bodyRange,
                `${context.dialect} ${unsupported.signature.capabilityId} statement is recognized but not structured`,
                "statement",
                unsupported.signature.capabilityId
            );
        }
        if (startsSet) {
            return parseSetStatementRange(context, range, bodyRange);
        }
        const query = startsInsert
            ? parseInsertQueryRange(context, bodyRange)
            : parseQueryRange(context, bodyRange);
        return context.factory.createStatement(
            range,
            startsInsert || representsInsertQuery(query) ? "insert-query" : "query",
            query,
            statementFacts(context, range)
        );
    } catch (error) {
        rollbackParserCheckpoint(context, checkpoint);
        if (!(error instanceof ParserSyntaxError)) {
            throw error;
        }
        const statement = createOpaqueStatement(
            context,
            range,
            error.code,
            `Statement preserved: ${error.message}`,
            context.mode === "fragment" ? "preserve-target" : "preserve-statement",
            error.capabilityId
        );
        if (
            error.range.start !== range.start ||
            error.range.end !== range.end
        ) {
            addDiagnostic(
                context,
                error.code,
                error.range,
                error.message,
                context.mode === "fragment" ? "preserve-target" : "preserve-statement",
                "warning",
                error.capabilityId
            );
        }
        return statement;
    }
}
