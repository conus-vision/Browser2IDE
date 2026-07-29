export interface DevtoolsPanelHandle {
  addShownListener(listener: () => void): void;
  removeShownListener(listener: () => void): void;
}

export interface DevtoolsRuntimeOptions {
  readonly inspectedTabId: number;
  readonly channelId: string;
  readonly sourceId: string;
  createPanel(
    title: string,
    icon: string,
    page: string,
  ): Promise<DevtoolsPanelHandle>;
  addRuntimeMessageListener(listener: (message: unknown) => void): () => void;
  sendRuntimeMessage(message: unknown): Promise<unknown>;
  readonly onError?: (error: unknown) => void;
}

export async function registerDevtoolsPanel(
  options: DevtoolsRuntimeOptions,
): Promise<{ dispose(): void }> {
  assertRegistrationOptions(options);
  const announce = async (): Promise<void> => {
    await options.sendRuntimeMessage({
      type: "browser2ide.registerDevtools",
      channel: options.channelId,
      tabId: options.inspectedTabId,
      sourceId: options.sourceId,
    });
  };
  const onShown = (): void => {
    void announce().catch((error) => reportError(options, error));
  };
  const removeRuntimeListener = options.addRuntimeMessageListener((message) => {
    if (isPanelReadyMessage(message, options.channelId)) {
      void announce().catch((error) => reportError(options, error));
    }
  });
  let panel: DevtoolsPanelHandle;
  try {
    panel = await options.createPanel(
      "Browser2IDE",
      "/dist/browser2ide.svg",
      `/dist/panel.html?channel=${encodeURIComponent(options.channelId)}`,
    );
    panel.addShownListener(onShown);
  } catch (error) {
    removeRuntimeListener();
    throw error;
  }

  try {
    await announce();
  } catch (error) {
    reportError(options, error);
  }

  let disposed = false;

  return {
    dispose() {
      if (disposed) {
        return;
      }
      disposed = true;
      panel.removeShownListener(onShown);
      removeRuntimeListener();
    },
  };
}

function assertRegistrationOptions(options: DevtoolsRuntimeOptions): void {
  if (
    !Number.isSafeInteger(options.inspectedTabId) ||
    options.inspectedTabId < 0 ||
    !isIdentifier(options.channelId) ||
    !isIdentifier(options.sourceId)
  ) {
    throw new Error("Invalid DevTools panel registration");
  }
}

function isPanelReadyMessage(value: unknown, channel: string): boolean {
  return (
    isRecord(value) &&
    Object.keys(value).length === 2 &&
    value.type === "browser2ide.panelReady" &&
    value.channel === channel
  );
}

function isIdentifier(value: string): boolean {
  return (
    typeof value === "string" &&
    value.length > 0 &&
    value.length <= 128 &&
    /^[A-Za-z0-9._-]+$/.test(value)
  );
}

function reportError(
  options: DevtoolsRuntimeOptions,
  error: unknown,
): void {
  try {
    options.onError?.(error);
  } catch {
    // Error reporting cannot break panel registration recovery.
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === "object");
}
