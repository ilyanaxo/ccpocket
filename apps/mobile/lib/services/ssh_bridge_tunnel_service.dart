import 'dart:async';
import 'dart:io';
import 'dart:typed_data';

import 'package:dartssh2/dartssh2.dart';

import '../models/machine.dart';
import '../models/ssh_host_key.dart';
import 'machine_manager_service.dart';
import 'ssh_host_key_verifier.dart';

/// Opens an SSH connection to a jump host. The returned client authenticates
/// in the background; the caller awaits it with [SSHClient.ping].
typedef SshJumpClientConnector = Future<SSHClient> Function({
  required String host,
  required int port,
  required String username,
  required SshAuthType authType,
  required String? password,
  required String? privateKey,
  required SSHHostkeyVerifyHandler onVerifyHostKey,
});

/// A Bridge tunnel was closed, e.g. by a disconnect, while it was opening.
/// The attempt that opened it was superseded, so its tunnel is not kept.
class SshBridgeTunnelClosedException implements Exception {
  final String machineId;

  const SshBridgeTunnelClosedException(this.machineId);

  @override
  String toString() =>
      'The SSH tunnel of machine $machineId was closed while it was opening.';
}

/// Maintains local TCP forwards for Bridge HTTP/WebSocket traffic that must
/// traverse an SSH jump host.
class SshBridgeTunnelService {
  final MachineManagerService _machineManager;
  final Duration connectionTimeout;

  /// How often an open tunnel checks that its SSH connection still answers.
  /// dartssh2 never closes a connection whose peer stopped answering, e.g.
  /// after a network change, so without the check a Bridge WebSocket through
  /// the tunnel would look connected indefinitely.
  final Duration livenessInterval;

  /// How long a keepalive may go unanswered, while the jump host sends
  /// nothing else either, before the tunnel counts as dropped and is closed.
  /// Generous, because on a slow link the keepalive waits behind queued
  /// upload data and the server acknowledges that data only every megabyte.
  final Duration livenessTimeout;
  final void Function(String?)? debugLog;

  /// Replaces the SSH connection to the jump host, e.g. with a fake in tests.
  final SshJumpClientConnector? connectJumpClient;
  final Map<String, _BridgeTunnel> _tunnels = {};

  /// Tunnel being opened per machine. A start whose entry is removed or
  /// replaced meanwhile closes its tunnel instead of keeping it.
  final Map<String, _TunnelStart> _startingTunnels = {};

  /// Loopback port of each machine's tunnel, kept after the tunnel drops so a
  /// rebuilt tunnel keeps the URL that the Bridge connection uses.
  final Map<String, ({String signature, int port})> _localPorts = {};

  SshBridgeTunnelService(
    this._machineManager, {
    this.connectionTimeout = const Duration(seconds: 10),
    this.livenessInterval = const Duration(seconds: 15),
    this.livenessTimeout = const Duration(seconds: 30),
    this.debugLog,
    this.connectJumpClient,
  });

  Future<String> buildWsUrl(
    Machine machine, {
    String? password,
    Future<String?> Function()? promptForPassword,
  }) async {
    final tunnel = await _ensureTunnel(
      machine,
      password: password,
      promptForPassword: promptForPassword,
    );
    if (tunnel == null) return machine.wsUrl;
    return '${machine.useSsl ? 'wss' : 'ws'}://127.0.0.1:${tunnel.localPort}';
  }

  Future<String> buildHttpBaseUrl(
    Machine machine, {
    String? password,
    Future<String?> Function()? promptForPassword,
  }) async {
    final tunnel = await _ensureTunnel(
      machine,
      password: password,
      promptForPassword: promptForPassword,
    );
    if (tunnel == null) return machine.httpUrl;
    return '${machine.useSsl ? 'https' : 'http'}://127.0.0.1:${tunnel.localPort}';
  }

  /// Returns [url] routed through a live tunnel, for reconnecting a Bridge
  /// connection that used one.
  ///
  /// When [url] points at a tunnel of this service that has dropped since or
  /// does not answer a keepalive within [livenessTimeout], the tunnel is
  /// rebuilt with stored credentials, on the same loopback port when that
  /// port is still free. Other URLs are returned unchanged.
  Future<String> refreshWsUrl(String url) async {
    final uri = Uri.tryParse(url);
    if (uri == null || uri.host != InternetAddress.loopbackIPv4.address) {
      return url;
    }
    String? machineId;
    for (final entry in _localPorts.entries) {
      if (entry.value.port == uri.port) machineId = entry.key;
    }
    final machine = machineId == null
        ? null
        : _machineManager.getMachine(machineId);
    if (machine == null) return url;
    // The Bridge connection through the tunnel is gone already, so checking
    // the SSH connection costs nothing that is still in use.
    final tunnel = await _ensureTunnel(machine, verifyAlive: true);
    if (tunnel == null) return url;
    return uri.replace(port: tunnel.localPort).toString();
  }

  Future<void> closeForMachine(String machineId) async {
    _startingTunnels.remove(machineId);
    _localPorts.remove(machineId);
    final tunnel = _tunnels.remove(machineId);
    await tunnel?.close();
  }

  Future<void> closeAllExcept(String machineId) async {
    final machineIds = {
      ..._tunnels.keys,
      ..._startingTunnels.keys,
      ..._localPorts.keys,
    }.where((id) => id != machineId).toList();
    for (final id in machineIds) {
      await closeForMachine(id);
    }
  }

  Future<void> closeAll() async {
    final tunnels = _tunnels.values.toList();
    _tunnels.clear();
    _startingTunnels.clear();
    _localPorts.clear();
    for (final tunnel in tunnels) {
      await tunnel.close();
    }
  }

  /// The open tunnel of [machine], opened if needed; null without a jump
  /// host.
  ///
  /// With [verifyAlive], an open tunnel must first answer a keepalive.
  /// Otherwise it is reused as is: its periodic liveness check closes it once
  /// the SSH connection stops answering, and a stricter check here would tear
  /// down a slow link that uploads or the WebSocket still use.
  Future<_BridgeTunnel?> _ensureTunnel(
    Machine machine, {
    String? password,
    Future<String?> Function()? promptForPassword,
    bool verifyAlive = false,
  }) async {
    final jumpHost = machine.sshJumpHost?.trim();
    if (jumpHost == null || jumpHost.isEmpty) return null;
    if (machine.useSsl) {
      throw UnsupportedError(
        'SSH jump host Bridge tunneling does not support SSL machines yet',
      );
    }
    if (!machine.sshEnabled || machine.sshUsername?.trim().isEmpty != false) {
      throw StateError('SSH username is required for Bridge tunneling');
    }

    final signature = _tunnelSignature(machine);
    final existing = _tunnels[machine.id];
    if (existing != null &&
        existing.signature == signature &&
        (verifyAlive
            ? await existing.checkAlive(livenessTimeout)
            : existing.isOpen)) {
      return existing;
    }

    // Concurrent callers (a reconnect and a health check after a drop) share
    // one rebuild instead of racing for the loopback port.
    final starting = _startingTunnels[machine.id];
    if (starting != null && starting.signature == signature) {
      return starting.tunnel;
    }
    final start = _TunnelStart(signature);
    _startingTunnels[machine.id] = start;
    start.tunnel = _startTunnel(
      machine,
      start,
      jumpHost: jumpHost,
      password: password,
      promptForPassword: promptForPassword,
    );
    try {
      return await start.tunnel;
    } finally {
      if (identical(_startingTunnels[machine.id], start)) {
        _startingTunnels.remove(machine.id);
      }
    }
  }

  Future<_BridgeTunnel> _startTunnel(
    Machine machine,
    _TunnelStart start, {
    required String jumpHost,
    String? password,
    Future<String?> Function()? promptForPassword,
  }) async {
    final signature = start.signature;
    await _tunnels.remove(machine.id)?.close();

    final credentials = await _resolveJumpCredentials(
      machine,
      targetPassword: password,
      promptForPassword: promptForPassword,
    );
    final jumpUsername = machine.sshJumpUsername?.trim().isNotEmpty == true
        ? machine.sshJumpUsername!.trim()
        : machine.sshUsername!.trim();
    final hostKeyVerifier = SshHostKeyVerifier(
      _machineManager,
      machineId: machine.id,
    );
    final previousPort = _localPorts[machine.id];
    final activity = _JumpHostActivity();
    final _BridgeTunnel tunnel;
    try {
      tunnel = await _BridgeTunnel.start(
        machineId: machine.id,
        signature: signature,
        connectJumpClient: () =>
            (connectJumpClient ?? _openJumpClient(activity))(
              host: jumpHost,
              port: machine.sshJumpPort,
              username: jumpUsername,
              authType: credentials.authType,
              password: credentials.password,
              privateKey: credentials.privateKey,
              onVerifyHostKey: hostKeyVerifier.handlerFor(
                jumpHost,
                machine.sshJumpPort,
              ),
            ),
        hostKeyVerifier: hostKeyVerifier,
        targetHost: machine.host,
        targetPort: machine.port,
        preferredLocalPort: previousPort?.signature == signature
            ? previousPort!.port
            : null,
        connectionTimeout: connectionTimeout,
        livenessInterval: livenessInterval,
        livenessTimeout: livenessTimeout,
        activity: activity,
        onClosed: _handleTunnelClosed,
      );
    } on SshHostKeyMismatchException {
      // Also reached by automatic reconnects, whose caller knows no machine.
      _machineManager.reportSshHostKeyMismatch(machine.id);
      rethrow;
    }
    // A disconnect or a start with other settings superseded this one.
    if (!identical(_startingTunnels[machine.id], start)) {
      await tunnel.close();
      throw SshBridgeTunnelClosedException(machine.id);
    }
    _tunnels[machine.id] = tunnel;
    _localPorts[machine.id] = (signature: signature, port: tunnel.localPort);
    return tunnel;
  }

  void _handleTunnelClosed(_BridgeTunnel tunnel) {
    if (identical(_tunnels[tunnel.machineId], tunnel)) {
      _tunnels.remove(tunnel.machineId);
    }
  }

  /// Connects to the jump host over TCP and records in [activity] whenever
  /// it sends data.
  SshJumpClientConnector _openJumpClient(_JumpHostActivity activity) =>
      ({
        required host,
        required port,
        required username,
        required authType,
        required password,
        required privateKey,
        required onVerifyHostKey,
      }) async {
        final socket = _ActivitySshSocket(
          await SSHSocket.connect(host, port, timeout: connectionTimeout),
          activity,
        );
        try {
          return _createClient(
            socket,
            username: username,
            authType: authType,
            password: password,
            privateKey: privateKey,
            onVerifyHostKey: onVerifyHostKey,
          );
        } catch (_) {
          socket.destroy();
          rethrow;
        }
      };

  SSHClient _createClient(
    SSHSocket socket, {
    required String username,
    required SshAuthType authType,
    required String? password,
    required String? privateKey,
    required SSHHostkeyVerifyHandler onVerifyHostKey,
  }) {
    if (authType == SshAuthType.password) {
      if (password == null || password.isEmpty) {
        throw SSHAuthAbortError('Password required');
      }
      return SSHClient(
        socket,
        username: username,
        onPasswordRequest: () => password,
        onVerifyHostKey: onVerifyHostKey,
        printDebug: debugLog,
      );
    }

    if (privateKey == null || privateKey.isEmpty) {
      throw SSHAuthAbortError('Private key required');
    }
    return SSHClient(
      socket,
      username: username,
      identities: SSHKeyPair.fromPem(privateKey),
      onVerifyHostKey: onVerifyHostKey,
      printDebug: debugLog,
    );
  }

  Future<_JumpCredentials> _resolveJumpCredentials(
    Machine machine, {
    String? targetPassword,
    Future<String?> Function()? promptForPassword,
  }) async {
    if (machine.hasJumpCredentials) {
      if (machine.sshJumpAuthType == SshAuthType.password) {
        final password = await _readPassword(
          () => _machineManager.getSshJumpPassword(machine.id),
          providedPassword: null,
          promptForPassword: promptForPassword,
        );
        return _JumpCredentials(
          authType: SshAuthType.password,
          password: password,
        );
      }

      final privateKey = await _machineManager.getSshJumpPrivateKey(machine.id);
      if (privateKey == null || privateKey.isEmpty) {
        throw SSHAuthAbortError('Jump host private key required');
      }
      return _JumpCredentials(
        authType: SshAuthType.privateKey,
        privateKey: privateKey,
      );
    }

    if (machine.sshAuthType == SshAuthType.password) {
      final password = await _readPassword(
        () => _machineManager.getSshPassword(machine.id),
        providedPassword: targetPassword,
        promptForPassword: promptForPassword,
      );
      return _JumpCredentials(
        authType: SshAuthType.password,
        password: password,
      );
    }

    final privateKey = await _machineManager.getSshPrivateKey(machine.id);
    if (privateKey == null || privateKey.isEmpty) {
      throw SSHAuthAbortError('Private key required');
    }
    return _JumpCredentials(
      authType: SshAuthType.privateKey,
      privateKey: privateKey,
    );
  }

  Future<String> _readPassword(
    Future<String?> Function() readStoredPassword, {
    required String? providedPassword,
    Future<String?> Function()? promptForPassword,
  }) async {
    var password = providedPassword;
    password ??= await readStoredPassword();
    if ((password == null || password.isEmpty) && promptForPassword != null) {
      password = await promptForPassword();
    }
    if (password == null || password.isEmpty) {
      throw SSHAuthAbortError('Password required');
    }
    return password;
  }

  String _tunnelSignature(Machine machine) => [
    machine.id,
    machine.host,
    machine.port,
    machine.useSsl,
    machine.sshJumpHost,
    machine.sshJumpPort,
    machine.sshJumpUsername,
    machine.sshJumpAuthType.name,
    machine.hasJumpCredentials,
    machine.sshUsername,
    machine.sshAuthType.name,
  ].join('\n');
}

/// Counts the chunks of data a jump host sent on one SSH connection.
///
/// Any data shows the connection is alive, also while a keepalive reply is
/// still queued behind a download or an upload.
class _JumpHostActivity {
  int received = 0;
}

/// Passes an SSH connection through and counts incoming data in an
/// [_JumpHostActivity].
class _ActivitySshSocket implements SSHSocket {
  final SSHSocket _socket;
  final _JumpHostActivity _activity;

  _ActivitySshSocket(this._socket, this._activity);

  @override
  late final Stream<Uint8List> stream = _socket.stream.map((data) {
    _activity.received++;
    return data;
  });

  @override
  StreamSink<List<int>> get sink => _socket.sink;

  @override
  Future<void> get done => _socket.done;

  @override
  Future<void> close() => _socket.close();

  @override
  Future<void> flush() => _socket.flush();

  @override
  void destroy() => _socket.destroy();
}

/// A tunnel being opened for one machine with the settings in [signature].
class _TunnelStart {
  final String signature;
  late final Future<_BridgeTunnel> tunnel;

  _TunnelStart(this.signature);
}

class _JumpCredentials {
  final SshAuthType authType;
  final String? password;
  final String? privateKey;

  const _JumpCredentials({
    required this.authType,
    this.password,
    this.privateKey,
  });
}

class _BridgeTunnel {
  final String machineId;
  final String signature;
  final SSHClient _jumpClient;
  final ServerSocket _server;
  final StreamSubscription<Socket> _serverSubscription;
  final Set<Socket> _localSockets = {};
  final Set<SSHSocket> _remoteSockets = {};
  final _JumpHostActivity _activity;
  Timer? _livenessTimer;
  bool _checkingLiveness = false;
  bool _closed = false;

  _BridgeTunnel._({
    required this.machineId,
    required this.signature,
    required SSHClient jumpClient,
    required ServerSocket server,
    required StreamSubscription<Socket> serverSubscription,
    required _JumpHostActivity activity,
  }) : _jumpClient = jumpClient,
       _server = server,
       _serverSubscription = serverSubscription,
       _activity = activity;

  int get localPort => _server.port;

  static Future<_BridgeTunnel> start({
    required String machineId,
    required String signature,
    required Future<SSHClient> Function() connectJumpClient,
    required SshHostKeyVerifier hostKeyVerifier,
    required String targetHost,
    required int targetPort,
    required int? preferredLocalPort,
    required Duration connectionTimeout,
    required Duration livenessInterval,
    required Duration livenessTimeout,
    required _JumpHostActivity activity,
    required void Function(_BridgeTunnel tunnel) onClosed,
  }) async {
    final jumpClient = await connectJumpClient();
    try {
      try {
        await jumpClient.ping().timeout(connectionTimeout);
      } catch (error, stackTrace) {
        hostKeyVerifier.rethrowRejection(error, stackTrace);
      }
      final server = await _bindLoopback(preferredLocalPort);
      late final _BridgeTunnel tunnel;
      final subscription = server.listen((localSocket) async {
        tunnel._handleLocalSocket(
          localSocket,
          targetHost: targetHost,
          targetPort: targetPort,
          connectionTimeout: connectionTimeout,
        );
      });
      tunnel = _BridgeTunnel._(
        machineId: machineId,
        signature: signature,
        jumpClient: jumpClient,
        server: server,
        serverSubscription: subscription,
        activity: activity,
      );
      // The SSH connection ends on network loss or server restart. Release the
      // loopback port with it, so the tunnel is rebuilt instead of reused.
      unawaited(
        jumpClient.done.catchError((Object _) {}).whenComplete(() async {
          await tunnel.close();
          onClosed(tunnel);
        }),
      );
      tunnel._watchLiveness(livenessInterval, livenessTimeout);
      return tunnel;
    } catch (_) {
      jumpClient.close();
      rethrow;
    }
  }

  static Future<ServerSocket> _bindLoopback(int? preferredPort) async {
    if (preferredPort != null) {
      try {
        return await ServerSocket.bind(
          InternetAddress.loopbackIPv4,
          preferredPort,
        );
      } on SocketException {
        // Taken by another process meanwhile; the URL changes with the port.
      }
    }
    return ServerSocket.bind(InternetAddress.loopbackIPv4, 0);
  }

  /// Whether the tunnel and its SSH connection are open. A connection that
  /// died silently still counts as open until a keepalive fails.
  bool get isOpen => !_closed && !_jumpClient.isClosed;

  /// Whether the SSH connection is open and answers a keepalive. A
  /// connection that dropped without the socket noticing, e.g. after a
  /// network change, fails the keepalive and is closed. The reply may take
  /// longer than [timeout] as long as the jump host keeps sending other data.
  Future<bool> checkAlive(Duration timeout) async {
    if (!isOpen) return false;
    final reply = _jumpClient.ping();
    var received = _activity.received;
    while (true) {
      try {
        await reply.timeout(timeout);
        return true;
      } on TimeoutException {
        if (_activity.received == received) break;
        received = _activity.received;
      } catch (_) {
        break;
      }
    }
    await close();
    return false;
  }

  /// Checks the SSH connection every [interval] and closes the tunnel once a
  /// keepalive goes unanswered for [timeout] while the jump host sends
  /// nothing else. Closing ends the local sockets, so the Bridge WebSocket
  /// through the tunnel reports the drop.
  void _watchLiveness(Duration interval, Duration timeout) {
    _livenessTimer = Timer.periodic(interval, (_) async {
      if (_checkingLiveness) return;
      _checkingLiveness = true;
      try {
        await checkAlive(timeout);
      } finally {
        _checkingLiveness = false;
      }
    });
  }

  Future<void> _handleLocalSocket(
    Socket localSocket, {
    required String targetHost,
    required int targetPort,
    required Duration connectionTimeout,
  }) async {
    _localSockets.add(localSocket);

    try {
      final remoteSocket = await _jumpClient
          .forwardLocal(targetHost, targetPort)
          .timeout(connectionTimeout);
      _remoteSockets.add(remoteSocket);

      localSocket.listen(
        remoteSocket.sink.add,
        onError: remoteSocket.sink.addError,
        onDone: () => unawaited(remoteSocket.sink.close()),
        cancelOnError: true,
      );
      remoteSocket.stream.listen(
        (data) {
          _activity.received++;
          localSocket.add(data);
        },
        onError: localSocket.addError,
        onDone: () => unawaited(localSocket.close()),
        cancelOnError: true,
      );

      void removeSockets() {
        _localSockets.remove(localSocket);
        _remoteSockets.remove(remoteSocket);
      }

      unawaited(localSocket.done.whenComplete(removeSockets));
      unawaited(remoteSocket.done.whenComplete(removeSockets));
    } catch (_) {
      _localSockets.remove(localSocket);
      localSocket.destroy();
    }
  }

  Future<void> close() async {
    if (_closed) return;
    _closed = true;
    _livenessTimer?.cancel();
    await _serverSubscription.cancel();
    await _server.close();
    for (final socket in _localSockets.toList()) {
      socket.destroy();
    }
    for (final socket in _remoteSockets.toList()) {
      socket.destroy();
    }
    _jumpClient.close();
  }
}
