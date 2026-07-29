export type VscodeMessageKey =
    | "activeSqlEditor"
    | "editorState"
    | "configurationInvalid"
    | "commandOptionsInvalid"
    | "formattingSql"
    | "formattingHiveDdl"
    | "extractingHiveDdl"
    | "preparingSafeReport"
    | "preservedHiveDdl"
    | "unmodeledRegions"
    | "formatCancelled"
    | "documentChanged"
    | "rangeRejected"
    | "selectionMapRejected"
    | "inputLimitRejected"
    | "workerRejected"
    | "formatRejected"
    | "ddlRejected"
    | "editRejected"
    | "selectionRestoreFailed"
    | "safeReportCancelled"
    | "safeReportStale"
    | "safeReportCopied"
    | "safeReportCopyFailed";

export interface VscodeMessageValues {
    readonly count?: number;
    readonly optionKey?: string | null;
}

export interface VscodeMessages {
    readonly locale: "en" | "zh-cn";
    text(key: VscodeMessageKey, values?: VscodeMessageValues): string;
}

type MessageFactory = (values: VscodeMessageValues) => string;
type MessageCatalog = Readonly<Record<VscodeMessageKey, MessageFactory>>;

const EN: MessageCatalog = Object.freeze({
    activeSqlEditor: () => "SQL Beautify requires an active SQL editor.",
    editorState: () => "SQL Beautify could not read the editor state safely.",
    configurationInvalid: ({ optionKey }) => optionKey === null || optionKey === undefined
        ? "SQL Beautify configuration is invalid. Check sqlBeautify settings."
        : `SQL Beautify configuration is invalid for sqlBeautify.${optionKey}.`,
    commandOptionsInvalid: ({ optionKey }) => optionKey === null || optionKey === undefined
        ? "SQL Beautify command options are invalid."
        : `SQL Beautify command option ${optionKey} is invalid.`,
    formattingSql: () => "Formatting SQL",
    formattingHiveDdl: () => "Formatting Hive DDL",
    extractingHiveDdl: () => "Extracting Hive DDL",
    preparingSafeReport: () => "Preparing safe diagnostic report",
    preservedHiveDdl: () =>
        "SQL Beautify preserved Hive DDL. Use the dedicated Format Hive DDL command for the supported experimental subset.",
    unmodeledRegions: ({ count }) =>
        `SQL Beautify made no changes because ${String(count ?? 0)} SQL region(s) are not modeled.`,
    formatCancelled: () => "SQL Beautify formatting was cancelled.",
    documentChanged: () =>
        "SQL Beautify did not apply edits because the document changed. Run formatting again.",
    rangeRejected: () =>
        "SQL Beautify did not modify the selection. Select complete SQL lines, clauses, or contiguous statements.",
    selectionMapRejected: () =>
        "SQL Beautify did not apply edits because editor selections could not be mapped safely.",
    inputLimitRejected: () =>
        "SQL Beautify did not modify the document because the selected SQL exceeds the 512 Ki code-unit limit.",
    workerRejected: () =>
        "SQL Beautify could not complete formatting in the worker. Run the command again; if it repeats, copy a safe diagnostic report.",
    formatRejected: () =>
        "SQL Beautify did not modify the document because formatting was not safe.",
    ddlRejected: () =>
        "SQL Beautify did not modify the document because the selected DDL is outside the supported experimental subset.",
    editRejected: () =>
        "SQL Beautify could not apply the edits. Check whether the editor is read-only and run the command again.",
    selectionRestoreFailed: () =>
        "SQL Beautify formatted the document but could not restore the selection.",
    safeReportCancelled: () => "SQL Beautify safe diagnostic report was cancelled.",
    safeReportStale: () =>
        "SQL Beautify did not copy the report because the document changed.",
    safeReportCopied: () => "SQL Beautify safe diagnostic report copied.",
    safeReportCopyFailed: () =>
        "SQL Beautify could not copy the safe diagnostic report.",
});

const ZH_CN: MessageCatalog = Object.freeze({
    activeSqlEditor: () => "SQL Beautify 需要一个当前已打开的 SQL 编辑器。",
    editorState: () => "SQL Beautify 无法安全读取当前编辑器状态。",
    configurationInvalid: ({ optionKey }) => optionKey === null || optionKey === undefined
        ? "SQL Beautify 配置无效，请检查 sqlBeautify 设置。"
        : `SQL Beautify 配置项 sqlBeautify.${optionKey} 无效。`,
    commandOptionsInvalid: ({ optionKey }) => optionKey === null || optionKey === undefined
        ? "SQL Beautify 命令选项无效。"
        : `SQL Beautify 命令选项 ${optionKey} 无效。`,
    formattingSql: () => "正在格式化 SQL",
    formattingHiveDdl: () => "正在格式化 Hive DDL",
    extractingHiveDdl: () => "正在提取 Hive DDL",
    preparingSafeReport: () => "正在生成安全诊断报告",
    preservedHiveDdl: () =>
        "SQL Beautify 已保留 Hive DDL 原文。可对受支持的实验子集使用“Format Hive DDL”命令。",
    unmodeledRegions: ({ count }) =>
        `SQL Beautify 未做修改，因为有 ${String(count ?? 0)} 个 SQL 区域尚未建模。`,
    formatCancelled: () => "SQL Beautify 格式化已取消。",
    documentChanged: () =>
        "文档已发生变化，SQL Beautify 未应用编辑；请重新运行格式化。",
    rangeRejected: () =>
        "SQL Beautify 未修改选区。请选择完整 SQL 行、子句或连续语句。",
    selectionMapRejected: () =>
        "无法安全映射编辑器选区，SQL Beautify 未应用编辑。",
    inputLimitRejected: () =>
        "所选 SQL 超过 512 Ki UTF-16 code-unit 限制，SQL Beautify 未修改文档。",
    workerRejected: () =>
        "SQL Beautify 的 worker 未能完成格式化。请重试；如问题重复出现，请复制安全诊断报告。",
    formatRejected: () => "格式化结果无法证明安全，SQL Beautify 未修改文档。",
    ddlRejected: () =>
        "所选 DDL 不属于受支持的实验子集，SQL Beautify 未修改文档。",
    editRejected: () =>
        "SQL Beautify 无法应用编辑。请检查编辑器是否为只读，然后重新运行命令。",
    selectionRestoreFailed: () =>
        "SQL Beautify 已格式化文档，但无法恢复原选区。",
    safeReportCancelled: () => "SQL Beautify 安全诊断报告已取消。",
    safeReportStale: () => "文档已发生变化，SQL Beautify 未复制诊断报告。",
    safeReportCopied: () => "SQL Beautify 安全诊断报告已复制。",
    safeReportCopyFailed: () => "SQL Beautify 无法复制安全诊断报告。",
});

export function createVscodeMessages(language: unknown): VscodeMessages {
    const locale = typeof language === "string" &&
        language.toLowerCase().replace("_", "-").startsWith("zh-cn")
        ? "zh-cn" as const
        : "en" as const;
    const catalog = locale === "zh-cn" ? ZH_CN : EN;
    return Object.freeze({
        locale,
        text(key: VscodeMessageKey, values: VscodeMessageValues = {}): string {
            return catalog[key](values);
        },
    });
}
