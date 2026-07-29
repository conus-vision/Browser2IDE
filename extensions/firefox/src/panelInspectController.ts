export class PanelInspectController {
  private tabId: number | undefined;
  private remoteDisablePending = false;
  private disableRequest: Promise<void> | undefined;
  public enabled = false;

  public constructor(
    private readonly sendMessage: (message: unknown) => Promise<unknown>,
  ) {}

  public setTabId(tabId: number): void {
    this.tabId = tabId;
  }

  public async setEnabled(enabled: boolean): Promise<void> {
    if (!enabled) {
      await this.disable();
      return;
    }
    if (enabled === this.enabled) {
      return;
    }
    if (this.tabId === undefined) {
      throw new Error("No inspected tab is attached");
    }
    if (this.disableRequest) {
      await this.disableRequest.catch(() => undefined);
    }
    await this.sendMessage({
      type: "enableInspectMode",
      tabId: this.tabId,
    });
    this.enabled = true;
    this.remoteDisablePending = false;
  }

  public async disable(): Promise<void> {
    if (!this.enabled && !this.remoteDisablePending) {
      return;
    }

    this.enabled = false;
    this.remoteDisablePending = true;
    if (this.disableRequest) {
      return this.disableRequest;
    }
    if (this.tabId === undefined) {
      throw new Error("No inspected tab is attached");
    }

    const request = this.sendMessage({
      type: "disableInspectMode",
      tabId: this.tabId,
    })
      .then(() => {
        this.remoteDisablePending = false;
      })
      .finally(() => {
        if (this.disableRequest === request) {
          this.disableRequest = undefined;
        }
      });
    this.disableRequest = request;
    return request;
  }
}
