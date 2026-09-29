import 'package:ccpocket/features/session_list/widgets/ssh_host_key_mismatch_dialog.dart';
import 'package:ccpocket/l10n/app_localizations.dart';
import 'package:ccpocket/models/ssh_host_key.dart';
import 'package:ccpocket/theme/app_theme.dart';
import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';

const _mismatch = SshHostKeyMismatchException(
  endpoint: 'server.example.com:22',
  pinned: SshHostKeyPin(type: 'ssh-ed25519', fingerprint: 'SHA256:pinned'),
  presented: SshHostKeyPin(type: 'ssh-ed25519', fingerprint: 'SHA256:new'),
);

Future<void> _pump(
  WidgetTester tester, {
  Locale locale = const Locale('en'),
  VoidCallback? onOpenMachineSettings,
}) async {
  await tester.pumpWidget(
    MaterialApp(
      theme: AppTheme.lightTheme,
      locale: locale,
      localizationsDelegates: AppLocalizations.localizationsDelegates,
      supportedLocales: AppLocalizations.supportedLocales,
      home: Scaffold(
        body: SshHostKeyMismatchDialog(
          mismatch: _mismatch,
          onOpenMachineSettings: onOpenMachineSettings,
        ),
      ),
    ),
  );
  await tester.pumpAndSettle();
}

void main() {
  testWidgets('shows the endpoint with the pinned and presented keys', (
    tester,
  ) async {
    await _pump(tester);

    expect(find.text('SSH host key changed'), findsOneWidget);
    expect(find.textContaining('server.example.com:22'), findsOneWidget);
    expect(find.text('ssh-ed25519\nSHA256:pinned'), findsOneWidget);
    expect(find.text('ssh-ed25519\nSHA256:new'), findsOneWidget);
  });

  testWidgets('opens the machine settings to reset the pin', (tester) async {
    var opened = false;
    await _pump(tester, onOpenMachineSettings: () => opened = true);

    await tester.tap(
      find.byKey(const ValueKey('ssh_host_key_open_machine_settings_button')),
    );
    await tester.pumpAndSettle();

    expect(opened, isTrue);
  });

  testWidgets('is localized', (tester) async {
    await _pump(tester, locale: const Locale('ja'));

    expect(find.text('SSH ホスト鍵が変更されました'), findsOneWidget);
    expect(find.text('保存済みの鍵'), findsOneWidget);
    expect(find.text('提示された鍵'), findsOneWidget);
  });
}
