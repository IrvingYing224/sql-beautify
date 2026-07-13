export type {
    CapabilityEntry,
    CapabilityState,
    DialectCapabilityRegistry,
    DialectCapabilityView,
    OperatorArity,
    OperatorAssociativity,
    OperatorFixity,
    OperatorForm,
    OperatorSemantics,
} from "./types";
export {
    getDialect,
    getDialectCapabilityRegistry,
    hasDialect,
    listDialects,
} from "./registry";
