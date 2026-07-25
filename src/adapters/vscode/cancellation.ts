import type * as Vscode from "vscode";

import type { CancellationToken } from "../transaction/types";

/** Adapts VS Code's Disposable-returning event to the v2 unsubscribe contract. */
export function wrapVscodeCancellationToken(
    token: Vscode.CancellationToken | undefined
): CancellationToken | undefined {
    if (token === undefined) {
        return undefined;
    }
    return Object.freeze({
        get isCancellationRequested(): boolean {
            try {
                return token.isCancellationRequested === true;
            } catch {
                return true;
            }
        },
        onCancellationRequested(listener: () => void): () => void {
            const disposable = token.onCancellationRequested(listener);
            if (
                typeof disposable !== "object" ||
                disposable === null ||
                typeof disposable.dispose !== "function"
            ) {
                throw new TypeError("VS Code cancellation subscription is invalid");
            }
            let disposed = false;
            return () => {
                if (disposed) {
                    return;
                }
                disposed = true;
                disposable.dispose();
            };
        },
    });
}
