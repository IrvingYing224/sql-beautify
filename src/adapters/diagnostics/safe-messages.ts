const CODE_PATTERN = /^[A-Z][A-Z0-9_]{1,119}$/;
const CAPABILITY_PATTERN = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;

function entries(
    codes: readonly string[],
    message: string
): Readonly<Record<string, string>> {
    return Object.fromEntries(codes.map((code) => [code, message]));
}

/**
 * Complete static messages for every production diagnostic code reachable at
 * the core, executor, transaction and experimental DDL boundaries. Messages
 * deliberately describe the failure class without copying source-derived
 * details from Diagnostic.message.
 */
const SAFE_MESSAGE_BY_CODE: Readonly<Record<string, string>> = Object.freeze({
    ...entries([
        "CFG_OPTIONS_TYPE",
        "CFG_OPTIONS_PROXY",
        "CFG_OPTIONS_SHAPE",
        "CFG_OPTION_ACCESSOR",
        "CFG_OPTION_VALUE",
    ], "Formatter options are invalid"),
    CFG_UNKNOWN_OPTION: "Formatter options contain an unsupported key",
    CFG_OPTIONS_READ: "Formatter options could not be inspected",

    ...entries([
        "LEX_UNTERMINATED_STRING",
        "LEX_UNTERMINATED_QUOTED_IDENTIFIER",
        "LEX_UNTERMINATED_BLOCK_COMMENT",
        "LEX_UNTERMINATED_DOLLAR_STRING",
        "LEX_UNTERMINATED_TEMPLATE",
    ], "SQL contains an unterminated lexical construct"),
    ...entries([
        "STRUCT_UNMATCHED_CLOSER",
        "STRUCT_UNMATCHED_OPENER",
        "STRUCT_MIXED_DELIMITER",
        "STRUCT_UNRELIABLE_STATEMENT_BOUNDARY",
    ], "SQL structure could not be bounded safely"),
    SYN_UNMODELED_CONSTRUCT: "This SQL construct is not modeled and was preserved",
    SYN_UNSUPPORTED_STATEMENT: "This SQL statement is not supported and was preserved",
    SYN_UNEXPECTED_TOKEN: "SQL contains an unexpected token",
    SYN_INCOMPLETE_CLAUSE: "SQL contains an incomplete clause",
    SYN_UNMATCHED_DELIMITER: "SQL contains an unmatched delimiter",
    SYN_MAX_DEPTH_EXCEEDED: "SQL nesting exceeds the supported depth",
    SYN_INTERNAL_INVARIANT: "SQL structure failed an internal safety check",

    ...entries([
        "INV_LEAF_RANGE_BOUNDS",
        "INV_SPAN_LEAFRANGE_MISMATCH",
        "INV_ROOT_ID",
        "INV_ID_UNIQUE",
        "INV_ID_CONTIGUOUS",
        "INV_CHILDREN_ORDER",
        "INV_SIBLING_OVERLAP",
        "INV_PARENT_CONTAINMENT",
        "INV_SHARED_CHILD",
        "INV_OPAQUE_CHILDREN",
        "INV_OWNER_REFERENCE",
        "INV_CHILD_REFERENCE",
        "INV_RELATIONSHIP",
        "INV_SHAPE",
        "INV_ENUM",
        "INV_DELIMITER_PAIR",
        "INV_DEPTH_CONSISTENCY",
        "INV_ADJACENCY",
        "INV_ORDINAL",
        "INV_STATEMENT_RANGES",
        "INV_LEAF_PARTITION",
        "INV_MALFORMED_NODE",
        "INV_ROOT_COVERAGE",
        "INV_EMPTY_RANGE",
        "INV_SOURCE_TYPE",
        "INV_TOKEN_TABLE",
        "INV_EXTRA_CHILD",
    ], "SQL structure failed an internal invariant"),

    FMT_SOURCE_TYPE: "Formatter input must be SQL text",
    FMT_PARSE_MODE: "Formatter parse mode is invalid",
    FMT_UNSUPPORTED_BAIL_OUT: "Formatting stopped at an unsupported SQL construct",
    FMT_TOKEN_EQUIVALENCE: "Formatted SQL did not pass token-equivalence validation",
    FMT_INTERNAL: "Formatter failed safely during internal processing",

    ...entries([
        "LAYOUT_ARTIFACT_ANALYSIS",
        "LAYOUT_ARTIFACT_OPTIONS",
        "LAYOUT_ARTIFACT_DIALECT",
        "LAYOUT_ARTIFACT_DOC",
        "LAYOUT_PLAN_PROVENANCE",
        "LAYOUT_PLAN_DOMINATED",
        "LAYOUT_PLAN_AUTHORITY",
        "LAYOUT_PLAN_CONFLICT",
        "LAYOUT_PLAN_GAP",
        "LAYOUT_PLAN_SCOPE",
        "LAYOUT_PLAN_RESOURCE",
        "LAYOUT_PLAN_INTERNAL",
        "LAYOUT_COMPILE_PLAN_PROVENANCE",
        "LAYOUT_COMPILE_ACTION",
        "LAYOUT_COMPILE_DOC",
        "LAYOUT_COMPILE_ARTIFACT",
        "LAYOUT_COMPILE_RESOURCE",
        "LAYOUT_COMPILE_INTERNAL",
        "LAYOUT_ALIGNMENT_FACTS",
        "LAYOUT_ANALYSIS_PROVENANCE",
        "LAYOUT_DOC_PROVENANCE",
        "LAYOUT_DOC_MUTABLE",
        "LAYOUT_DOC_SHARED",
        "LAYOUT_DOC_SHAPE",
        "LAYOUT_RESOURCE_BUDGET",
        "LAYOUT_LEAF_REFERENCE",
        "LAYOUT_LEAF_TRANSFORM",
        "LAYOUT_VERBATIM_HANDLE",
        "LAYOUT_VERBATIM_REQUIRED",
        "LAYOUT_COMMENT_SUFFIX",
        "LAYOUT_SOURCE_ORDER",
        "LAYOUT_SOURCE_DUPLICATE",
        "LAYOUT_SOURCE_MISSING",
        "LAYOUT_FLAT_MULTILINE",
    ], "Formatter layout failed an internal safety check"),
    ...entries([
        "METRICS_ARTIFACT_PROVENANCE",
        "METRICS_DOC_PROVENANCE",
        "METRICS_SOURCE_RANGE",
        "METRICS_OVERFLOW",
        "METRICS_INTERNAL",
    ], "Formatter layout metrics failed an internal safety check"),
    ...entries([
        "RENDER_ARTIFACT_PROVENANCE",
        "RENDER_METRICS",
        "RENDER_KEYWORD_TRANSFORM",
        "RENDER_RESOURCE_BUDGET",
        "RENDER_SOURCE_MAP",
        "RENDER_NEWLINE_CONTRACT",
        "RENDER_INTERNAL",
    ], "SQL rendering failed an internal safety check"),

    ADAPTER_CANCELLED: "Formatting was cancelled",
    ADAPTER_COMMAND_FAILED: "The formatting command failed safely",
    ADAPTER_PROVIDER_FAILED: "The formatting provider failed safely",
    ADAPTER_DOCUMENT_SNAPSHOT: "The document could not be captured safely",
    ADAPTER_STALE_DOCUMENT: "The document changed before edits could be applied",
    ADAPTER_EDIT_REJECTED: "The editor rejected the formatting edits",
    ADAPTER_HOST_FAILED: "The editor transaction failed safely",
    ADAPTER_EXECUTION_REQUEST: "The formatter execution request is invalid",
    ADAPTER_EXECUTOR_FAILED: "The formatter executor failed safely",
    ADAPTER_RESULT_SNAPSHOT: "The formatter result could not be inspected safely",
    ADAPTER_RESULT_CONTRACT: "The formatter result violated the adapter contract",
    ADAPTER_DIAGNOSTIC_CONTRACT: "A formatter diagnostic violated the adapter contract",
    ADAPTER_SELECTION_MAP: "Editor selections could not be restored safely",
    ADAPTER_TRANSACTION_READ: "The formatting transaction could not be inspected safely",
    ADAPTER_TRANSACTION_REQUEST: "The formatting transaction request is invalid",
    ADAPTER_TRANSACTION_SELECTION: "The formatting selections are invalid",
    ADAPTER_TRANSACTION_TARGET: "The formatting targets are invalid or overlapping",
    ADAPTER_RANGE_ANALYSIS: "The selected range could not be analyzed safely",
    ADAPTER_RANGE_DOCUMENT: "The selected range does not belong to one safe document",
    ADAPTER_RANGE_EMPTY: "The selected range contains no SQL",
    ADAPTER_RANGE_LINE: "The selected range must cover complete safe lines",
    ADAPTER_RANGE_OPAQUE: "The selected range crosses an opaque SQL region",
    ADAPTER_RANGE_OWNERSHIP: "The selected range crosses a syntax ownership boundary",
    ADAPTER_RANGE_PROTECTED: "The selected range crosses protected SQL text",
    ADAPTER_RANGE_TARGET: "The selected range target is invalid",
    ADAPTER_WORKER_BACKPRESSURE: "The formatter worker queue is full",
    ADAPTER_WORKER_CRASH: "The formatter worker stopped unexpectedly",
    ADAPTER_WORKER_FORMAT_FAILED: "The formatter worker failed safely",
    ADAPTER_WORKER_RESULT_CONTRACT: "The formatter worker result violated the protocol",
    ADAPTER_WORKER_STALE_RESPONSE: "A stale formatter worker response was rejected",
    ADAPTER_WORKER_TIMEOUT: "The formatter worker request timed out",
    ADAPTER_WORKER_UNAVAILABLE: "The formatter worker is unavailable",

    ADAPTER_DDL_COMMAND_FAILED: "The experimental DDL command failed safely",
    ADAPTER_DDL_NOT_EDITABLE: "The experimental DDL result cannot be edited safely",
    ADAPTER_DDL_OPERATION: "The experimental DDL operation failed safely",
    ADAPTER_DDL_RANGE: "The DDL selection is not a complete safe source range",
    ADAPTER_DDL_RESULT: "The experimental DDL result violated the adapter contract",
    ADAPTER_DDL_TARGET: "The experimental DDL targets are invalid or overlapping",
    ADAPTER_DDL_TRANSACTION: "The experimental DDL transaction failed safely",

    DDL_INPUT: "Hive DDL input is invalid",
    DDL_EMPTY: "Hive DDL input is empty",
    DDL_MULTI_STATEMENT: "Only one complete Hive DDL statement is supported",
    DDL_UNSUPPORTED_STATEMENT: "This Hive DDL statement is not supported",
    DDL_UNSUPPORTED_HEADER: "This Hive DDL header is not supported",
    DDL_TABLE_NAME: "The Hive table name could not be modeled safely",
    DDL_COLUMN_LIST: "The Hive column list could not be modeled safely",
    DDL_EMPTY_COLUMNS: "The Hive DDL column list is empty",
    DDL_EMPTY_COLUMN: "A Hive DDL column definition is empty",
    DDL_COLUMN_NAME: "A Hive DDL column name could not be modeled safely",
    DDL_COLUMN_TYPE: "A Hive DDL column type could not be modeled safely",
    DDL_COLUMN_COMMENT: "A Hive DDL column comment could not be modeled safely",
    DDL_COMMENT_TRIVIA: "Hive DDL comments cross an unsafe boundary",
    DDL_UNMODELED_COLUMN: "A Hive DDL column definition is not modeled",
    DDL_UNMODELED_SUFFIX: "The Hive DDL suffix is not modeled",
    DDL_LEXICAL_STRUCTURE: "Hive DDL contains unsafe lexical structure",
    DDL_INTERNAL: "Hive DDL formatting failed safely",

    EXTRACT_INPUT: "DDL extraction input is invalid",
    EXTRACT_EMPTY: "DDL extraction input is empty",
    EXTRACT_MULTI_STATEMENT: "DDL extraction requires one complete statement",
    EXTRACT_UNSUPPORTED_STATEMENT: "This statement is not supported for DDL extraction",
    EXTRACT_UNSUPPORTED: "DDL extraction cannot prove a safe schema",
    EXTRACT_ANALYSIS_FAILED: "DDL extraction analysis failed safely",
    EXTRACT_QUERY_SHAPE: "The query shape is not supported for DDL extraction",
    EXTRACT_QUERY_CYCLE: "The query contains a cyclic extraction dependency",
    EXTRACT_SELECT_SHAPE: "The projection shape is not supported for DDL extraction",
    EXTRACT_SET_SHAPE: "The set-operation shape is not supported for DDL extraction",
    EXTRACT_VALUE_SHAPE: "A projection value cannot be modeled safely",
    EXTRACT_ALIAS_SHAPE: "A projection alias cannot be modeled safely",
    EXTRACT_NAME_SHAPE: "A projected name cannot be modeled safely",
    EXTRACT_COMMENT_SHAPE: "A projected comment cannot be modeled safely",
    EXTRACT_WILDCARD: "Wildcard projections cannot be extracted safely",
    EXTRACT_DUPLICATE_NAME: "DDL extraction found duplicate projected names",
    EXTRACT_SCHEMA_MISMATCH: "Set-operation schemas do not match",
    EXTRACT_DEFAULT_TYPE: "A projected type requires explicit confirmation",
    EXTRACT_INTERNAL: "DDL extraction failed safely",
});

const KNOWN_SAFE_CODES = Object.freeze(Object.keys(SAFE_MESSAGE_BY_CODE).sort());

export function hasKnownSafeDiagnosticMessage(code: string): boolean {
    return Object.prototype.hasOwnProperty.call(SAFE_MESSAGE_BY_CODE, code);
}

export function knownSafeDiagnosticCodes(): readonly string[] {
    return KNOWN_SAFE_CODES;
}

export function safeDiagnosticMessage(
    code: string,
    capabilityId: string | null
): string {
    const configured = SAFE_MESSAGE_BY_CODE[code];
    const base = configured !== undefined
        ? configured
        : CODE_PATTERN.test(code)
            ? "Formatter reported a recoverable diagnostic"
            : "Formatter diagnostic is unavailable";
    return capabilityId !== null && CAPABILITY_PATTERN.test(capabilityId)
        ? `${base} (capability: ${capabilityId})`
        : base;
}
