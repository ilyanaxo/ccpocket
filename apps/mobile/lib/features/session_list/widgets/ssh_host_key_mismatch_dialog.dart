import 'package:flutter/material.dart';

import '../../../l10n/app_localizations.dart';
import '../../../models/ssh_host_key.dart';

/// Explains an SSH connection that was blocked because the server presented
/// a host key other than the pinned one.
class SshHostKeyMismatchDialog extends StatelessWidget {
  final SshHostKeyMismatchException mismatch;

  /// Opens the machine settings, where the pinned key can be reset.
  final VoidCallback? onOpenMachineSettings;

  const SshHostKeyMismatchDialog({
    super.key,
    required this.mismatch,
    this.onOpenMachineSettings,
  });

  @override
  Widget build(BuildContext context) {
    final l = AppLocalizations.of(context);
    final theme = Theme.of(context);
    final openMachineSettings = onOpenMachineSettings;
    return AlertDialog(
      key: const ValueKey('ssh_host_key_mismatch_dialog'),
      icon: Icon(Icons.gpp_bad_outlined, color: theme.colorScheme.error),
      title: Text(l.sshHostKeyChangedTitle),
      content: SingleChildScrollView(
        child: Column(
          mainAxisSize: MainAxisSize.min,
          crossAxisAlignment: CrossAxisAlignment.start,
          children: [
            Text(l.sshHostKeyChangedMessage(mismatch.endpoint)),
            const SizedBox(height: 12),
            SshHostKeyFingerprint(
              label: l.sshHostKeyPinned,
              pin: mismatch.pinned,
            ),
            const SizedBox(height: 8),
            SshHostKeyFingerprint(
              label: l.sshHostKeyPresented,
              pin: mismatch.presented,
            ),
            const SizedBox(height: 12),
            Text(
              l.sshHostKeyChangedResetHint,
              style: theme.textTheme.bodySmall?.copyWith(
                color: theme.colorScheme.onSurfaceVariant,
              ),
            ),
          ],
        ),
      ),
      actions: [
        TextButton(
          onPressed: () => Navigator.of(context).pop(),
          child: Text(MaterialLocalizations.of(context).closeButtonLabel),
        ),
        if (openMachineSettings != null)
          FilledButton(
            key: const ValueKey('ssh_host_key_open_machine_settings_button'),
            onPressed: () {
              Navigator.of(context).pop();
              openMachineSettings();
            },
            child: Text(l.sshHostKeyOpenMachineSettings),
          ),
      ],
    );
  }
}

/// A labelled host key type and SHA-256 fingerprint.
class SshHostKeyFingerprint extends StatelessWidget {
  final String label;
  final SshHostKeyPin pin;

  const SshHostKeyFingerprint({
    super.key,
    required this.label,
    required this.pin,
  });

  @override
  Widget build(BuildContext context) {
    final theme = Theme.of(context);
    return Column(
      crossAxisAlignment: CrossAxisAlignment.start,
      children: [
        Text(
          label,
          style: theme.textTheme.labelMedium?.copyWith(
            color: theme.colorScheme.onSurfaceVariant,
          ),
        ),
        const SizedBox(height: 2),
        SelectableText(
          '${pin.type}\n${pin.fingerprint}',
          style: theme.textTheme.bodySmall?.copyWith(fontFamily: 'monospace'),
        ),
      ],
    );
  }
}
