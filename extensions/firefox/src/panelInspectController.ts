export class PanelInspectController {
  private tabId: number | undefined;
  public enabled = false;

  public constructor(
    private readonly sendMessage: (message: unknown) => Promise<unknown>,
  ) {}

  public setTabId(tabId: number): void {
    this.tabId = tabId;
  }

  public async setEnabled(enabled: boolean): Promise<void> {
    if (enabled === this.enabled) {
      return;
    }
    if (this.tabId === undefined) {
      throw new Error("No inspected tab is attached");
    }
    await this.sendMessage({
      type: enabled ? "enableInspectMode" : "disableInspectMode",
      tabId: this.tabId,
    });
    this.enabled = enabled;
  }

  public async disable(): Promise<void> {
    await this.setEnabled(false);
  }
}
