import 'dart:async';
import 'dart:convert';
import 'dart:io';
import 'dart:typed_data';

import 'package:ccpocket/models/machine.dart';
import 'package:ccpocket/models/messages.dart';
import 'package:ccpocket/models/ssh_host_key.dart';
import 'package:ccpocket/services/bridge_service.dart';
import 'package:ccpocket/services/machine_manager_service.dart';
import 'package:ccpocket/services/ssh_bridge_tunnel_service.dart';
import 'package:dartssh2/dartssh2.dart';
import 'package:flutter_secure_storage/flutter_secure_storage.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:shared_preferences/shared_preferences.dart';

/// Forwarded channel backed by a direct TCP socket to the fake Bridge.
class _FakeForwardChannel implements SSHForwardChannel {
  final Socket _socket;

  _FakeForwardChannel(this._socket);

  @override
  Stream<Uint8List> get stream => _socket;

  @override
  StreamSink<List<int>> get sink => _socket;

  @override
  Future<void> get done => _socket.done;

  @override
  Future<void> close() => _socket.close();

  @override
  void destroy() => _socket.destroy();

  @override
  dynamic noSuchMethod(Invocation invocation) => super.noSuchMethod(invocation);
}

/// Jump host connection that forwards channels over local TCP sockets.
class _FakeJumpClient implements SSHClient {
  @override
  final SSHHostkeyVerifyHandler onVerifyHostKey;
  final String hostKeyFingerprint;
  final _done = Completer<void>();
  final _channels = <_FakeForwardChannel>[];
  bool _verified = false;

  /// Makes keepalives hang like on a connection that died silently.
  bool unresponsive = false;

  /// Delays keepalive answers like a slow but working link.
  Duration? pingDelay;

  _FakeJumpClient(this.onVerifyHostKey, this.hostKeyFingerprint);

  @override
  Future<void> get done => _done.future;

  @override
  bool get isClosed => _done.isCompleted;

  @override
  Future<void> ping() async {
    if (isClosed) throw SSHStateError('Connection closed');
    if (!_verified) {
      final accepted = await onVerifyHostKey(
        'ssh-ed25519',
        utf8.encode(hostKeyFingerprint),
      );
      if (!accepted) {
        close();
        throw SSHAuthAbortError('Connection closed before authentication');
      }
      _verified = true;
    }
    if (unresponsive) await Completer<void>().future;
    final delay = pingDelay;
    if (delay != null) await Future<void>.delayed(delay);
  }

  @override
  Future<SSHForwardChannel> forwardLocal(
    String remoteHost,
    int remotePort, {
    String localHost = 'localhost',
    int localPort = 0,
  }) async {
    if (isClosed) throw SSHStateError('Connection closed');
    final channel = _FakeForwardChannel(
      await Socket.connect(remoteHost, remotePort),
    );
    _channels.add(channel);
    return channel;
  }

  /// The connection drops, e.g. on a network change.
  void drop() => close();

  @override
  void close() {
    for (final channel in _channels) {
      channel.destroy();
    }
    if (!_done.isCompleted) _done.complete();
  }

  @override
  dynamic noSuchMethod(Invocation invocation) => super.noSuchMethod(invocation);
}

/// Stand-in Bridge that answers /health, streams /stream slowly and accepts
/// WebSocket clients.
class _FakeBridge {
  final HttpServer _server;
  int webSocketConnections = 0;

  /// `Authorization` header of the last HTTP request per path.
  final authorizations = <String, String?>{};

  _FakeBridge._(this._server) {
    _server.listen((request) async {
      if (WebSocketTransformer.isUpgradeRequest(request)) {
        webSocketConnections++;
        final socket = await WebSocketTransformer.upgrade(request);
        socket.add(jsonEncode({'type': 'session_list', 'sessions': []}));
        socket.listen((_) {});
        return;
      }
      authorizations[request.uri.path] = request.headers.value('authorization');
      if (request.uri.path == '/stream') {
        request.response.bufferOutput = false;
        for (var i = 0; i < 30; i++) {
          request.response.write('x');
          await request.response.flush();
          await Future<void>.delayed(const Duration(milliseconds: 50));
        }
        await request.response.close();
        return;
      }
      request.response
        ..statusCode = 200
        ..write(
          request.uri.path == '/version'
              ? jsonEncode({'version': '1.0.0'})
              : 'ok',
        );
      await request.response.close();
    });
  }

  static Future<_FakeBridge> start() async =>
      _FakeBridge._(await HttpServer.bind(InternetAddress.loopbackIPv4, 0));

  int get port => _server.port;

  Future<void> close() => _server.close(force: true);
}

void main() {
  late _FakeBridge bridgeServer;
  late MachineManagerService manager;
  late List<_FakeJumpClient> jumpClients;
  late Machine machine;
  var jumpHostFingerprint = 'SHA256:jump-host';

  /// Holds new jump host connections back until it completes.
  Future<void>? connectGate;

  SshBridgeTunnelService createTunnelService({
    Duration livenessInterval = const Duration(hours: 1),
  }) {
    final service = SshBridgeTunnelService(
      manager,
      connectionTimeout: const Duration(seconds: 2),
      livenessInterval: livenessInterval,
      livenessTimeout: const Duration(milliseconds: 200),
      connectJumpClient:
          ({
            required host,
            required port,
            required username,
            required authType,
            required password,
            required privateKey,
            required onVerifyHostKey,
          }) async {
            expect(host, 'jump.example.com');
            expect(privateKey, 'jump-private-key');
            await connectGate;
            final client = _FakeJumpClient(
              onVerifyHostKey,
              jumpHostFingerprint,
            );
            jumpClients.add(client);
            return client;
          },
    );
    addTearDown(service.closeAll);
    return service;
  }

  setUp(() async {
    SharedPreferences.setMockInitialValues({});
    FlutterSecureStorage.setMockInitialValues({});
    jumpHostFingerprint = 'SHA256:jump-host';
    connectGate = null;
    jumpClients = [];
    bridgeServer = await _FakeBridge.start();
    manager = MachineManagerService(
      await SharedPreferences.getInstance(),
      const FlutterSecureStorage(),
    );
    machine = Machine(
      id: 'tunnel',
      host: '127.0.0.1',
      port: bridgeServer.port,
      sshEnabled: true,
      sshUsername: 'ana',
      sshAuthType: SshAuthType.privateKey,
      sshJumpHost: 'jump.example.com',
    );
    await manager.addMachine(machine, sshPrivateKey: 'jump-private-key');
    machine = manager.getMachine('tunnel')!;
  });

  tearDown(() async {
    manager.dispose();
    await bridgeServer.close();
  });

  // The test binding stubs HttpClient, so talk HTTP over a raw socket.
  Future<String> health(String baseUrl) async {
    final uri = Uri.parse(baseUrl);
    final socket = await Socket.connect(uri.host, uri.port);
    socket.write('GET /health HTTP/1.0\r\nHost: localhost\r\n\r\n');
    final response = await utf8.decodeStream(socket);
    socket.destroy();
    return response.split('\r\n\r\n').last;
  }

  group('SshBridgeTunnelService liveness', () {
    test('rebuilds a tunnel whose SSH connection closed', () async {
      final tunnels = createTunnelService();
      final firstUrl = await tunnels.buildHttpBaseUrl(machine);
      expect(await health(firstUrl), 'ok');

      jumpClients.single.drop();
      await pumpEventQueue();

      final secondUrl = await tunnels.buildHttpBaseUrl(machine);
      expect(jumpClients, hasLength(2));
      expect(secondUrl, firstUrl, reason: 'the loopback port is reused');
      expect(await health(secondUrl), 'ok');
    });

    test('closes a tunnel that stops answering keepalives', () async {
      final tunnels = createTunnelService(
        livenessInterval: const Duration(milliseconds: 50),
      );
      final firstUrl = await tunnels.buildHttpBaseUrl(machine);
      jumpClients.single.unresponsive = true;

      await jumpClients.single.done.timeout(const Duration(seconds: 5));
      final secondUrl = await tunnels.buildHttpBaseUrl(machine);

      expect(jumpClients, hasLength(2));
      expect(await health(secondUrl), 'ok');
      expect(secondUrl, firstUrl, reason: 'the loopback port is reused');
    });

    test('traffic from the jump host stands in for a late keepalive', () async {
      final tunnels = createTunnelService(
        livenessInterval: const Duration(milliseconds: 50),
      );
      final baseUrl = Uri.parse(await tunnels.buildHttpBaseUrl(machine));
      // Each keepalive reply waits behind other traffic for longer than the
      // liveness timeout.
      jumpClients.single.pingDelay = const Duration(seconds: 1);

      // HTTP/1.1, so the chunks arrive one by one instead of at the end.
      final socket = await Socket.connect(baseUrl.host, baseUrl.port);
      addTearDown(socket.destroy);
      socket.write('GET /stream HTTP/1.1\r\nHost: localhost\r\n\r\n');
      final response = StringBuffer();
      int streamed() {
        final text = response.toString();
        final body = text.indexOf('\r\n\r\n');
        return body < 0 ? 0 : 'x'.allMatches(text.substring(body)).length;
      }

      await for (final chunk in utf8.decoder.bind(socket)) {
        response.write(chunk);
        if (streamed() == 30) break;
      }

      expect(streamed(), 30);
      expect(jumpClients, hasLength(1));
      expect(jumpClients.single.isClosed, isFalse);
    });

    test('a reconnect rebuilds a tunnel that stopped answering', () async {
      final tunnels = createTunnelService();
      final wsUrl = await tunnels.buildWsUrl(machine);
      jumpClients.single.unresponsive = true;

      expect(await tunnels.refreshWsUrl(wsUrl), wsUrl);

      expect(jumpClients, hasLength(2));
      expect(jumpClients.first.isClosed, isTrue);
      expect(await health(await tunnels.buildHttpBaseUrl(machine)), 'ok');
    });

    test('a slow keepalive leaves open connections alone', () async {
      final tunnels = createTunnelService();
      final baseUrl = Uri.parse(await tunnels.buildHttpBaseUrl(machine));
      final openConnection = await Socket.connect(baseUrl.host, baseUrl.port);
      addTearDown(openConnection.destroy);
      jumpClients.single.pingDelay = const Duration(milliseconds: 400);

      // Health checks and uploads resolve the tunnel while it is in use.
      await tunnels.buildHttpBaseUrl(machine);
      await tunnels.buildWsUrl(machine);

      openConnection.write('GET /health HTTP/1.0\r\nHost: localhost\r\n\r\n');
      final response = await utf8.decodeStream(openConnection);
      expect(response.split('\r\n\r\n').last, 'ok');
      expect(jumpClients, hasLength(1));
      expect(jumpClients.single.isClosed, isFalse);
    });

    test('reuses a live tunnel', () async {
      final tunnels = createTunnelService();
      final firstUrl = await tunnels.buildHttpBaseUrl(machine);

      expect(await tunnels.buildHttpBaseUrl(machine), firstUrl);
      expect(jumpClients, hasLength(1));
    });

    test('concurrent callers share one rebuild', () async {
      final tunnels = createTunnelService();
      await tunnels.buildHttpBaseUrl(machine);
      jumpClients.single.drop();
      await pumpEventQueue();

      final urls = await Future.wait([
        tunnels.buildHttpBaseUrl(machine),
        tunnels.buildWsUrl(machine),
      ]);

      expect(jumpClients, hasLength(2));
      expect(Uri.parse(urls[0]).port, Uri.parse(urls[1]).port);
    });

    test('BridgeService reconnects through a rebuilt tunnel', () async {
      final tunnels = createTunnelService();
      manager.configureBridgeTunnelResolvers(
        wsUrlResolver: tunnels.buildWsUrl,
        httpBaseUrlResolver: tunnels.buildHttpBaseUrl,
      );
      final bridge = BridgeService()
        ..resolveReconnectUrl = tunnels.refreshWsUrl;
      addTearDown(bridge.dispose);
      final states = <BridgeConnectionState>[];
      final stateSub = bridge.connectionStatus.listen(states.add);
      addTearDown(stateSub.cancel);

      final wsUrl = await manager.buildWsUrl('tunnel');
      bridge.connect(wsUrl);
      await bridge.connectionStatus
          .firstWhere((state) => state == BridgeConnectionState.connected)
          .timeout(const Duration(seconds: 5));

      jumpClients.single.drop();
      await bridge.connectionStatus
          .firstWhere((state) => state == BridgeConnectionState.reconnecting)
          .timeout(const Duration(seconds: 5));
      await bridge.connectionStatus
          .firstWhere((state) => state == BridgeConnectionState.connected)
          .timeout(const Duration(seconds: 10));

      expect(jumpClients, hasLength(2));
      expect(bridgeServer.webSocketConnections, 2);
      expect(bridge.lastUrl, wsUrl);
      expect(states.last, BridgeConnectionState.connected);
    });

    test('BridgeService reconnects when SSH stops answering', () async {
      final tunnels = createTunnelService(
        livenessInterval: const Duration(milliseconds: 100),
      );
      manager.configureBridgeTunnelResolvers(
        wsUrlResolver: tunnels.buildWsUrl,
        httpBaseUrlResolver: tunnels.buildHttpBaseUrl,
      );
      final bridge = BridgeService()
        ..resolveReconnectUrl = tunnels.refreshWsUrl;
      addTearDown(bridge.dispose);

      final wsUrl = await manager.buildWsUrl('tunnel');
      bridge.connect(wsUrl);
      await bridge.connectionStatus
          .firstWhere((state) => state == BridgeConnectionState.connected)
          .timeout(const Duration(seconds: 5));

      // The route to the server died silently: nothing but the tunnel's own
      // keepalives can notice, since the WebSocket has no ping.
      jumpClients.single.unresponsive = true;
      await bridge.connectionStatus
          .firstWhere((state) => state == BridgeConnectionState.reconnecting)
          .timeout(const Duration(seconds: 5));
      await bridge.connectionStatus
          .firstWhere((state) => state == BridgeConnectionState.connected)
          .timeout(const Duration(seconds: 10));

      expect(jumpClients, hasLength(2));
      expect(jumpClients.first.isClosed, isTrue);
      expect(bridgeServer.webSocketConnections, 2);
      expect(bridge.lastUrl, wsUrl);
    });

    test('closing while a tunnel opens does not keep the tunnel', () async {
      final tunnels = createTunnelService();
      final wsUrl = await tunnels.buildWsUrl(machine);
      jumpClients.single.drop();
      await pumpEventQueue();
      final gate = Completer<void>();
      connectGate = gate.future;

      final reconnect = tunnels.refreshWsUrl(wsUrl);
      await pumpEventQueue();
      await tunnels.closeAll();
      gate.complete();

      await expectLater(
        reconnect,
        throwsA(isA<SshBridgeTunnelClosedException>()),
      );
      expect(jumpClients, hasLength(2));
      expect(jumpClients.last.isClosed, isTrue);
      await expectLater(
        Socket.connect('127.0.0.1', Uri.parse(wsUrl).port),
        throwsA(isA<SocketException>()),
        reason: 'the loopback listener is closed',
      );

      connectGate = null;
      expect(await health(await tunnels.buildHttpBaseUrl(machine)), 'ok');
      expect(jumpClients, hasLength(3));
    });
  });

  test('status requests through the tunnel carry the API key', () async {
    await manager.updateMachine(machine, apiKey: 'bridge-secret');
    final tunnels = createTunnelService();
    manager.configureBridgeTunnelResolvers(
      wsUrlResolver: tunnels.buildWsUrl,
      httpBaseUrlResolver: tunnels.buildHttpBaseUrl,
    );
    bridgeServer.authorizations.clear();

    expect(await manager.checkHealth('tunnel'), MachineStatus.online);

    expect(bridgeServer.authorizations, {
      '/health': 'Bearer bridge-secret',
      '/version': 'Bearer bridge-secret',
    });
    expect(manager.machinesWithStatus.single.versionInfo?.version, '1.0.0');
  });

  group('SshBridgeTunnelService host keys', () {
    test('pins the jump host key on first use', () async {
      final tunnels = createTunnelService();

      await tunnels.buildWsUrl(machine);

      expect(await manager.getSshHostKeys('tunnel'), {
        'jump.example.com:22': const SshHostKeyPin(
          type: 'ssh-ed25519',
          fingerprint: 'SHA256:jump-host',
        ),
      });
    });

    test('blocks a changed jump host key', () async {
      await manager.pinSshHostKey(
        'tunnel',
        'jump.example.com:22',
        const SshHostKeyPin(type: 'ssh-ed25519', fingerprint: 'SHA256:old'),
      );
      final tunnels = createTunnelService();

      await expectLater(
        tunnels.buildWsUrl(machine),
        throwsA(
          isA<SshHostKeyMismatchException>()
              .having((e) => e.endpoint, 'endpoint', 'jump.example.com:22')
              .having((e) => e.pinned.fingerprint, 'pinned', 'SHA256:old')
              .having(
                (e) => e.presented.fingerprint,
                'presented',
                'SHA256:jump-host',
              ),
        ),
      );
      expect(jumpClients.single.isClosed, isTrue);
    });

    test('BridgeService stops reconnecting on a changed key', () async {
      final tunnels = createTunnelService();
      manager.configureBridgeTunnelResolvers(
        wsUrlResolver: tunnels.buildWsUrl,
        httpBaseUrlResolver: tunnels.buildHttpBaseUrl,
      );
      final bridge = BridgeService()
        ..resolveReconnectUrl = tunnels.refreshWsUrl;
      addTearDown(bridge.dispose);
      final states = <BridgeConnectionState>[];
      final stateSub = bridge.connectionStatus.listen(states.add);
      addTearDown(stateSub.cancel);
      bridge.connect(await manager.buildWsUrl('tunnel'));
      await bridge.connectionStatus
          .firstWhere((state) => state == BridgeConnectionState.connected)
          .timeout(const Duration(seconds: 5));
      final reported = bridge.sshHostKeyMismatches.first;

      jumpHostFingerprint = 'SHA256:attacker';
      jumpClients.single.drop();
      final mismatch = await reported.timeout(const Duration(seconds: 10));

      expect(mismatch.machineId, 'tunnel');
      expect(mismatch.presented.fingerprint, 'SHA256:attacker');
      expect(states.last, BridgeConnectionState.disconnected);
      expect(
        manager.machinesWithStatus.single.lastError,
        machineErrorSshHostKeyChanged,
      );

      bridge.ensureConnected();
      await pumpEventQueue();
      expect(jumpClients, hasLength(2), reason: 'no further SSH attempt');
      expect(states.last, BridgeConnectionState.disconnected);
    });

    test('machine health reports a changed jump host key', () async {
      await manager.pinSshHostKey(
        'tunnel',
        'jump.example.com:22',
        const SshHostKeyPin(type: 'ssh-ed25519', fingerprint: 'SHA256:old'),
      );
      final tunnels = createTunnelService();
      manager.configureBridgeTunnelResolvers(
        wsUrlResolver: tunnels.buildWsUrl,
        httpBaseUrlResolver: tunnels.buildHttpBaseUrl,
      );

      await manager.checkHealth('tunnel');

      expect(
        manager.machinesWithStatus.single.lastError,
        machineErrorSshHostKeyChanged,
      );
    });
  });
}
