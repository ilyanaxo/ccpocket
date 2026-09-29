import 'dart:convert';

import 'package:ccpocket/models/ssh_host_key.dart';
import 'package:ccpocket/services/machine_manager_service.dart';
import 'package:ccpocket/services/ssh_host_key_verifier.dart';
import 'package:dartssh2/dartssh2.dart';
import 'package:flutter_secure_storage/flutter_secure_storage.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:shared_preferences/shared_preferences.dart';

void main() {
  late MachineManagerService manager;

  setUp(() async {
    SharedPreferences.setMockInitialValues({});
    FlutterSecureStorage.setMockInitialValues({});
    manager = MachineManagerService(
      await SharedPreferences.getInstance(),
      const FlutterSecureStorage(),
    );
  });

  tearDown(() => manager.dispose());

  Future<bool> present(
    SshHostKeyVerifier verifier,
    String fingerprint, {
    String host = 'server.example.com',
    int port = 22,
    String type = 'ssh-ed25519',
  }) async =>
      await verifier.handlerFor(host, port)(type, utf8.encode(fingerprint));

  group('SshHostKeyVerifier', () {
    test('pins the first key per machine and host:port', () async {
      final verifier = SshHostKeyVerifier(manager, machineId: 'm1');

      expect(await present(verifier, 'SHA256:first'), isTrue);
      expect(await present(verifier, 'SHA256:other', port: 2222), isTrue);

      expect(await manager.getSshHostKeys('m1'), {
        'server.example.com:22': const SshHostKeyPin(
          type: 'ssh-ed25519',
          fingerprint: 'SHA256:first',
        ),
        'server.example.com:2222': const SshHostKeyPin(
          type: 'ssh-ed25519',
          fingerprint: 'SHA256:other',
        ),
      });
      expect(await manager.getSshHostKeys('m2'), isEmpty);
    });

    test('accepts the pinned key on later connections', () async {
      await present(SshHostKeyVerifier(manager, machineId: 'm1'), 'SHA256:a');

      final next = SshHostKeyVerifier(manager, machineId: 'm1');
      expect(await present(next, 'SHA256:a'), isTrue);
      expect(next.rejection, isNull);
    });

    test('rejects a changed fingerprint or key type', () async {
      await present(SshHostKeyVerifier(manager, machineId: 'm1'), 'SHA256:a');

      final changed = SshHostKeyVerifier(manager, machineId: 'm1');
      expect(await present(changed, 'SHA256:b'), isFalse);
      final mismatch = changed.rejection!;
      expect(mismatch.endpoint, 'server.example.com:22');
      expect(mismatch.pinned.fingerprint, 'SHA256:a');
      expect(mismatch.presented.fingerprint, 'SHA256:b');

      final otherType = SshHostKeyVerifier(manager, machineId: 'm1');
      expect(
        await present(otherType, 'SHA256:a', type: 'rsa-sha2-512'),
        isFalse,
      );

      // A rejection never replaces the pin.
      expect(
        (await manager.getSshHostKeys('m1'))['server.example.com:22'],
        const SshHostKeyPin(type: 'ssh-ed25519', fingerprint: 'SHA256:a'),
      );
    });

    test('turns the SSH error of a rejection into the mismatch', () async {
      await present(SshHostKeyVerifier(manager, machineId: 'm1'), 'SHA256:a');
      final verifier = SshHostKeyVerifier(manager, machineId: 'm1');
      await present(verifier, 'SHA256:b');

      expect(
        () => verifier.rethrowRejection(
          SSHAuthAbortError('Connection closed before authentication'),
          StackTrace.current,
        ),
        throwsA(isA<SshHostKeyMismatchException>()),
      );
      expect(
        () => SshHostKeyVerifier(
          manager,
          machineId: 'm1',
        ).rethrowRejection(StateError('other'), StackTrace.current),
        throwsStateError,
      );
    });

    test('checks without pinning when pinning new keys is off', () async {
      final verifier = SshHostKeyVerifier(
        manager,
        machineId: 'm1',
        pinNewKeys: false,
      );

      expect(await present(verifier, 'SHA256:a'), isTrue);
      expect(await manager.getSshHostKeys('m1'), isEmpty);
    });

    test('accepts any key for an unsaved machine', () async {
      final verifier = SshHostKeyVerifier(manager, machineId: null);

      expect(await present(verifier, 'SHA256:a'), isTrue);
      expect(await present(verifier, 'SHA256:b'), isTrue);
    });
  });

  group('MachineManagerService SSH host key pins', () {
    test('reset forgets one endpoint so the next key is pinned', () async {
      await present(SshHostKeyVerifier(manager, machineId: 'm1'), 'SHA256:a');
      await present(
        SshHostKeyVerifier(manager, machineId: 'm1'),
        'SHA256:jump',
        host: 'jump.example.com',
      );

      await manager.clearSshHostKey('m1', 'server.example.com:22');

      expect((await manager.getSshHostKeys('m1')).keys, [
        'jump.example.com:22',
      ]);
      final next = SshHostKeyVerifier(manager, machineId: 'm1');
      expect(await present(next, 'SHA256:replaced'), isTrue);
      expect(
        (await manager.getSshHostKeys(
          'm1',
        ))['server.example.com:22']?.fingerprint,
        'SHA256:replaced',
      );
    });

    test('deleting the machine deletes its pins', () async {
      await present(SshHostKeyVerifier(manager, machineId: 'm1'), 'SHA256:a');

      await manager.deleteMachine('m1');

      expect(await manager.getSshHostKeys('m1'), isEmpty);
    });
  });
}
