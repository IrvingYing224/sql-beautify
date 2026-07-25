import { isProxy } from "node:util/types";
import type { InvariantFailure } from "./invariant-types";
import type { LeafRange } from "./leaf-range";
import {
    fail,
    isFiniteNonNegInt,
    isLeafRange,
    isObject,
} from "./invariant-shared";

function validateSubRange(
    value: unknown,
    field: string,
    nodeId: number,
    owner: LeafRange | null,
    leavesLen: number,
    failures: InvariantFailure[]
): void {
    if (!isLeafRange(value)) {
        fail(failures, "INV_SHAPE", `${field} invalid on node ${nodeId}`, nodeId);
        return;
    }
    if (value.end > leavesLen) {
        fail(
            failures,
            "INV_OWNER_REFERENCE",
            `${field} out of global leaves on node ${nodeId}`,
            nodeId
        );
    }
    if (owner && (value.start < owner.start || value.end > owner.end)) {
        fail(
            failures,
            "INV_OWNER_REFERENCE",
            `${field} outside owner leafRange on node ${nodeId}`,
            nodeId
        );
    }
}

const STABLE_FROZEN_ARRAY_CACHE = new WeakSet<object>();
const MISSING_DATA_FIELD = Symbol("missing-data-field");

function hasExactFrozenDataShape(
    value: unknown,
    expectedKeys: readonly string[]
): value is Record<string, unknown> {
    if (
        !isObject(value) ||
        isProxy(value) ||
        Object.getPrototypeOf(value) !== Object.prototype ||
        !Object.isFrozen(value)
    ) {
        return false;
    }
    const keys = Reflect.ownKeys(value);
    if (
        keys.length !== expectedKeys.length ||
        keys.some((key) => typeof key !== "string" || !expectedKeys.includes(key))
    ) {
        return false;
    }
    for (const key of expectedKeys) {
        const descriptor = Object.getOwnPropertyDescriptor(value, key);
        if (
            descriptor === undefined ||
            !("value" in descriptor) ||
            descriptor.enumerable !== true ||
            descriptor.writable !== false ||
            descriptor.configurable !== false
        ) {
            return false;
        }
    }
    return true;
}

function isStableFrozenDataArray(value: unknown): value is readonly unknown[] {
    if (typeof value !== "object" || value === null || isProxy(value)) {
        return false;
    }
    if (STABLE_FROZEN_ARRAY_CACHE.has(value)) {
        return true;
    }
    if (!Array.isArray(value) || !Object.isFrozen(value)) {
        return false;
    }
    const keys = Reflect.ownKeys(value);
    if (keys.length !== value.length + 1 || keys[keys.length - 1] !== "length") {
        return false;
    }
    for (let index = 0; index < value.length; index++) {
        if (keys[index] !== String(index)) {
            return false;
        }
        const descriptor = Object.getOwnPropertyDescriptor(value, index);
        if (
            descriptor === undefined ||
            !("value" in descriptor) ||
            descriptor.enumerable !== true ||
            descriptor.writable !== false ||
            descriptor.configurable !== false
        ) {
            return false;
        }
    }
    const lengthDescriptor = Object.getOwnPropertyDescriptor(value, "length");
    const stable =
        lengthDescriptor !== undefined &&
        "value" in lengthDescriptor &&
        lengthDescriptor.value === value.length &&
        lengthDescriptor.enumerable === false &&
        lengthDescriptor.writable === false &&
        lengthDescriptor.configurable === false;
    if (stable) {
        STABLE_FROZEN_ARRAY_CACHE.add(value);
    }
    return stable;
}

function readRequiredDataField(
    raw: Record<string, unknown>,
    field: string,
    nodeId: number,
    failures: InvariantFailure[],
    trustedCanonicalShape = false
): unknown | typeof MISSING_DATA_FIELD {
    if (trustedCanonicalShape) {
        return raw[field];
    }
    const descriptor = Object.getOwnPropertyDescriptor(raw, field);
    if (descriptor === undefined || !("value" in descriptor)) {
        fail(
            failures,
            "INV_SHAPE",
            `${field} must be an own data property on node ${nodeId}`,
            nodeId
        );
        return MISSING_DATA_FIELD;
    }
    return descriptor.value;
}

function isStableFrozenRange(value: unknown): value is LeafRange {
    return (
        hasExactFrozenDataShape(value, ["start", "end"]) &&
        isFiniteNonNegInt(value.start) &&
        isFiniteNonNegInt(value.end) &&
        value.start <= value.end
    );
}

function leafIdInRange(leafId: number, range: LeafRange): boolean {
    return leafId >= range.start && leafId < range.end;
}

function rangeOverlapsRange(left: LeafRange, right: LeafRange): boolean {
    return left.start < right.end && right.start < left.end;
}

interface ChildIntervalIndex {
    readonly starts: readonly number[];
    readonly prefixMaximumEnds: readonly number[];
}

const DIRECT_CHILD_INTERVAL_INDEX = new WeakMap<object, ChildIntervalIndex>();
const SMALL_DIRECT_CHILD_SCAN_LIMIT = 8;

function buildChildIntervalIndex(
    directChildren: readonly Record<string, unknown>[]
): ChildIntervalIndex {
    const ranges: LeafRange[] = [];
    for (const child of directChildren) {
        if (isLeafRange(child.leafRange)) {
            ranges.push(child.leafRange);
        }
    }
    ranges.sort((left, right) => left.start - right.start || left.end - right.end);
    const starts = new Array<number>(ranges.length);
    const prefixMaximumEnds = new Array<number>(ranges.length);
    let maximumEnd = -1;
    for (let index = 0; index < ranges.length; index++) {
        const range = ranges[index]!;
        starts[index] = range.start;
        maximumEnd = Math.max(maximumEnd, range.end);
        prefixMaximumEnds[index] = maximumEnd;
    }
    return Object.freeze({
        starts: Object.freeze(starts),
        prefixMaximumEnds: Object.freeze(prefixMaximumEnds),
    });
}

function childIntervalIndex(
    directChildren: readonly Record<string, unknown>[]
): ChildIntervalIndex {
    const cached = DIRECT_CHILD_INTERVAL_INDEX.get(directChildren);
    if (cached !== undefined) {
        return cached;
    }
    const built = buildChildIntervalIndex(directChildren);
    if (Object.isFrozen(directChildren)) {
        DIRECT_CHILD_INTERVAL_INDEX.set(directChildren, built);
    }
    return built;
}

function lastStartBefore(
    starts: readonly number[],
    exclusiveEnd: number
): number {
    let low = 0;
    let high = starts.length - 1;
    let found = -1;
    while (low <= high) {
        const middle = low + Math.floor((high - low) / 2);
        if (starts[middle]! < exclusiveEnd) {
            found = middle;
            low = middle + 1;
        } else {
            high = middle - 1;
        }
    }
    return found;
}

function leafIdInAnyChild(
    leafId: number,
    directChildren: readonly Record<string, unknown>[]
): boolean {
    if (directChildren.length <= SMALL_DIRECT_CHILD_SCAN_LIMIT) {
        for (const child of directChildren) {
            if (
                isLeafRange(child.leafRange) &&
                leafIdInRange(leafId, child.leafRange)
            ) {
                return true;
            }
        }
        return false;
    }
    const index = childIntervalIndex(directChildren);
    const candidate = lastStartBefore(index.starts, leafId + 1);
    return (
        candidate >= 0 &&
        index.prefixMaximumEnds[candidate]! > leafId
    );
}

function rangeOverlapsAnyChild(
    range: LeafRange,
    directChildren: readonly Record<string, unknown>[]
): boolean {
    if (directChildren.length <= SMALL_DIRECT_CHILD_SCAN_LIMIT) {
        for (const child of directChildren) {
            if (
                isLeafRange(child.leafRange) &&
                rangeOverlapsRange(range, child.leafRange)
            ) {
                return true;
            }
        }
        return false;
    }
    const index = childIntervalIndex(directChildren);
    const candidate = lastStartBefore(index.starts, range.end);
    return (
        candidate >= 0 &&
        index.prefixMaximumEnds[candidate]! > range.start
    );
}


export {
    MISSING_DATA_FIELD,
    validateSubRange,
    hasExactFrozenDataShape,
    isStableFrozenDataArray,
    readRequiredDataField,
    isStableFrozenRange,
    leafIdInRange,
    rangeOverlapsRange,
    leafIdInAnyChild,
    rangeOverlapsAnyChild,
};
