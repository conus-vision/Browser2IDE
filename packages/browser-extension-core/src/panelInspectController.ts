export class PanelInspectController {
  private desiredEnabled = false;
  private remoteEnabled = false;
  private enableInFlight = false;
  private remoteDisablePending = false;
  private reconcileRequest: Promise<void> | undefined;
  public enabled = false;

  public constructor(
    private readonly sendMessage: (message: unknown) => Promise<unknown>,
  ) {}

  public async setEnabled(enabled: boolean): Promise<void> {
    if (!enabled) {
      await this.disable();
      return;
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

  public handleTransportDisconnect(): void {
    this.desiredEnabled = false;
    this.enabled = false;
    this.remoteEnabled = false;
    this.remoteDisablePending = false;
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
        if (this.remoteEnabled && !this.remoteDisablePending) {
          return;
        }

        this.enableInFlight = true;
        try {
          await this.sendMessage({ type: "enableInspectMode" });
          this.remoteEnabled = true;
          this.remoteDisablePending = false;
        } catch (error) {
          this.remoteEnabled = false;
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

      try {
        await this.sendMessage({ type: "disableInspectMode" });
        this.remoteEnabled = false;
        this.remoteDisablePending = false;
      } catch (error) {
        this.remoteDisablePending = true;
        throw error;
      }
    }
  }

}
