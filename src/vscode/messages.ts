export type VscodeMessageKey =
    | "activeSqlEditor"
    | "configurationInvalid"
    | "commandOptionsInvalid"
    | "formattingSql"
    | "formattingHiveDdl"
    | "extractingHiveDdl"
    | "preservedHiveDdl"
    | "unmodeledRegions"
    | "formatCancelled"
    | "documentChanged"
    | "rangeRejected"
    | "inputLimitRejected"
    | "workerRejected"
    | "formatRejected"
    | "ddlRejected"
    | "editRejected";

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
    configurationInvalid: ({ optionKey }) => optionKey === null || optionKey === undefined
        ? "SQL Beautify configuration is invalid. Check sqlBeautify settings."
        : `SQL Beautify configuration is invalid for sqlBeautify.${optionKey}.`,
    commandOptionsInvalid: ({ optionKey }) => optionKey === null || optionKey === undefined
        ? "SQL Beautify command options are invalid."
        : `SQL Beautify command option ${optionKey} is invalid.`,
    formattingSql: () => "Formatting SQL",
    formattingHiveDdl: () => "Formatting Hive DDL",
    extractingHiveDdl: () => "Extracting Hive DDL",
    preservedHiveDdl: () =>
        "SQL Beautify preserved Hive DDL. Use the dedicated Format Hive DDL command for the supported experimental subset.",
    unmodeledRegions: ({ count }) =>
        `SQL Beautify made no changes because ${String(count ?? 0)} SQL region(s) are not modeled.`,
    formatCancelled: () => "SQL Beautify formatting was cancelled.",
    documentChanged: () =>
        "SQL Beautify did not apply edits because the document changed. Run formatting again.",
    rangeRejected: () =>
        "SQL Beautify did not modify the selection. Select complete SQL lines, clauses, or contiguous statements.",
    inputLimitRejected: () =>
        "SQL Beautify did not modify the document because the selected SQL exceeds the 512 Ki code-unit limit.",
    workerRejected: () =>
        "SQL Beautify could not complete formatting in the worker. Run the command again.",
    formatRejected: () =>
        "SQL Beautify did not modify the document because formatting was not safe.",
    ddlRejected: () =>
        "SQL Beautify did not modify the document because the selected DDL is outside the supported experimental subset.",
    editRejected: () =>
        "SQL Beautify did not change the document because the editor did not accept the edits. It may be read-only, closed or hidden.",
});

const ZH_CN: MessageCatalog = Object.freeze({
    activeSqlEditor: () => "SQL Beautify 需要一个当前已打开的 SQL 编辑器。",
    configurationInvalid: ({ optionKey }) => optionKey === null || optionKey === undefined
        ? "SQL Beautify 配置无效，请检查 sqlBeautify 设置。"
        : `SQL Beautify 配置项 sqlBeautify.${optionKey} 无效。`,
    commandOptionsInvalid: ({ optionKey }) => optionKey === null || optionKey === undefined
        ? "SQL Beautify 命令选项无效。"
        : `SQL Beautify 命令选项 ${optionKey} 无效。`,
    formattingSql: () => "正在格式化 SQL",
    formattingHiveDdl: () => "正在格式化 Hive DDL",
    extractingHiveDdl: () => "正在提取 Hive DDL",
    preservedHiveDdl: () =>
        "SQL Beautify 已保留 Hive DDL 原文。可对受支持的实验子集使用“Format Hive DDL”命令。",
    unmodeledRegions: ({ count }) =>
        `SQL Beautify 未做修改，因为有 ${String(count ?? 0)} 个 SQL 区域尚未建模。`,
    formatCancelled: () => "SQL Beautify 格式化已取消。",
    documentChanged: () =>
        "文档已发生变化，SQL Beautify 未应用编辑；请重新运行格式化。",
    rangeRejected: () =>
        "SQL Beautify 未修改选区。请选择完整 SQL 行、子句或连续语句。",
    inputLimitRejected: () =>
        "所选 SQL 超过 512 Ki UTF-16 code-unit 限制，SQL Beautify 未修改文档。",
    workerRejected: () =>
        "SQL Beautify 的 worker 未能完成格式化，请重试。",
    formatRejected: () => "格式化结果无法证明安全，SQL Beautify 未修改文档。",
    ddlRejected: () =>
        "所选 DDL 不属于受支持的实验子集，SQL Beautify 未修改文档。",
    editRejected: () =>
        "编辑器没有接受编辑，SQL Beautify 未修改文档。编辑器可能是只读、已关闭或不可见。",
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
