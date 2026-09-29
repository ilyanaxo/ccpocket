import 'dart:convert';

/// SSH host key pinned for one endpoint of a machine.
class SshHostKeyPin {
  /// Host key algorithm, e.g. `ssh-ed25519`.
  final String type;

  /// OpenSSH-style SHA-256 fingerprint, e.g. `SHA256:47DEQpj8HBSa+/TImW+5JC…`.
  final String fingerprint;

  const SshHostKeyPin({required this.type, required this.fingerprint});

  static SshHostKeyPin? fromJson(Object? json) {
    if (json is! Map) return null;
    final type = json['type'];
    final fingerprint = json['fingerprint'];
    if (type is! String || fingerprint is! String) return null;
    return SshHostKeyPin(type: type, fingerprint: fingerprint);
  }

  Map<String, String> toJson() => {'type': type, 'fingerprint': fingerprint};

  @override
  bool operator ==(Object other) =>
      other is SshHostKeyPin &&
      other.type == type &&
      other.fingerprint == fingerprint;

  @override
  int get hashCode => Object.hash(type, fingerprint);

  @override
  String toString() => '$type $fingerprint';
}

/// Decodes the pins stored for one machine, keyed by `host:port`.
Map<String, SshHostKeyPin> decodeSshHostKeyPins(String? raw) {
  if (raw == null || raw.isEmpty) return {};
  try {
    final json = jsonDecode(raw);
    if (json is! Map) return {};
    return {
      for (final entry in json.entries)
        if (entry.key is String && SshHostKeyPin.fromJson(entry.value) != null)
          entry.key as String: SshHostKeyPin.fromJson(entry.value)!,
    };
  } on FormatException {
    return {};
  }
}

String encodeSshHostKeyPins(Map<String, SshHostKeyPin> pins) =>
    jsonEncode(pins.map((endpoint, pin) => MapEntry(endpoint, pin.toJson())));

/// An SSH server presented a host key other than the one pinned for it.
class SshHostKeyMismatchException implements Exception {
  /// Server endpoint as `host:port`.
  final String endpoint;
  final SshHostKeyPin pinned;
  final SshHostKeyPin presented;

  /// Machine whose pin blocked the connection, for callers that only see the
  /// exception, such as an automatic Bridge reconnect.
  final String? machineId;

  const SshHostKeyMismatchException({
    required this.endpoint,
    required this.pinned,
    required this.presented,
    this.machineId,
  });

  @override
  String toString() =>
      'The SSH host key of $endpoint changed and the connection was blocked. '
      'Pinned: $pinned. Presented: $presented. If the change is expected, '
      'reset the pinned key in the machine settings.';
}
