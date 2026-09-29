import 'dart:convert';

import 'package:dartssh2/dartssh2.dart';

import '../models/ssh_host_key.dart';
import '../utils/network_endpoint.dart';
import 'machine_manager_service.dart';

/// Verifies the SSH host keys presented during one connection attempt.
///
/// The first key seen for a machine and `host:port` is pinned; later
/// connections must present the same key type and SHA-256 fingerprint.
/// A different key fails the connection, and [rethrowRejection] turns the
/// resulting SSH error into an [SshHostKeyMismatchException].
class SshHostKeyVerifier {
  final MachineManagerService _machineManager;

  /// Machine whose pins apply. Without a saved machine there is nothing to
  /// pin against, so every key is accepted.
  final String? machineId;

  /// Whether a key for an endpoint without a pin gets pinned. Tests of unsaved
  /// settings check existing pins only.
  final bool pinNewKeys;

  SshHostKeyMismatchException? _rejection;

  /// The host key rejected during this attempt, if any.
  SshHostKeyMismatchException? get rejection => _rejection;

  SshHostKeyVerifier(
    this._machineManager, {
    required this.machineId,
    this.pinNewKeys = true,
  });

  /// `onVerifyHostKey` handler for the SSH server at [host]:[port].
  SSHHostkeyVerifyHandler handlerFor(String host, int port) {
    final endpoint = endpointIdentityKey(host, port);
    return (type, fingerprint) async {
      final id = machineId;
      if (id == null || id.isEmpty) return true;
      final presented = SshHostKeyPin(
        type: type,
        fingerprint: utf8.decode(fingerprint),
      );
      final pinned = (await _machineManager.getSshHostKeys(id))[endpoint];
      if (pinned == null) {
        if (pinNewKeys) {
          await _machineManager.pinSshHostKey(id, endpoint, presented);
        }
        return true;
      }
      if (pinned == presented) return true;
      _rejection = SshHostKeyMismatchException(
        endpoint: endpoint,
        pinned: pinned,
        presented: presented,
        machineId: id,
      );
      return false;
    };
  }

  /// Throws the host key rejection behind a failed connection, or rethrows
  /// [error] when no key was rejected.
  Never rethrowRejection(Object error, StackTrace stackTrace) {
    final rejection = _rejection;
    if (rejection != null) throw rejection;
    Error.throwWithStackTrace(error, stackTrace);
  }
}
