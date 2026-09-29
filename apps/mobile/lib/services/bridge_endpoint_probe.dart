import 'dart:convert';

import 'package:http/http.dart' as http;

import '../models/machine.dart';
import '../utils/network_endpoint.dart';
import 'bridge_http_auth.dart';

enum BridgeTransport { secure, standard }

class BridgeEndpointProbeResult {
  final BridgeTransport? transport;
  final Map<String, dynamic>? health;

  const BridgeEndpointProbeResult._({this.transport, this.health});

  const BridgeEndpointProbeResult.reachable(
    BridgeTransport this.transport,
    Map<String, dynamic> this.health,
  );

  const BridgeEndpointProbeResult.unreachable() : this._();

  bool get isReachable => transport != null;

  bool get useSsl => transport == BridgeTransport.secure;
}

typedef BridgeHealthRequest = Future<http.Response> Function(
  Uri uri,
  Duration timeout, {
  Map<String, String> headers,
});

/// Whether sending an API key requires explicit confirmation because the
/// automatically selected transport is not encrypted.
bool shouldConfirmAutomaticWsWithApiKey({
  required BridgeConnectionMode connectionMode,
  required bool useSsl,
  required bool usesEncryptedTunnel,
  required String? apiKey,
}) =>
    connectionMode == BridgeConnectionMode.automatic &&
    !useSsl &&
    !usesEncryptedTunnel &&
    apiKey?.trim().isNotEmpty == true;

/// Probes the Bridge health endpoint.
///
/// Automatic mode probes both transports and always prefers HTTPS when both
/// are available. An API key is only sent over HTTPS, so automatic mode never
/// exposes it on a plaintext probe before the user confirms WS.
class BridgeEndpointProbe {
  final BridgeHealthRequest _request;

  BridgeEndpointProbe({BridgeHealthRequest? request})
    : _request = request ?? _defaultRequest;

  Future<BridgeEndpointProbeResult> probe({
    required String host,
    required int port,
    required BridgeConnectionMode mode,
    Duration timeout = const Duration(seconds: 3),
    String? apiKey,
  }) async {
    switch (mode) {
      case BridgeConnectionMode.secureOnly:
        return _probeTransport(
          host,
          port,
          BridgeTransport.secure,
          timeout,
          apiKey,
        );
      case BridgeConnectionMode.standardOnly:
        return _probeTransport(
          host,
          port,
          BridgeTransport.standard,
          timeout,
          apiKey,
        );
      case BridgeConnectionMode.automatic:
        final attemptTimeout = Duration(
          milliseconds: (timeout.inMilliseconds ~/ 2).clamp(500, 3000),
        );
        final secure = await _probeTransport(
          host,
          port,
          BridgeTransport.secure,
          attemptTimeout,
          apiKey,
        );
        if (secure.isReachable) return secure;
        return _probeTransport(
          host,
          port,
          BridgeTransport.standard,
          attemptTimeout,
          apiKey,
        );
    }
  }

  Future<BridgeEndpointProbeResult> _probeTransport(
    String host,
    int port,
    BridgeTransport transport,
    Duration timeout,
    String? apiKey,
  ) async {
    final scheme = transport == BridgeTransport.secure ? 'https' : 'http';
    final origin = formatUriOrigin(scheme: scheme, host: host, port: port);
    final healthUri = Uri.parse('$origin/health');
    final auth = BridgeHttpAuth(
      baseUrl: origin,
      apiKey: transport == BridgeTransport.secure ? apiKey : null,
    );
    try {
      final response = await _request(
        healthUri,
        timeout,
        headers: auth.headersFor(healthUri),
      );
      if (response.statusCode != 200) {
        return const BridgeEndpointProbeResult.unreachable();
      }
      final body = jsonDecode(response.body);
      if (body is! Map<String, dynamic> || body['status'] != 'ok') {
        return const BridgeEndpointProbeResult.unreachable();
      }
      return BridgeEndpointProbeResult.reachable(transport, body);
    } catch (_) {
      return const BridgeEndpointProbeResult.unreachable();
    }
  }

  static Future<http.Response> _defaultRequest(
    Uri uri,
    Duration timeout, {
    Map<String, String> headers = const {},
  }) => http.get(uri, headers: headers).timeout(timeout);
}
