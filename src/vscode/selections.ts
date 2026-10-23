import type * as vscode from "vscode";

import type { EditSelection, EditTarget } from "../edits/types";

/**
 * The targets a command formats: each non-empty selection, or the whole document when every
 * selection is empty. Each selection names the target that contains it, if any.
 */
export function selectionTargets(editor: vscode.TextEditor): {
    readonly targets: readonly EditTarget[];
    readonly selections: readonly EditSelection[];
} {
    const document = editor.document;
    const records = editor.selections.map((selection) => {
        const anchor = document.offsetAt(selection.anchor);
        const active = document.offsetAt(selection.active);
        return { anchor, active, start: Math.min(anchor, active), end: Math.max(anchor, active) };
    });
    const ranges = records.filter((record) => record.start !== record.end);
    if (ranges.length === 0) {
        return {
            targets: [{ id: "document", start: 0, end: document.getText().length, mode: "document" }],
            selections: records.map((record) => ({ targetId: "document", anchor: record.anchor, active: record.active })),
        };
    }
    const targets: EditTarget[] = ranges
        .map((record, index) => ({ id: `selection:${String(index)}`, start: record.start, end: record.end, mode: "fragment" as const }))
        .sort((left, right) => left.start - right.start || left.end - right.end);
    return {
        targets,
        selections: records.map((record) => ({
            targetId: targets.find((target) => target.start <= record.start && record.end <= target.end)?.id ?? null,
            anchor: record.anchor,
            active: record.active,
        })),
    };
}
