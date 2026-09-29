import 'package:ccpocket/l10n/app_localizations.dart';
import 'package:ccpocket/widgets/rename_session_dialog.dart';
import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';

Future<void> _open(
  WidgetTester tester, {
  required bool allowClear,
  required ValueChanged<String?> onResult,
  String? currentName = 'Fix login',
}) async {
  await tester.pumpWidget(
    MaterialApp(
      localizationsDelegates: AppLocalizations.localizationsDelegates,
      supportedLocales: AppLocalizations.supportedLocales,
      locale: const Locale('en'),
      home: Scaffold(
        body: Builder(
          builder: (context) => ElevatedButton(
            onPressed: () async => onResult(
              await showRenameSessionDialog(
                context,
                currentName: currentName,
                allowClear: allowClear,
              ),
            ),
            child: const Text('Rename'),
          ),
        ),
      ),
    ),
  );
  await tester.tap(find.text('Rename'));
  await tester.pumpAndSettle();
}

void main() {
  testWidgets('clearing returns an empty name by default', (tester) async {
    String? result = 'unset';
    await _open(tester, allowClear: true, onResult: (value) => result = value);

    await tester.tap(find.byKey(const ValueKey('rename_session_clear_button')));
    await tester.pump();
    await tester.tap(find.byKey(const ValueKey('rename_session_save_button')));
    await tester.pumpAndSettle();

    expect(result, '');
  });

  testWidgets('without allowClear the name cannot be emptied', (tester) async {
    String? result = 'unset';
    await _open(tester, allowClear: false, onResult: (value) => result = value);

    expect(
      find.byKey(const ValueKey('rename_session_clear_button')),
      findsNothing,
    );
    await tester.enterText(
      find.byKey(const ValueKey('rename_session_field')),
      '   ',
    );
    await tester.pump();
    final save = tester.widget<FilledButton>(
      find.byKey(const ValueKey('rename_session_save_button')),
    );
    expect(save.onPressed, isNull);

    // Submitting from the keyboard does not close the dialog either.
    await tester.testTextInput.receiveAction(TextInputAction.done);
    await tester.pumpAndSettle();
    expect(find.byType(AlertDialog), findsOneWidget);
    expect(result, 'unset');

    await tester.enterText(
      find.byKey(const ValueKey('rename_session_field')),
      'Refactor auth',
    );
    await tester.pump();
    await tester.tap(find.byKey(const ValueKey('rename_session_save_button')));
    await tester.pumpAndSettle();
    expect(result, 'Refactor auth');
  });
}
