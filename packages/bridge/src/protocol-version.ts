export const BRIDGE_PROTOCOL_MIN_VERSION = 1;
export const BRIDGE_PROTOCOL_MAX_VERSION = 1;
export const LEGACY_PROTOCOL_VERSION = 1;

/**
 * Additive capabilities inside the negotiated protocol version, advertised in
 * `session_list.protocolCapabilities` and `/version.protocolCapabilities`.
 *
 * `provider_omp_v1`: the Bridge accepts `provider:"omp"` wherever a provider
 * is accepted, plus `thinkingLevel`, `providers[]` and `set_omp_model`, and
 * sends omp data to clients whose `client_capabilities.supportedProviders`
 * contains `"omp"` (docs/protocol-versioning.md).
 */
export const BRIDGE_PROTOCOL_CAPABILITIES = [
  "project_request_correlation_v1",
  "session_context_v1",
  "provider_omp_v1",
] as const;

export type BridgeProtocolCapability =
  (typeof BRIDGE_PROTOCOL_CAPABILITIES)[number];

export interface ProtocolRange {
  min: number;
  max: number;
}

export interface ClientProtocolDeclaration {
  protocolVersion?: number;
  minimumProtocolVersion?: number;
}

/**
 * Resolve the range advertised by a client.
 *
 * Clients released before range negotiation either sent a singular
 * `protocolVersion` or omitted protocol metadata entirely. Both forms are
 * treated as supporting exactly one protocol version.
 */
export function clientProtocolRange(
  declaration: ClientProtocolDeclaration,
): ProtocolRange {
  const max = declaration.protocolVersion ?? LEGACY_PROTOCOL_VERSION;
  const min = declaration.minimumProtocolVersion ?? max;
  return { min, max };
}

/** Select the highest protocol version supported by both peers. */
export function negotiateProtocolVersion(
  client: ProtocolRange,
  server: ProtocolRange = {
    min: BRIDGE_PROTOCOL_MIN_VERSION,
    max: BRIDGE_PROTOCOL_MAX_VERSION,
  },
): number | null {
  const lowerBound = Math.max(client.min, server.min);
  const upperBound = Math.min(client.max, server.max);
  return lowerBound <= upperBound ? upperBound : null;
}
