export const MANAGED_BRIDGE_PORT_START = 48_735;
export const MANAGED_BRIDGE_PORT_COUNT = 100;
export const MANAGED_BRIDGE_PORT_END =
  MANAGED_BRIDGE_PORT_START + MANAGED_BRIDGE_PORT_COUNT - 1;

export function isManagedBridgePort(value: unknown): value is number {
  return (
    typeof value === "number" &&
    Number.isSafeInteger(value) &&
    value >= MANAGED_BRIDGE_PORT_START &&
    value <= MANAGED_BRIDGE_PORT_END
  );
}
