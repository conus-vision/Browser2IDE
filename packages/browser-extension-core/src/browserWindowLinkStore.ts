import { z } from "zod";

export interface BrowserWindowLink {
  readonly url: string;
  readonly port: number;
  readonly sessionId: string;
  readonly bridgeInstanceId: string;
  readonly authToken: string;
}

export interface SessionStorage {
  get(key: string): Promise<Record<string, unknown>>;
  set(values: Record<string, unknown>): Promise<void>;
  remove(key: string): Promise<void>;
}

const browserWindowIdSchema = z.number().int().nonnegative().safe();
const browserWindowLinkSchema = z
  .object({
    url: z.string(),
    port: z.number().int().min(10_000).max(65_535),
    sessionId: z.string().min(1),
    bridgeInstanceId: z.string().uuid(),
    authToken: z.string().min(32),
  })
  .strict()
  .refine(({ url, port }) => url === loopbackUrl(port), {
    message: "URL must be the loopback endpoint for the saved port",
    path: ["url"],
  });

export class BrowserWindowLinkStore {
  public constructor(private readonly storage: SessionStorage) {}

  public async load(windowId: number): Promise<BrowserWindowLink | undefined> {
    const key = storageKey(windowId);
    const stored = await this.storage.get(key);
    const value = stored[key];
    if (value === undefined) {
      return undefined;
    }

    const parsed = browserWindowLinkSchema.safeParse(value);
    if (!parsed.success) {
      await this.storage.remove(key);
      return undefined;
    }
    return parsed.data;
  }

  public async save(windowId: number, link: BrowserWindowLink): Promise<void> {
    const key = storageKey(windowId);
    const parsed = browserWindowLinkSchema.parse(link);
    await this.storage.set({ [key]: parsed });
  }

  public async remove(windowId: number): Promise<void> {
    await this.storage.remove(storageKey(windowId));
  }
}

function storageKey(windowId: number): string {
  return `browser2ide.windowLink.${browserWindowIdSchema.parse(windowId)}`;
}

function loopbackUrl(port: number): string {
  return `ws://127.0.0.1:${port}`;
}
