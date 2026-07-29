export interface DevtoolsPanelHandle {
  addShownListener(listener: () => void): void;
  removeShownListener(listener: () => void): void;
}

export interface DevtoolsRuntimeOptions {
  readonly inspectedTabId: number;
  readonly channelId: string;
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
  const panel = await options.createPanel(
    "Browser2IDE",
    "/dist/browser2ide.svg",
    `/dist/panel.html?channel=${encodeURIComponent(options.channelId)}`,
  );
  const announce = async (): Promise<void> => {
    await options.sendRuntimeMessage({
      type: "browser2ide.inspectedTab",
      channel: options.channelId,
      tabId: options.inspectedTabId,
    });
  };
  const onShown = (): void => {
    void announce().catch((error) => options.onError?.(error));
  };
  panel.addShownListener(onShown);
  const removeRuntimeListener = options.addRuntimeMessageListener((message) => {
    if (
      isRecord(message) &&
      message.type === "browser2ide.panelReady" &&
      message.channel === options.channelId
    ) {
      void announce().catch((error) => options.onError?.(error));
    }
  });

  return {
    dispose() {
      panel.removeShownListener(onShown);
      removeRuntimeListener();
    },
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === "object");
}
