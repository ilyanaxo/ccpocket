import 'dart:convert';

import 'package:ccpocket/models/machine.dart';
import 'package:ccpocket/services/bridge_endpoint_probe.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:http/http.dart' as http;

void main() {
  group('shouldConfirmAutomaticWsWithApiKey', () {
    test('requires confirmation only for automatic plaintext credentials', () {
      expect(
        shouldConfirmAutomaticWsWithApiKey(
          connectionMode: BridgeConnectionMode.automatic,
          useSsl: false,
          usesEncryptedTunnel: false,
          apiKey: 'secret',
        ),
        isTrue,
      );
      expect(
        shouldConfirmAutomaticWsWithApiKey(
          connectionMode: BridgeConnectionMode.automatic,
          useSsl: true,
          usesEncryptedTunnel: false,
          apiKey: 'secret',
        ),
        isFalse,
      );
      expect(
        shouldConfirmAutomaticWsWithApiKey(
          connectionMode: BridgeConnectionMode.automatic,
          useSsl: false,
          usesEncryptedTunnel: true,
          apiKey: 'secret',
        ),
        isFalse,
      );
      expect(
        shouldConfirmAutomaticWsWithApiKey(
          connectionMode: BridgeConnectionMode.standardOnly,
          useSsl: false,
          usesEncryptedTunnel: false,
          apiKey: 'secret',
        ),
        isFalse,
      );
      expect(
        shouldConfirmAutomaticWsWithApiKey(
          connectionMode: BridgeConnectionMode.automatic,
          useSsl: false,
          usesEncryptedTunnel: false,
          apiKey: null,
        ),
        isFalse,
      );
    });
  });

  group('BridgeEndpointProbe', () {
    test('automatic prefers HTTPS when both transports are healthy', () async {
      final requested = <Uri>[];
      final probe = BridgeEndpointProbe(
        request: (uri, timeout, {headers = const {}}) async {
          requested.add(uri);
          return http.Response(jsonEncode({'status': 'ok'}), 200);
        },
      );

      final result = await probe.probe(
        host: 'bridge.example.com',
        port: 8765,
        mode: BridgeConnectionMode.automatic,
      );

      expect(result.isReachable, isTrue);
      expect(result.transport, BridgeTransport.secure);
      expect(requested.map((uri) => uri.scheme), ['https']);
    });

    test('automatic falls back to HTTP without sending credentials', () async {
      final requested = <Uri>[];
      final probe = BridgeEndpointProbe(
        request: (uri, timeout, {headers = const {}}) async {
          requested.add(uri);
          if (uri.scheme == 'https') throw Exception('TLS unavailable');
          return http.Response(jsonEncode({'status': 'ok'}), 200);
        },
      );

      final result = await probe.probe(
        host: '100.64.1.2',
        port: 8765,
        mode: BridgeConnectionMode.automatic,
      );

      expect(result.transport, BridgeTransport.standard);
      expect(requested, hasLength(2));
      expect(requested.every((uri) => uri.path == '/health'), isTrue);
      expect(requested.every((uri) => !uri.hasQuery), isTrue);
    });

    test('sends the API key over HTTPS only', () async {
      final sentHeaders = <String, Map<String, String>>{};
      final probe = BridgeEndpointProbe(
        request: (uri, timeout, {headers = const {}}) async {
          sentHeaders[uri.scheme] = headers;
          if (uri.scheme == 'https') throw Exception('TLS unavailable');
          return http.Response(jsonEncode({'status': 'ok'}), 200);
        },
      );

      final result = await probe.probe(
        host: '100.64.1.2',
        port: 8765,
        mode: BridgeConnectionMode.automatic,
        apiKey: 'secret',
      );

      expect(result.transport, BridgeTransport.standard);
      expect(sentHeaders['https'], {'Authorization': 'Bearer secret'});
      expect(sentHeaders['http'], isEmpty);
    });

    test('secure-only never probes or falls back to HTTP', () async {
      final requested = <Uri>[];
      final probe = BridgeEndpointProbe(
        request: (uri, timeout, {headers = const {}}) async {
          requested.add(uri);
          throw Exception('TLS unavailable');
        },
      );

      final result = await probe.probe(
        host: 'bridge.example.com',
        port: 8765,
        mode: BridgeConnectionMode.secureOnly,
      );

      expect(result.isReachable, isFalse);
      expect(requested.map((uri) => uri.scheme), ['https']);
    });
  });
}
