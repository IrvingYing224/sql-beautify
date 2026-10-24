import type { LeafRange } from "./leaf-range";
import { nextSyntaxIndex } from "./parser-context";
import type { ParserContext } from "./parser-context";

/**
 * Statement-head table (plan §5.3). Each pattern lists positions; a position is `a|b`
 * alternatives, `[…]` marks an optional run of positions. Matching is case-insensitive over
 * complete code words at the real statement start, and the longest matching pattern wins.
 */
interface HeadEntry {
    readonly pattern: string;
    /** The generic layer applies keyword case to the matched head words. */
    readonly keywordCase: boolean;
    /** Everything after the head, up to the statement's `;`, is a verbatim command payload. */
    readonly payload: boolean;
}

const HEAD_ENTRIES: readonly HeadEntry[] = [
    ...[
        "use",
        "show databases|schemas|tables|views|partitions|functions|columns|tblproperties",
        "show create table",
        "describe|desc [formatted|extended] [database|function]",
        "msck [repair] table",
        "analyze table",
        "load data [local] inpath",
        "truncate table",
        "drop table|view|function|database [if exists]",
        "create [temporary] function",
        "alter table",
    ].map((pattern) => ({ pattern, keywordCase: true, payload: false })),
    // Command payload layer: paths, URIs, class names and shell arguments stay verbatim.
    ...[
        "add|list|delete jar|jars|file|files|archive|archives",
        "dfs",
        "!",
        "source",
        "reset",
        "compile",
    ].map((pattern) => ({ pattern, keywordCase: true, payload: true })),
    // Authorization statements keep their case: Hive principal names are case-sensitive.
    ...[
        "grant",
        "revoke",
        "show role grant",
        "show grant",
        "create role",
        "drop role",
    ].map((pattern) => ({ pattern, keywordCase: false, payload: false })),
];

interface HeadStep {
    readonly words: readonly string[];
    readonly optional: boolean;
}

interface CompiledHead extends Omit<HeadEntry, "pattern"> {
    readonly steps: readonly (readonly HeadStep[])[];
}

/** Splits a pattern into groups of steps; an optional group matches completely or not at all. */
function compileHead(entry: HeadEntry): CompiledHead {
    const groups: HeadStep[][] = [];
    for (const part of entry.pattern.match(/\[[^\]]+\]|\S+/g)!) {
        const optional = part.startsWith("[");
        const words = optional ? part.slice(1, -1).split(" ") : [part];
        groups.push(words.map((word) => ({ words: word.split("|"), optional })));
    }
    return { keywordCase: entry.keywordCase, payload: entry.payload, steps: groups };
}

const HEADS: readonly CompiledHead[] = HEAD_ENTRIES.map(compileHead);

export interface StatementHead {
    /** Matched head leaves in source order. */
    readonly leafIds: readonly number[];
    readonly keywordCase: boolean;
    readonly payload: boolean;
}

function wordAt(context: ParserContext, leafId: number): string | null {
    const leaf = context.leaves[leafId]!;
    if (leaf.channel !== "code") {
        return null;
    }
    if (leaf.kind === "identifier" || leaf.kind === "keyword") {
        return leaf.raw.toLowerCase();
    }
    return leaf.raw === "!" ? "!" : null;
}

function matchHead(
    context: ParserContext,
    range: LeafRange,
    head: CompiledHead
): number[] | null {
    const leafIds: number[] = [];
    let cursor: number | null = range.start;
    for (const group of head.steps) {
        const matched: number[] = [];
        let next: number | null = cursor;
        for (const step of group) {
            if (next === null || !step.words.includes(wordAt(context, next) ?? "")) {
                break;
            }
            matched.push(next);
            next = nextSyntaxIndex(context, next, range.end);
        }
        if (matched.length === group.length) {
            leafIds.push(...matched);
            cursor = next;
        } else if (!group[0]!.optional) {
            return null;
        }
    }
    return leafIds;
}

/** First words of the command heads, such as `add` in `add jar`. */
const COMMAND_VERBS: ReadonlySet<string> = new Set(
    HEADS.filter((head) => head.payload).flatMap((head) => head.steps[0]![0]!.words)
);

/**
 * Whether a statement the head table does not match may still take the generic layer. It must
 * start with a plain word: a template there may expand to any statement. It must not start a
 * command head either (`add jar${v}`), since the generic layer would rewrite the payload. A
 * FROM-first multi-insert is a query, which the generic layer would flatten.
 */
export function takesGenericLayer(context: ParserContext, range: LeafRange): boolean {
    const word = wordAt(context, range.start);
    return word !== null && word !== "from" && !COMMAND_VERBS.has(word);
}

/** CREATE TABLE heads that may end in AS SELECT (plan §6 P6 step 5). */
const CREATE_TABLE_HEADS: readonly CompiledHead[] = [
    "create [temporary] [transactional] [external] table [if not exists]",
    "create managed table [if not exists]",
].map((pattern) => compileHead({ pattern, keywordCase: true, payload: false }));

/** Head words of a CREATE TABLE statement, or null. */
export function matchCreateTableHead(
    context: ParserContext,
    range: LeafRange
): readonly number[] | null {
    for (const head of CREATE_TABLE_HEADS) {
        const leafIds = matchHead(context, range, head);
        if (leafIds !== null) {
            return leafIds;
        }
    }
    return null;
}

/** The longest statement-head table entry matching at the start of `range`, or null. */
export function matchStatementHead(
    context: ParserContext,
    range: LeafRange
): StatementHead | null {
    let best: StatementHead | null = null;
    for (const head of HEADS) {
        const leafIds = matchHead(context, range, head);
        if (leafIds !== null && leafIds.length > (best?.leafIds.length ?? 0)) {
            best = { leafIds, keywordCase: head.keywordCase, payload: head.payload };
        }
    }
    return best;
}
