/// Prisma's Bytes columns are typed as `Uint8Array<ArrayBuffer>`, which a Node
/// Buffer does not satisfy: its backing store is only known to be ArrayBufferLike.
/// One conversion point, so the distinction never leaks into the services.
export function toBytes(buffer: Buffer): Uint8Array<ArrayBuffer> {
  return new Uint8Array(buffer);
}

export function toBuffer(bytes: Uint8Array): Buffer {
  return Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength);
}
