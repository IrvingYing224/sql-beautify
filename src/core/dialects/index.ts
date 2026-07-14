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
    OperatorForm,
    OperatorSemantics,
    QueryClauseSyntax,
    QueryClauseSyntaxId,
    SetOperatorSyntax,
    SetOperatorSyntaxId,
} from "./types";
export {
    getDialect,
    getDialectCapabilityRegistry,
    hasDialect,
    listDialects,
} from "./registry";
