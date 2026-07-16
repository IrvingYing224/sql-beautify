import type {
    LayoutDoc,
    PositiveColumns,
    PositiveLevels,
} from "../../src/core/layout/doc";

declare const columns: PositiveColumns;
declare const levels: PositiveLevels;

const rawLeaf: LayoutDoc = {
    kind: "leaf",
    leafId: 0,
    transform: "raw",
};

const valid: LayoutDoc = {
    kind: "group",
    mode: "auto",
    maxFlatWidth: columns,
    content: {
        kind: "concat",
        parts: [
            rawLeaf,
            { kind: "space", columns },
            { kind: "line", mode: "soft", flat: "space" },
            {
                kind: "indent",
                levels,
                content: { kind: "line", mode: "hard" },
            },
            {
                kind: "line-suffix",
                commentLeafId: 1,
                spacing: { kind: "pad-to-column", targetColumn: columns },
            },
        ],
    },
};

// @ts-expect-error arbitrary SQL text is not a LayoutDoc variant
const arbitraryText: LayoutDoc = { kind: "text", value: "DROP TABLE t" };
// @ts-expect-error verbatim requires canonical owner/trigger/range, not a naked span
const nakedSpan: LayoutDoc = { kind: "verbatim", span: { start: 0, end: 1 } };
// @ts-expect-error hard lines cannot carry a flat representation
const hardWithFlat: LayoutDoc = { kind: "line", mode: "hard", flat: "space" };
// @ts-expect-error soft lines require an explicit flat representation
const softWithoutFlat: LayoutDoc = { kind: "line", mode: "soft" };
// @ts-expect-error auto groups require relative maxFlatWidth
const autoWithoutWidth: LayoutDoc = { kind: "group", mode: "auto", content: rawLeaf };
const forcedWithWidth: LayoutDoc = {
    kind: "group",
    mode: "flat",
    // @ts-expect-error forced groups have no width field
    maxFlatWidth: columns,
    content: rawLeaf,
};
// @ts-expect-error ordinary numbers are not canonical positive-column brands
const unbrandedSpace: LayoutDoc = { kind: "space", columns: 1 };
const suffixWithContent: LayoutDoc = {
    kind: "line-suffix",
    commentLeafId: 1,
    spacing: null,
    // @ts-expect-error line suffix cannot contain an arbitrary child doc
    content: rawLeaf,
};

void valid;
void arbitraryText;
void nakedSpan;
void hardWithFlat;
void softWithoutFlat;
void autoWithoutWidth;
void forcedWithWidth;
void unbrandedSpace;
void suffixWithContent;
