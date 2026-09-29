import 'package:ccpocket/l10n/app_localizations.dart';
import 'package:ccpocket/models/messages.dart';
import 'package:ccpocket/theme/app_theme.dart';
import 'package:ccpocket/widgets/bubbles/tip_chip.dart';
import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';

void main() {
  testWidgets('renders the omp tips', (tester) async {
    for (final code in const [
      'omp_cwd_missing',
      'omp_model_ignored',
      'omp_mode_mapped',
      'omp_change_deferred',
    ]) {
      await tester.pumpWidget(
        _buildTip(locale: const Locale('en'), tipCode: code),
      );
      final l = AppLocalizations.of(tester.element(find.byType(TipChip)));
      final expected = switch (code) {
        'omp_cwd_missing' => l.ompCwdMissingTip,
        'omp_model_ignored' => l.ompModelIgnoredTip,
        'omp_mode_mapped' => l.ompModeMappedTip,
        _ => l.ompChangeDeferredTip,
      };
      expect(find.text(expected), findsOneWidget, reason: code);
    }
  });

  testWidgets('renders localized git unavailable tip', (tester) async {
    await tester.pumpWidget(_buildTip(locale: const Locale('ja')));

    expect(find.text('Git未検出 — Git機能は利用できません'), findsOneWidget);
    expect(find.textContaining('ファイル一覧'), findsNothing);

    await tester.pumpWidget(_buildTip(locale: const Locale('en')));

    expect(
      find.text('Git not detected — Git features are unavailable'),
      findsOneWidget,
    );
  });
}

Widget _buildTip({
  required Locale locale,
  String tipCode = 'git_not_available',
}) {
  return MaterialApp(
    locale: locale,
    localizationsDelegates: AppLocalizations.localizationsDelegates,
    supportedLocales: AppLocalizations.supportedLocales,
    theme: AppTheme.darkTheme,
    home: Scaffold(
      body: TipChip(
        message: SystemMessage(subtype: 'tip', tipCode: tipCode),
      ),
    ),
  );
}
