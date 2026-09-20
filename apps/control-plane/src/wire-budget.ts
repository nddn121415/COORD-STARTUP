import { CoordError, maxPayloadBytes } from '@coord/protocol';
export function assertWireBudget(frame: unknown): void {
  if (Buffer.byteLength(JSON.stringify(frame), 'utf8') > maxPayloadBytes)
    throw new CoordError(
      'PAYLOAD_TOO_LARGE',
      'Coordination metadata exceeds the wire byte limit; reduce paths, text, or requested context.',
    );
}
/** Retain the newest records in bounded context/conflict arrays. Tell callers which
 * sections were truncated; no individual record is silently altered. */
export function boundResult(result: Record<string, any>): Record<string, any> {
  const envelope = () => ({
    type: 'response',
    request_id: '00000000-0000-0000-0000-000000000000',
    ok: true,
    result,
  });
  const arrays = Object.entries(result).filter(([, value]) => Array.isArray(value));
  const truncated = new Set<string>();
  while (Buffer.byteLength(JSON.stringify(envelope()), 'utf8') > maxPayloadBytes - 512) {
    const selected = arrays
      .filter(([, value]) => value.length)
      .sort(
        ([, a], [, b]) =>
          Buffer.byteLength(JSON.stringify(b)) - Buffer.byteLength(JSON.stringify(a)),
      )[0];
    if (!selected)
      throw new CoordError(
        'RESPONSE_TOO_LARGE',
        'Result exceeds the wire byte limit; reduce the metadata size.',
      );
    selected[1].pop();
    truncated.add(selected[0]);
    result.truncated_sections = [...truncated];
  }
  assertWireBudget(envelope());
  return result;
}
