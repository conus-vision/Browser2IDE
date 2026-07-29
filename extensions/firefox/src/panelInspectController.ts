export class PanelInspectController {
  private tabId: number | undefined;
  private desiredEnabled = false;
  private remoteEnabled = false;
  private enableInFlight = false;
  private remoteDisablePending = false;
  private reconcileRequest: Promise<void> | undefined;
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
    if (this.tabId === undefined) {
      throw new Error("No inspected tab is attached");
    }

    this.desiredEnabled = true;
    this.enabled = true;
    await this.reconcile();
  }

  public async disable(): Promise<void> {
    this.desiredEnabled = false;
    this.enabled = false;
    if (
      this.remoteEnabled ||
      this.enableInFlight ||
      this.remoteDisablePending
    ) {
      this.remoteDisablePending = true;
    }
    await this.reconcile();
  }

  private reconcile(): Promise<void> {
    if (this.reconcileRequest) {
      return this.reconcileRequest;
    }

    const run = this.reconcileLoop();
    let tracked: Promise<void>;
    tracked = run.finally(() => {
      if (this.reconcileRequest === tracked) {
        this.reconcileRequest = undefined;
      }
    });
    this.reconcileRequest = tracked;
    return tracked;
  }

  private async reconcileLoop(): Promise<void> {
    while (true) {
      if (this.desiredEnabled) {
        if (this.remoteEnabled) {
          this.remoteDisablePending = false;
          return;
        }

        const tabId = this.requireTabId();
        this.enableInFlight = true;
        try {
          await this.sendMessage({ type: "enableInspectMode", tabId });
          this.remoteEnabled = true;
        } catch (error) {
          this.remoteEnabled = false;
          this.remoteDisablePending = false;
          if (this.desiredEnabled) {
            this.desiredEnabled = false;
            this.enabled = false;
          }
          throw error;
        } finally {
          this.enableInFlight = false;
        }

        if (!this.desiredEnabled) {
          this.remoteDisablePending = true;
        }
        continue;
      }

      if (!this.remoteEnabled && !this.remoteDisablePending) {
        return;
      }

      const tabId = this.requireTabId();
      try {
        await this.sendMessage({ type: "disableInspectMode", tabId });
        this.remoteEnabled = false;
        this.remoteDisablePending = false;
      } catch (error) {
        this.remoteDisablePending = true;
        throw error;
      }
    }
  }

  private requireTabId(): number {
    if (this.tabId === undefined) {
      throw new Error("No inspected tab is attached");
    }
    return this.tabId;
  }
}
