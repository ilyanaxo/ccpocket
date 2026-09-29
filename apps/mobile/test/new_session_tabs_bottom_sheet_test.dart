import 'package:ccpocket/features/settings/widgets/new_session_tabs_bottom_sheet.dart';
import 'package:ccpocket/l10n/app_localizations.dart';
import 'package:ccpocket/models/new_session_tab.dart';
import 'package:ccpocket/theme/app_theme.dart';
import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';

Future<void> _open(
  WidgetTester tester, {
  required List<NewSessionTab> current,
  required bool offerOmp,
  required ValueChanged<List<NewSessionTab>> onChanged,
}) async {
  await tester.pumpWidget(
    MaterialApp(
      localizationsDelegates: AppLocalizations.localizationsDelegates,
      supportedLocales: AppLocalizations.supportedLocales,
      locale: const Locale('en'),
      theme: AppTheme.darkTheme,
      home: Scaffold(
        body: Builder(
          builder: (context) => ElevatedButton(
            onPressed: () => showNewSessionTabsBottomSheet(
              context: context,
              current: current,
              offerOmp: offerOmp,
              onChanged: onChanged,
            ),
            child: const Text('Tabs'),
          ),
        ),
      ),
    ),
  );
  await tester.tap(find.text('Tabs'));
  await tester.pumpAndSettle();
}

void main() {
  testWidgets('hides omp without Bridge support and keeps its state', (
    tester,
  ) async {
    List<NewSessionTab>? saved;
    await _open(
      tester,
      current: const [
        NewSessionTab.omp,
        NewSessionTab.codex,
        NewSessionTab.claude,
      ],
      offerOmp: false,
      onChanged: (tabs) => saved = tabs,
    );

    expect(find.byKey(const ValueKey('omp')), findsNothing);
    expect(find.byKey(const ValueKey('codex')), findsOneWidget);
    expect(find.byKey(const ValueKey('claude')), findsOneWidget);

    await tester.tap(find.text('Save'));
    await tester.pumpAndSettle();

    // omp stays enabled at its stored position although it was not
    // offered, so the default tab does not change.
    expect(saved, [
      NewSessionTab.omp,
      NewSessionTab.codex,
      NewSessionTab.claude,
    ]);
  });

  testWidgets('keeps a hidden omp tab in place when other tabs change', (
    tester,
  ) async {
    List<NewSessionTab>? saved;
    await _open(
      tester,
      current: const [
        NewSessionTab.omp,
        NewSessionTab.codex,
        NewSessionTab.claude,
      ],
      offerOmp: false,
      onChanged: (tabs) => saved = tabs,
    );

    await tester.tap(
      find.descendant(
        of: find.byKey(const ValueKey('claude')),
        matching: find.byType(Checkbox),
      ),
    );
    await tester.pump();
    await tester.tap(find.text('Save'));
    await tester.pumpAndSettle();

    expect(saved, [NewSessionTab.omp, NewSessionTab.codex]);
  });

  testWidgets('offers omp on a Bridge that supports it', (tester) async {
    List<NewSessionTab>? saved;
    await _open(
      tester,
      current: const [NewSessionTab.codex],
      offerOmp: true,
      onChanged: (tabs) => saved = tabs,
    );

    expect(find.byKey(const ValueKey('omp')), findsOneWidget);
    await tester.tap(
      find.descendant(
        of: find.byKey(const ValueKey('omp')),
        matching: find.byType(Checkbox),
      ),
    );
    await tester.pump();
    await tester.tap(find.text('Save'));
    await tester.pumpAndSettle();

    expect(saved, [NewSessionTab.codex, NewSessionTab.omp]);
  });
}
