declare module "node:util/types" {
    /** Node extension-host intrinsic used to reject transparent and revoked Proxies. */
    export function isProxy(value: unknown): boolean;
}
