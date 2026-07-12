import type { BridgeSnapshot } from "./bridgeManager.js";

export interface StatusBarItemLike {
  text: string;
  tooltip?: string | object;
  command?: string | object;
  show(): void;
  dispose(): void;
}

export interface StatusBarHost {
  primary: StatusBarItemLike;
  toggle: StatusBarItemLike;
}

const INVALID_LINK_CODE_MESSAGE =
  "Cannot display an invalid Browser2IDE link code";

export function formatVisibleLinkCode(port: number, pin: string): string {
  if (
    !Number.isInteger(port) ||
    port < 10_000 ||
    port > 65_535 ||
    !/^\d{2}$/.test(pin)
  ) {
    throw new Error(INVALID_LINK_CODE_MESSAGE);
  }

  return `${port} ${pin}`;
}

export class StatusBarController {
  private disposed = false;

  constructor(private readonly host: StatusBarHost) {
    host.primary.show();
    host.toggle.show();
  }

  render(snapshot: BridgeSnapshot): void {
    if (this.disposed) return;

    const { primary, toggle } = this.host;
    primary.command = undefined;
    primary.tooltip = tooltipFor(snapshot);
    toggle.command = undefined;
    toggle.tooltip = undefined;

    switch (snapshot.state) {
      case "running":
        primary.text = `$(radio-tower) Browser2IDE: ${formatVisibleLinkCode(
          snapshot.port ?? Number.NaN,
          snapshot.pin ?? "",
        )}`;
        primary.command = "browser2ide.copyLinkCode";
        toggle.text = "$(debug-stop)";
        toggle.tooltip = "Stop Browser2IDE";
        toggle.command = "browser2ide.stop";
        return;
      case "starting":
        primary.text = "$(radio-tower) Browser2IDE: Starting";
        toggle.text = "$(sync~spin)";
        return;
      case "stopping":
        primary.text = "$(radio-tower) Browser2IDE: Stopping";
        toggle.text = "$(sync~spin)";
        return;
      case "stopped":
      case "error":
        primary.text = "$(radio-tower) Browser2IDE: Offline";
        toggle.text = "$(play)";
        toggle.tooltip = "Start Browser2IDE";
        toggle.command = "browser2ide.start";
        return;
    }
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.host.primary.dispose();
    this.host.toggle.dispose();
  }
}

function tooltipFor(snapshot: BridgeSnapshot): string {
  const details = [`Browser2IDE state: ${snapshot.state}`];
  if (snapshot.url !== undefined) details.push(`URL: ${snapshot.url}`);
  if (snapshot.sessionId !== undefined) {
    details.push(`session: ${snapshot.sessionId}`);
  }
  if (snapshot.bridgeInstanceId !== undefined) {
    details.push(`instance: ${snapshot.bridgeInstanceId}`);
  }
  details.push(`Linked browser windows: ${snapshot.linkedBrowserCount}`);
  return details.join(" | ");
}
