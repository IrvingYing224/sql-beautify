import type { FormatOptions } from "../config/options";
import { inferRenderEnvironment } from "../renderer/environment";
import type { FormatResult } from "./format-result";
import { formatSql as formatSqlTarget } from "./format";

/** Public document-only formatter API. Target modes remain adapter-internal. */
export function formatSql(
    source: string,
    options: FormatOptions | unknown = undefined
): FormatResult {
    return formatSqlTarget(
        source,
        options,
        "document",
        typeof source === "string" ? inferRenderEnvironment(source) : undefined
    );
}
