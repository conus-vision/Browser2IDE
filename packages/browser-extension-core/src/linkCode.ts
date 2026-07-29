export interface ParsedLinkCode {
  readonly value: string;
  readonly port: number;
  readonly pin: string;
  readonly url: string;
}

const LINK_CODE_PATTERN = /([0-9]{5})(?:[ -])?([0-9]{2})/;

export function parseLinkCode(value: string): ParsedLinkCode {
  const match = LINK_CODE_PATTERN.exec(value);
  if (!match || match[0] !== value) {
    throw new Error(
      "Link code must contain seven digits with an optional space or hyphen",
    );
  }

  const port = Number(match[1]);
  if (port < 10_000 || port > 65_535) {
    throw new Error("Link code port must be between 10000 and 65535");
  }

  const pin = match[2];
  return {
    value: `${match[1]}${pin}`,
    port,
    pin,
    url: `ws://127.0.0.1:${port}`,
  };
}
