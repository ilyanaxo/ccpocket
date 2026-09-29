import 'dart:convert';
import 'dart:io';

import 'package:ccpocket/models/machine.dart';
import 'package:ccpocket/models/ssh_host_key.dart';
import 'package:ccpocket/services/machine_manager_service.dart';
import 'package:ccpocket/services/ssh_bridge_tunnel_service.dart';
import 'package:ccpocket/services/ssh_host_key_verifier.dart';
import 'package:ccpocket/services/ssh_startup_service.dart';
import 'package:flutter_secure_storage/flutter_secure_storage.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:shared_preferences/shared_preferences.dart';

const _sshdPath = '/usr/sbin/sshd';

/// OpenSSH server run as the current user on 127.0.0.1, with a fresh host
/// key and one fresh client key. dartssh2 has no server mode, so only a real
/// sshd exercises the host key checks of the app's own `SSHClient`s.
class _TestSshd {
  final Directory _dir;
  final Process _process;
  final int port;
  final String username;
  final String clientPrivateKey;
  final SshHostKeyPin hostKey;
  final _log = <String>[];

  _TestSshd._(
    this._dir,
    this._process, {
    required this.port,
    required this.username,
    required this.clientPrivateKey,
    required this.hostKey,
  }) {
    _process.stderr
        .transform(utf8.decoder)
        .transform(const LineSplitter())
        .listen(_log.add);
    _process.stdout.drain<void>();
  }

  /// Logins that got past authentication so far.
  int get acceptedLogins =>
      _log.where((line) => line.contains('Accepted publickey')).length;

  static Future<_TestSshd> start() async {
    final dir = await Directory.systemTemp.createTemp('ccpocket_sshd');
    Future<void> keygen(String name) async {
      final result = await Process.run('ssh-keygen', [
        '-q',
        '-t',
        'ed25519',
        '-N',
        '',
        '-f',
        '${dir.path}/$name',
      ]);
      if (result.exitCode != 0) throw StateError('${result.stderr}');
    }

    await keygen('host_key');
    await keygen('client_key');
    await File('${dir.path}/client_key.pub')
        .copy('${dir.path}/authorized_keys');
    final fingerprint = await Process.run('ssh-keygen', [
      '-l',
      '-E',
      'sha256',
      '-f',
      '${dir.path}/host_key.pub',
    ]);
    final username = (await Process.run('id', ['-un'])).stdout as String;

    final probe = await ServerSocket.bind(InternetAddress.loopbackIPv4, 0);
    final port = probe.port;
    await probe.close();
    await File('${dir.path}/sshd_config').writeAsString('''
Port $port
ListenAddress 127.0.0.1
HostKey ${dir.path}/host_key
PidFile ${dir.path}/sshd.pid
AuthorizedKeysFile ${dir.path}/authorized_keys
UsePAM no
StrictModes no
PasswordAuthentication no
KbdInteractiveAuthentication no
PubkeyAuthentication yes
AllowTcpForwarding yes
''');
    final process = await Process.start(_sshdPath, [
      '-D',
      '-e',
      '-f',
      '${dir.path}/sshd_config',
    ]);
    final sshd = _TestSshd._(
      dir,
      process,
      port: port,
      username: username.trim(),
      clientPrivateKey: await File('${dir.path}/client_key').readAsString(),
      hostKey: SshHostKeyPin(
        type: 'ssh-ed25519',
        fingerprint: (fingerprint.stdout as String).split(' ')[1],
      ),
    );
    for (var attempt = 0; ; attempt++) {
      try {
        final socket = await Socket.connect(InternetAddress.loopbackIPv4, port);
        socket.destroy();
        return sshd;
      } on SocketException {
        if (attempt == 50) {
          await sshd.stop();
          throw StateError('sshd did not start: ${sshd._log.join('\n')}');
        }
        await Future<void>.delayed(const Duration(milliseconds: 100));
      }
    }
  }

  Future<void> stop() async {
    _process.kill();
    await _process.exitCode;
    await _dir.delete(recursive: true);
  }
}

Future<MachineManagerService> _createManager() async {
  SharedPreferences.setMockInitialValues({});
  FlutterSecureStorage.setMockInitialValues({});
  final manager = MachineManagerService(
    await SharedPreferences.getInstance(),
    const FlutterSecureStorage(),
  );
  addTearDown(manager.dispose);
  return manager;
}

/// The test binding stubs HttpClient, so talk HTTP over a raw socket.
Future<String> _health(String baseUrl) async {
  final uri = Uri.parse(baseUrl);
  final socket = await Socket.connect(uri.host, uri.port);
  socket.write('GET /health HTTP/1.0\r\nHost: localhost\r\n\r\n');
  final response = await utf8.decodeStream(socket);
  socket.destroy();
  return response.split('\r\n\r\n').last;
}

const _wrongKey = SshHostKeyPin(
  type: 'ssh-ed25519',
  fingerprint: 'SHA256:AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA',
);

void main() {
  final skip = Platform.isWindows || !File(_sshdPath).existsSync()
      ? 'needs $_sshdPath'
      : null;

  group('SSH host keys against a real sshd', skip: skip, () {
    late _TestSshd sshd;

    setUpAll(() async => sshd = await _TestSshd.start());
    tearDownAll(() => sshd.stop());

    group('Bridge tunnel', () {
      late HttpServer bridge;
      late MachineManagerService manager;
      late Machine machine;
      late SshBridgeTunnelService tunnels;

      setUp(() async {
        bridge = await HttpServer.bind(InternetAddress.loopbackIPv4, 0);
        bridge.listen((request) async {
          request.response.write(
            request.uri.path == '/version'
                ? jsonEncode({'version': '1.0.0'})
                : 'ok',
          );
          await request.response.close();
        });
        addTearDown(() => bridge.close(force: true));
        manager = await _createManager();
        await manager.addMachine(
          Machine(
            id: 'tunnel',
            host: '127.0.0.1',
            port: bridge.port,
            sshEnabled: true,
            sshUsername: sshd.username,
            sshAuthType: SshAuthType.privateKey,
            sshJumpHost: '127.0.0.1',
            sshJumpPort: sshd.port,
          ),
          sshPrivateKey: sshd.clientPrivateKey,
        );
        machine = manager.getMachine('tunnel')!;
        tunnels = SshBridgeTunnelService(
          manager,
          connectionTimeout: const Duration(seconds: 5),
        );
        addTearDown(tunnels.closeAll);
      });

      test('pins the jump host key on first use', () async {
        final logins = sshd.acceptedLogins;
        final baseUrl = await tunnels.buildHttpBaseUrl(machine);

        expect(await _health(baseUrl), 'ok');
        for (var i = 0; i < 20 && sshd.acceptedLogins == logins; i++) {
          await Future<void>.delayed(const Duration(milliseconds: 50));
        }
        expect(sshd.acceptedLogins, logins + 1, reason: 'the sshd log is read');
        expect(await manager.getSshHostKeys('tunnel'), {
          '127.0.0.1:${sshd.port}': sshd.hostKey,
        });
      });

      test('blocks a changed jump host key before logging in', () async {
        await manager.pinSshHostKey(
          'tunnel',
          '127.0.0.1:${sshd.port}',
          _wrongKey,
        );
        final logins = sshd.acceptedLogins;

        await expectLater(
          tunnels.buildWsUrl(machine),
          throwsA(
            isA<SshHostKeyMismatchException>().having(
              (e) => e.presented,
              'presented',
              sshd.hostKey,
            ),
          ),
        );
        await Future<void>.delayed(const Duration(milliseconds: 300));
        expect(sshd.acceptedLogins, logins, reason: 'no credentials sent');
      });
    });

    group('SSH startup gateway', () {
      const gateway = DartSshConnectionGateway(
        connectionTimeout: Duration(seconds: 5),
      );
      late MachineManagerService manager;

      setUp(() async => manager = await _createManager());

      Future<SshConnectionHandle> connect({SshJumpConfig? jump}) =>
          gateway.connect(
            // Through the jump host, the target is the same sshd under
            // another name, so it has a pin of its own.
            host: jump == null ? '127.0.0.1' : 'localhost',
            port: sshd.port,
            username: sshd.username,
            authType: SshAuthType.privateKey,
            privateKey: sshd.clientPrivateKey,
            jump: jump,
            hostKeyVerifier: SshHostKeyVerifier(manager, machineId: 'ssh'),
          );

      SshJumpConfig jumpHost() => SshJumpConfig(
        host: '127.0.0.1',
        port: sshd.port,
        username: sshd.username,
        authType: SshAuthType.privateKey,
        jumpPrivateKey: sshd.clientPrivateKey,
      );

      test('pins the host key of a direct connection', () async {
        (await connect()).close();

        expect(await manager.getSshHostKeys('ssh'), {
          '127.0.0.1:${sshd.port}': sshd.hostKey,
        });
      });

      test('blocks a changed host key of a direct connection', () async {
        await manager.pinSshHostKey('ssh', '127.0.0.1:${sshd.port}', _wrongKey);

        await expectLater(
          connect(),
          throwsA(isA<SshHostKeyMismatchException>()),
        );
      });

      test('pins the jump host and the target behind it', () async {
        (await connect(jump: jumpHost())).close();

        expect(await manager.getSshHostKeys('ssh'), {
          '127.0.0.1:${sshd.port}': sshd.hostKey,
          'localhost:${sshd.port}': sshd.hostKey,
        });
      });

      test('blocks a changed key of the target behind the jump host', () async {
        await manager.pinSshHostKey(
          'ssh',
          '127.0.0.1:${sshd.port}',
          sshd.hostKey,
        );
        await manager.pinSshHostKey('ssh', 'localhost:${sshd.port}', _wrongKey);

        await expectLater(
          connect(jump: jumpHost()),
          throwsA(
            isA<SshHostKeyMismatchException>().having(
              (e) => e.endpoint,
              'endpoint',
              'localhost:${sshd.port}',
            ),
          ),
        );
      });
    });
  });
}
