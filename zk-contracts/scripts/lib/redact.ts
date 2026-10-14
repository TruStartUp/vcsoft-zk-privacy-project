const SECRET_VARIABLES = [
  "DEPLOYER_PRIVATE_KEY",
  "PLATFORM_PRIVATE_KEY",
  "ETHERSCAN_API_KEY",
  "BASE_SEPOLIA_RPC_URL",
];

function secretValues(): string[] {
  const values = new Set<string>();
  for (const name of SECRET_VARIABLES) {
    const value = process.env[name]?.trim();
    if (!value || value.length < 8) continue;
    values.add(value);
    if (value.startsWith("0x")) values.add(value.slice(2));
    const lastSegment = value.split("/").pop();
    if (lastSegment && lastSegment.length >= 16) values.add(lastSegment);
  }
  return [...values].sort((a, b) => b.length - a.length);
}

export function redact(text: string): string {
  let result = text;
  for (const secret of secretValues()) result = result.split(secret).join("[redacted]");
  return result;
}

function guard(stream: NodeJS.WriteStream): void {
  const write = stream.write.bind(stream) as (...args: unknown[]) => boolean;
  stream.write = ((chunk: unknown, ...rest: unknown[]) =>
    write(typeof chunk === "string" ? redact(chunk) : Buffer.isBuffer(chunk) ? redact(chunk.toString()) : chunk, ...rest)) as typeof stream.write;
}

guard(process.stdout);
guard(process.stderr);
