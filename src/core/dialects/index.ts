export type {
    CapabilityEntry,
    CapabilityState,
    DialectCapabilityRegistry,
    DialectCapabilityView,
    JoinSyntax,
    JoinSyntaxId,
    OperatorArity,
    OperatorAssociativity,
    OperatorFixity,
    OperatorFormatClass,
    OperatorForm,
    OperatorSemantics,
    QueryClauseSyntax,
    QueryClauseSyntaxId,
    SetOperatorSyntax,
    SetOperatorSyntaxId,
    UnsupportedSyntaxContext,
    UnsupportedSyntaxSignature,
} from "./types";
export type {
    ParserStructuredCapabilityState,
    RecognizedCapabilityState,
} from "./capability-state";
export {
    isParserStructuredCapabilityState,
    isRecognizedCapabilityState,
} from "./capability-state";
export {
    getDialect,
    getDialectCapabilityRegistry,
    hasDialect,
    listDialects,
} from "./registry";
