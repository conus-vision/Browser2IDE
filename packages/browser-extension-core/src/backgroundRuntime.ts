import {
  BackgroundInspectCoordinator,
  type BackgroundInspectApi,
} from "./backgroundInspectSession.js";
import {
  createBackgroundRouter,
  type BackgroundRouterSubscriptions,
  type BackgroundRuntimePort,
  type BackgroundTab,
} from "./backgroundRouter.js";
import {
  BrowserWindowLinkStore,
  type SessionStorage,
} from "./browserWindowLinkStore.js";
import { WindowConnectionCoordinator } from "./windowConnectionCoordinator.js";

export interface BackgroundRuntimeOptions extends BackgroundInspectApi {
  readonly expectedDevtoolsUrl: string;
  readonly expectedPanelUrl: string;
  readonly storage: SessionStorage;
  readonly getTab: (tabId: number) => Promise<BackgroundTab | undefined>;
  readonly subscribeRuntimeMessages: BackgroundRouterSubscriptions["subscribeRuntimeMessages"];
  readonly subscribeRuntimePorts: BackgroundRouterSubscriptions["subscribeRuntimePorts"];
  readonly subscribeWindowRemoved: BackgroundRouterSubscriptions["subscribeWindowRemoved"];
  readonly onError?: (error: unknown) => void;
}

export interface BackgroundRuntime {
  dispose(): void;
}

export function startBackgroundRuntime(
  options: BackgroundRuntimeOptions,
): BackgroundRuntime {
  const inspectCoordinator = new BackgroundInspectCoordinator({
    executeScript: options.executeScript,
    sendTabMessage: options.sendTabMessage,
  });
  const store = new BrowserWindowLinkStore(options.storage);
  const coordinator = new WindowConnectionCoordinator({ store });
  const router = createBackgroundRouter({
    expectedDevtoolsUrl: options.expectedDevtoolsUrl,
    expectedPanelUrl: options.expectedPanelUrl,
    getTab: options.getTab,
    coordinator,
    inspectCoordinator,
    subscriptions: {
      subscribeRuntimeMessages: options.subscribeRuntimeMessages,
      subscribeRuntimePorts: options.subscribeRuntimePorts,
      subscribeWindowRemoved: options.subscribeWindowRemoved,
    },
    onError: options.onError,
  });
  let disposed = false;

  return {
    dispose(): void {
      if (disposed) {
        return;
      }
      disposed = true;
      router.dispose();
      coordinator.dispose();
    },
  };
}

export type { BackgroundRuntimePort };
