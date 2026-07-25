import { isProxy } from "node:util/types";

export function snapshotDataProperties(
    value: unknown,
    allowedKeys: ReadonlySet<string>,
    requiredKeys: readonly string[]
): Readonly<Record<string, unknown>> | null {
    try {
        if (
            typeof value !== "object" ||
            value === null ||
            isProxy(value) ||
            Array.isArray(value)
        ) {
            return null;
        }
        const prototype = Object.getPrototypeOf(value);
        if (prototype !== Object.prototype && prototype !== null) {
            return null;
        }
        const properties: Record<string, unknown> = Object.create(null) as Record<
            string,
            unknown
        >;
        for (const key of Reflect.ownKeys(value)) {
            if (typeof key !== "string" || !allowedKeys.has(key)) {
                return null;
            }
            const descriptor = Object.getOwnPropertyDescriptor(value, key);
            if (
                descriptor === undefined ||
                descriptor.enumerable !== true ||
                !("value" in descriptor)
            ) {
                return null;
            }
            properties[key] = descriptor.value;
        }
        for (const key of requiredKeys) {
            if (!Object.prototype.hasOwnProperty.call(properties, key)) {
                return null;
            }
        }
        return properties;
    } catch {
        return null;
    }
}

export function snapshotDenseDataArray(value: unknown): readonly unknown[] | null {
    try {
        if (
            typeof value !== "object" ||
            value === null ||
            isProxy(value) ||
            !Array.isArray(value)
        ) {
            return null;
        }
        const lengthDescriptor = Object.getOwnPropertyDescriptor(value, "length");
        if (
            lengthDescriptor === undefined ||
            !("value" in lengthDescriptor) ||
            !Number.isSafeInteger(lengthDescriptor.value) ||
            lengthDescriptor.value < 0
        ) {
            return null;
        }
        const length = lengthDescriptor.value as number;
        if (Reflect.ownKeys(value).length !== length + 1) {
            return null;
        }
        const result: unknown[] = [];
        for (let index = 0; index < length; index++) {
            const descriptor = Object.getOwnPropertyDescriptor(value, String(index));
            if (
                descriptor === undefined ||
                descriptor.enumerable !== true ||
                !("value" in descriptor)
            ) {
                return null;
            }
            result.push(descriptor.value);
        }
        return Object.freeze(result);
    } catch {
        return null;
    }
}
