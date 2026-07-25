import * as vscode from "vscode";

import type { FormatterExecutor } from "./adapters/transaction/types";
import {
    createVscodeExtension,
    type V2ExtensionRuntime,
    type VscodeExtensionSession,
} from "./adapters/vscode/extension";

interface ProductionRuntime extends V2ExtensionRuntime {
    createProductionFormatterExecutor(options: Readonly<{
        runtimePath: string;
        workerPath: string;
    }>): FormatterExecutor;
}

declare const __dirname: string;
declare const require: (path: string) => unknown;

const path = require("path") as { join(...parts: string[]): string };

let session: VscodeExtensionSession | null = null;

function loadRuntime(runtimePath: string): ProductionRuntime {
    const value = require(runtimePath) as Partial<ProductionRuntime>;
    const requiredFunctions = [
        "prepareFormatTransaction",
        "resolveFormatOptions",
        "runHostTransaction",
        "runExperimentalDdlTransaction",
        "formatHiveDdl",
        "extractDdl",
        "createProductionFormatterExecutor",
    ] as const;
    for (const key of requiredFunctions) {
        if (typeof value[key] !== "function") {
            throw new Error("SQL Beautify runtime artifact is invalid");
        }
    }
    return value as ProductionRuntime;
}

export async function activate(context: vscode.ExtensionContext): Promise<void> {
    if (session !== null) {
        return;
    }
    let executor: FormatterExecutor | null = null;
    let pending: VscodeExtensionSession | null = null;
    try {
        const runtimePath = path.join(__dirname, "runtime.cjs");
        const workerPath = path.join(__dirname, "formatter-worker.cjs");
        const runtime = loadRuntime(runtimePath);
        executor = runtime.createProductionFormatterExecutor({
            runtimePath,
            workerPath,
        });
        pending = createVscodeExtension(vscode, runtime, executor, {
            extensionVersion: context.extension.packageJSON.version as string,
        });
        pending.activate(context);
        session = pending;
    } catch (error) {
        if (pending !== null) {
            await pending.dispose();
        } else {
            await executor?.dispose();
        }
        throw error;
    }
}

export async function deactivate(): Promise<void> {
    const current = session;
    session = null;
    await current?.dispose();
}
