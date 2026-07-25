import { snapshotDataProperties } from "../boundary/data-snapshot";

export interface DocumentSnapshot {
    readonly identity: unknown;
    readonly source: string;
    readonly version: number;
}

const DOCUMENT_KEYS: ReadonlySet<string> = new Set([
    "identity",
    "source",
    "version",
]);

export function snapshotDocument(value: DocumentSnapshot | null): DocumentSnapshot | null {
    try {
        const snapshot = snapshotDataProperties(
            value,
            DOCUMENT_KEYS,
            ["identity", "source", "version"]
        );
        if (
            snapshot === null ||
            typeof snapshot.source !== "string" ||
            !Number.isSafeInteger(snapshot.version) ||
            (snapshot.version as number) < 0
        ) {
            return null;
        }
        return Object.freeze({
            identity: snapshot.identity,
            source: snapshot.source,
            version: snapshot.version as number,
        });
    } catch {
        return null;
    }
}

export function sameDocument(
    expected: DocumentSnapshot,
    current: DocumentSnapshot | null
): boolean {
    return current !== null &&
        current.identity === expected.identity &&
        current.version === expected.version &&
        current.source === expected.source;
}
