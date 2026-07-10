import type { SelectionSnapshot } from "@browser2ide/plugin-api";
import type { InspectMessage } from "@browser2ide/protocol";

export class SelectionStore {
  private value: SelectionSnapshot | undefined;

  public replace(message: InspectMessage): SelectionSnapshot {
    this.value = {
      sessionId: message.sessionId,
      messageId: message.messageId,
      targets: message.targets,
      context: message.context,
      metadata: message.metadata,
    };
    return this.value;
  }

  public current(): SelectionSnapshot | undefined {
    return this.value;
  }

  public clear(): void {
    this.value = undefined;
  }
}
