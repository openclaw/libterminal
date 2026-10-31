export function concatenateBytes(
  chunks: readonly Uint8Array[],
  byteLength = chunks.reduce((total, chunk) => total + chunk.byteLength, 0),
): Uint8Array {
  if (chunks.length === 1) {
    return chunks[0];
  }
  const result = new Uint8Array(byteLength);
  let offset = 0;
  for (const chunk of chunks) {
    result.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return result;
}
