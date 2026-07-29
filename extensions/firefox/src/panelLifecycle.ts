export interface PanelLifecycleContext {
  readonly generation: number;
  isCurrent(): boolean;
}

type PanelLifecycleOperation = (
  context: PanelLifecycleContext,
) => Promise<void>;

export class PanelLifecycleCoordinator {
  private generation = 0;
  private queue = Promise.resolve();
  private pendingOperations = 0;
  private disposed = false;

  public constructor(private readonly onBusyChanged: () => void) {}

  public get busy(): boolean {
    return this.pendingOperations > 0;
  }

  public get isDisposed(): boolean {
    return this.disposed;
  }

  public start(operation: PanelLifecycleOperation): Promise<void> {
    if (this.disposed) {
      return Promise.resolve();
    }
    this.generation += 1;
    return this.enqueue(this.generation, operation);
  }

  public continue(
    generation: number,
    operation: PanelLifecycleOperation,
  ): Promise<void> {
    if (!this.isCurrent(generation)) {
      return Promise.resolve();
    }
    return this.enqueue(generation, operation);
  }

  public isCurrent(generation: number): boolean {
    return !this.disposed && generation === this.generation;
  }

  public dispose(): void {
    if (this.disposed) {
      return;
    }
    this.disposed = true;
    this.generation += 1;
    this.onBusyChanged();
  }

  private enqueue(
    generation: number,
    operation: PanelLifecycleOperation,
  ): Promise<void> {
    this.pendingOperations += 1;
    this.onBusyChanged();

    const context: PanelLifecycleContext = {
      generation,
      isCurrent: () => this.isCurrent(generation),
    };
    const result = this.queue.then(async () => {
      if (context.isCurrent()) {
        await operation(context);
      }
    });
    this.queue = result.catch(() => undefined);
    void result.then(
      () => this.finishOperation(),
      () => this.finishOperation(),
    );
    return result;
  }

  private finishOperation(): void {
    this.pendingOperations -= 1;
    this.onBusyChanged();
  }
}
