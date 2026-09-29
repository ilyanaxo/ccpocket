import 'dart:convert';
import 'dart:io';

import 'package:ccpocket/models/machine.dart';
import 'package:ccpocket/models/messages.dart';
import 'package:ccpocket/services/bridge_http_auth.dart';
import 'package:ccpocket/services/bridge_service.dart';
import 'package:ccpocket/services/machine_manager_service.dart';
import 'package:flutter_secure_storage/flutter_secure_storage.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:shared_preferences/shared_preferences.dart';

/// Records the `Authorization` header of each request it serves.
class _RecordingBridge {
  final HttpServer _server;
  final requests = <String, String?>{};

  _RecordingBridge._(this._server) {
    _server.listen((request) async {
      if (WebSocketTransformer.isUpgradeRequest(request)) {
        final socket = await WebSocketTransformer.upgrade(request);
        socket.add(jsonEncode({'type': 'session_list', 'sessions': []}));
        socket.listen((_) {});
        return;
      }
      requests['${request.method} ${request.uri.path}'] = request.headers.value(
        'authorization',
      );
      final response = request.response;
      switch (request.uri.path) {
        case '/health':
          response.write(jsonEncode({'status': 'ok'}));
        case '/version':
          response.write(jsonEncode({'version': '1.2.3'}));
        case '/api/gallery/upload':
          response.statusCode = 201;
          response.write(
            jsonEncode({
              'image': {
                'id': 'img-1',
                'url': '/api/gallery/img-1',
                'mimeType': 'image/png',
                'projectPath': '/tmp/project',
                'projectName': 'project',
                'addedAt': '2026-09-29T00:00:00Z',
                'sizeBytes': 1,
              },
            }),
          );
        default:
          response.write(jsonEncode({'deleted': true}));
      }
      await response.close();
    });
  }

  static Future<_RecordingBridge> start() async => _RecordingBridge._(
    await HttpServer.bind(InternetAddress.loopbackIPv4, 0),
  );

  int get port => _server.port;

  String get wsUrl => 'ws://127.0.0.1:$port';

  Future<void> close() => _server.close(force: true);
}

void main() {
  group('BridgeHttpAuth', () {
    const auth = BridgeHttpAuth(
      baseUrl: 'http://127.0.0.1:41000',
      apiKey: 'secret',
    );

    test('adds the Bearer header only for the Bridge origin', () {
      expect(auth.headersFor(Uri.parse('http://127.0.0.1:41000/version')), {
        'Authorization': 'Bearer secret',
      });
      for (final other in [
        'http://127.0.0.1:41001/version',
        'https://127.0.0.1:41000/version',
        'http://images.example.com/x.png',
      ]) {
        expect(auth.headersFor(Uri.parse(other)), isEmpty, reason: other);
      }
    });

    test('adds the token query parameter only for the Bridge origin', () {
      expect(
        auth.authorizeUrl('http://127.0.0.1:41000/images/abc'),
        'http://127.0.0.1:41000/images/abc?token=secret',
      );
      expect(
        auth.authorizeUrl('http://127.0.0.1:41000/api/media/x?v=2'),
        'http://127.0.0.1:41000/api/media/x?v=2&token=secret',
      );
      for (final other in [
        'https://cdn.example.com/generated.png',
        'http://127.0.0.1:41001/images/abc',
        'data:image/png;base64,AAAA',
      ]) {
        expect(auth.authorizeUrl(other), other, reason: other);
      }
    });

    test('image requests carry the key as header, on the web in the URL', () {
      const url = 'http://127.0.0.1:41000/api/gallery/img-1';
      final native = auth.imageRequest(url, web: false);
      expect(native.url, url);
      expect(native.headers, {'Authorization': 'Bearer secret'});

      final web = auth.imageRequest(url, web: true);
      expect(web.url, '$url?token=secret');
      expect(web.headers, isNull);

      final other = auth.imageRequest(
        'https://cdn.example.com/a.png',
        web: false,
      );
      expect(other.url, 'https://cdn.example.com/a.png');
      expect(other.headers, isNull);
    });

    test('adds nothing without an API key', () {
      const keyless = BridgeHttpAuth(
        baseUrl: 'http://127.0.0.1:41000',
        apiKey: '',
      );
      final uri = Uri.parse('http://127.0.0.1:41000/version');
      expect(keyless.headersFor(uri), isEmpty);
      expect(keyless.authorizeUrl(uri.toString()), uri.toString());
      expect(BridgeHttpAuth.none.headersFor(uri), isEmpty);
    });
  });

  group('BridgeService HTTP auth', () {
    late _RecordingBridge server;
    late BridgeService bridge;

    setUp(() async {
      SharedPreferences.setMockInitialValues({});
      server = await _RecordingBridge.start();
      bridge = BridgeService();
    });

    tearDown(() async {
      bridge.dispose();
      await server.close();
    });

    Future<void> connect(String url) async {
      bridge.connect(url);
      await bridge.connectionStatus
          .firstWhere((state) => state == BridgeConnectionState.connected)
          .timeout(const Duration(seconds: 5));
    }

    test(
      'publishes the connection key and withdraws it on disconnect',
      () async {
        await connect('${server.wsUrl}?token=secret');

        expect(bridge.apiKey, 'secret');
        expect(
          BridgeHttpAuth.current.baseUrl,
          'http://127.0.0.1:${server.port}',
        );
        expect(BridgeHttpAuth.current.apiKey, 'secret');

        bridge.disconnect();

        expect(BridgeHttpAuth.current.apiKey, isNull);
      },
    );

    test('gallery upload and delete send the API key header', () async {
      await connect('${server.wsUrl}?token=secret');

      final image = await bridge.uploadImageBase64(
        base64Data: 'AA==',
        mimeType: 'image/png',
        projectPath: '/tmp/project',
      );
      expect(image?.id, 'img-1');
      expect(await bridge.deleteGalleryImage('img-1'), isTrue);

      expect(server.requests, {
        'POST /api/gallery/upload': 'Bearer secret',
        'DELETE /api/gallery/img-1': 'Bearer secret',
      });
    });

    test('checkHealth sends the given API key', () async {
      expect(await BridgeService.checkHealth(server.wsUrl, apiKey: 'secret'), {
        'status': 'ok',
      });
      expect(server.requests['GET /health'], 'Bearer secret');

      await BridgeService.checkHealth(server.wsUrl);
      expect(server.requests['GET /health'], isNull);
    });
  });

  group('MachineManagerService status requests', () {
    late _RecordingBridge server;
    late MachineManagerService manager;

    setUp(() async {
      SharedPreferences.setMockInitialValues({});
      FlutterSecureStorage.setMockInitialValues({});
      server = await _RecordingBridge.start();
      manager = MachineManagerService(
        await SharedPreferences.getInstance(),
        const FlutterSecureStorage(),
      );
    });

    tearDown(() async {
      manager.dispose();
      await server.close();
    });

    test('an explicitly chosen transport carries the API key', () async {
      await manager.addMachine(
        Machine(
          id: 'standard',
          host: '127.0.0.1',
          port: server.port,
          connectionMode: BridgeConnectionMode.standardOnly,
        ),
        apiKey: 'secret',
      );

      expect(server.requests, {
        'GET /health': 'Bearer secret',
        'GET /version': 'Bearer secret',
      });
      expect(manager.machinesWithStatus.single.versionInfo?.version, '1.2.3');
    });

    test(
      'an automatically found plaintext transport withholds the key',
      () async {
        await manager.addMachine(
          Machine(id: 'automatic', host: '127.0.0.1', port: server.port),
          apiKey: 'secret',
        );

        expect(manager.getMachine('automatic')!.useSsl, isFalse);
        expect(manager.machinesWithStatus.single.status, MachineStatus.online);
        expect(server.requests, {'GET /health': null, 'GET /version': null});
      },
    );

    test('the confirmed key of the Bridge connection is reused', () async {
      await manager.addMachine(
        Machine(id: 'automatic', host: '127.0.0.1', port: server.port),
        apiKey: 'secret',
      );
      // Connecting over automatically found WS happens after the user
      // confirmed sending the key.
      final bridge = BridgeService();
      addTearDown(bridge.dispose);
      bridge.connect('${server.wsUrl}?token=secret');
      await bridge.connectionStatus
          .firstWhere((state) => state == BridgeConnectionState.connected)
          .timeout(const Duration(seconds: 5));
      server.requests.clear();

      await manager.checkHealth('automatic');

      // The reachability probe stays keyless; /health answers without a key.
      expect(server.requests, {
        'GET /health': null,
        'GET /version': 'Bearer secret',
      });
      expect(manager.machinesWithStatus.single.versionInfo?.version, '1.2.3');
    });

    test('a connection to another Bridge lends no key', () async {
      BridgeHttpAuth.current = const BridgeHttpAuth(
        baseUrl: 'http://127.0.0.1:1',
        apiKey: 'other-secret',
      );
      addTearDown(() => BridgeHttpAuth.current = BridgeHttpAuth.none);
      await manager.addMachine(
        Machine(id: 'automatic', host: '127.0.0.1', port: server.port),
        apiKey: 'secret',
      );

      expect(server.requests, {'GET /health': null, 'GET /version': null});
    });
  });
}
