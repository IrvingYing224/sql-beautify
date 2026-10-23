import * as path from "node:path";
import * as vscode from "vscode";

import { EditExecutor, nodeWorkerFactory } from "./edits/executor";
import { registerCommands } from "./vscode/commands";
import { isSupported } from "./vscode/config";
import { Diagnostics } from "./vscode/diagnostics";
import { createVscodeMessages } from "./vscode/messages";
import { registerProviders } from "./vscode/providers";

let executor: EditExecutor | null = null;
let diagnostics: Diagnostics | null = null;

export function activate(context: vscode.ExtensionContext): void {
    const currentExecutor = new EditExecutor(nodeWorkerFactory(path.join(__dirname, "worker.cjs")));
    const currentDiagnostics = new Diagnostics();
    executor = currentExecutor;
    diagnostics = currentDiagnostics;
    context.subscriptions.push(
        currentDiagnostics,
        vscode.workspace.onDidChangeTextDocument((event) => {
            if (isSupported(event.document)) {
                currentDiagnostics.change(event);
            }
        }),
        vscode.workspace.onDidCloseTextDocument((document) => {
            if (isSupported(document)) {
                currentDiagnostics.clear(document);
            }
        }),
        ...registerProviders(currentExecutor, currentDiagnostics),
        ...registerCommands(
            currentExecutor,
            currentDiagnostics,
            createVscodeMessages(vscode.env.language),
            context.extension.packageJSON.version as string
        )
    );
}

export function deactivate(): void {
    executor?.dispose();
    diagnostics?.dispose();
    executor = null;
    diagnostics = null;
}
