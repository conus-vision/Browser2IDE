#!/usr/bin/env node
import { fileURLToPath } from "node:url";
import { createBridgeServer } from "./server.js";

interface CliOptions {
  host?: string;
  port?: number;
  sessionId?: string;
}

export function parseCliArgs(args: string[]): CliOptions {
  const options: CliOptions = {};

  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    const value = args[index + 1];

    if (arg === "--host" && value) {
      options.host = value;
      index += 1;
    } else if (arg === "--port" && value) {
      options.port = Number(value);
      index += 1;
    } else if (arg === "--session" && value) {
      options.sessionId = value;
      index += 1;
    }
  }

  return options;
}

export async function runCli(args = process.argv.slice(2)): Promise<void> {
  const options = parseCliArgs(args);
  const server = createBridgeServer({
    host: options.host,
    port: options.port,
    sessionId: options.sessionId,
  });

  await server.start();
  const pairing = server.createPairingCode();

  console.log(`Bridge URL: ${server.getUrl()}`);
  console.log(`Pairing code: ${pairing.code}`);
}

if (fileURLToPath(import.meta.url) === process.argv[1]) {
  runCli().catch((error: unknown) => {
    console.error(error);
    process.exitCode = 1;
  });
}
