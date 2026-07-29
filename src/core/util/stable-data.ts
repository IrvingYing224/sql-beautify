import { isProxy } from "node:util/types";

const STABLE_FROZEN_ARRAY_CACHE = new WeakSet<object>();

/**
 * Hostile-object boundary for exact, ordinary frozen data records.
 *
 * This deliberately uses Node's proxy detector: reflective JavaScript checks
 * cannot distinguish a transparent Proxy from its target without invoking
 * attacker-controlled traps.
 */
export function hasExactFrozenDataShape(
    value: unknown,
    expectedKeys: readonly string[]
): value is Record<string, unknown> {
    if (
        typeof value !== "object" ||
        value === null ||
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

/** Exact dense frozen data-array proof shared by invariant boundaries. */
export function isStableFrozenDataArray(
    value: unknown
): value is readonly unknown[] {
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
