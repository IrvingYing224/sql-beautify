import type { CancellationToken } from "./types";

export interface CancellationController {
    readonly token: CancellationToken;
    cancel(): void;
    dispose(): void;
}

export interface CancellationObservation {
    isCancelled(): boolean;
    dispose(): void;
}

export function observeCancellation(
    token: CancellationToken | undefined
): CancellationObservation {
    let cancelled = false;
    let disposed = false;
    let unsubscribe: (() => void) | null = null;
    try {
        cancelled = token?.isCancellationRequested === true;
        if (!cancelled && token !== undefined) {
            const rawSubscribe = (token as unknown as {
                onCancellationRequested?: unknown;
            }).onCancellationRequested;
            if (typeof rawSubscribe !== "function") {
                cancelled = true;
            } else {
                const value = rawSubscribe.call(token, () => {
                    cancelled = true;
                });
                if (typeof value !== "function") {
                    cancelled = true;
                } else {
                    unsubscribe = value;
                }
            }
        }
    } catch {
        cancelled = true;
    }
    return {
        isCancelled(): boolean {
            if (cancelled || disposed) {
                return true;
            }
            try {
                cancelled = token?.isCancellationRequested === true;
            } catch {
                cancelled = true;
            }
            return cancelled;
        },
        dispose(): void {
            if (disposed) {
                return;
            }
            disposed = true;
            try {
                unsubscribe?.();
            } catch {
                return;
            } finally {
                unsubscribe = null;
            }
        },
    };
}

export function createCancellationController(): CancellationController {
    let cancelled = false;
    let disposed = false;
    const listeners = new Set<() => void>();
    const token: CancellationToken = Object.freeze({
        get isCancellationRequested(): boolean {
            return cancelled;
        },
        onCancellationRequested(listener: () => void): () => void {
            if (disposed) {
                return () => undefined;
            }
            if (cancelled) {
                try {
                    listener();
                } catch {
                    return () => undefined;
                }
                return () => undefined;
            }
            listeners.add(listener);
            return () => {
                listeners.delete(listener);
            };
        },
    });
    return Object.freeze({
        token,
        cancel(): void {
            if (cancelled || disposed) {
                return;
            }
            cancelled = true;
            const snapshot = Array.from(listeners);
            listeners.clear();
            for (const listener of snapshot) {
                try {
                    listener();
                } catch {
                    continue;
                }
            }
        },
        dispose(): void {
            disposed = true;
            listeners.clear();
        },
    });
}
