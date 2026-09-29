import 'package:ccpocket/features/settings/state/settings_cubit.dart';
import 'package:ccpocket/models/code_font_family.dart';
import 'package:ccpocket/models/messages.dart';
import 'package:ccpocket/models/new_session_tab.dart';
import 'package:ccpocket/theme/code_text_style.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:shared_preferences/shared_preferences.dart';

void main() {
  TestWidgetsFlutterBinding.ensureInitialized();

  group('SettingsCubit text scale', () {
    test('defaults speech recognition locale to device default', () async {
      SharedPreferences.setMockInitialValues({});
      final prefs = await SharedPreferences.getInstance();
      final cubit = SettingsCubit(prefs);

      expect(cubit.state.speechLocaleId, isEmpty);

      cubit.setSpeechLocaleId('ja-JP');
      expect(cubit.state.speechLocaleId, 'ja-JP');
      expect(prefs.getString('settings_speech_locale'), 'ja-JP');

      await cubit.close();
    });

    test('defaults to 100 percent and persists app scale', () async {
      SharedPreferences.setMockInitialValues({});
      final prefs = await SharedPreferences.getInstance();
      final cubit = SettingsCubit(prefs);

      expect(cubit.state.textScale, 1.0);

      cubit.setTextScale(0.9);

      expect(cubit.state.textScale, 0.9);
      expect(prefs.getDouble('settings_text_scale'), 0.9);

      await cubit.close();

      final restored = SettingsCubit(prefs);
      expect(restored.state.textScale, 0.9);

      await restored.close();
    });

    test('clamps text scale to the supported compact range', () async {
      SharedPreferences.setMockInitialValues({'settings_text_scale': 0.5});
      final prefs = await SharedPreferences.getInstance();
      final cubit = SettingsCubit(prefs);

      expect(cubit.state.textScale, SettingsCubit.minTextScale);

      cubit.setTextScale(1.2);
      expect(cubit.state.textScale, SettingsCubit.maxTextScale);

      cubit.setTextScale(0.5);
      expect(cubit.state.textScale, SettingsCubit.minTextScale);

      await cubit.close();
    });

    test(
      'code font defaults to Codex-sized JetBrains Mono and persists',
      () async {
        SharedPreferences.setMockInitialValues({});
        final prefs = await SharedPreferences.getInstance();
        final cubit = SettingsCubit(prefs);

        expect(cubit.state.codeFontSize, defaultCodeFontSize);
        expect(cubit.state.codeFontFamily, CodeFontFamily.jetBrainsMono);

        cubit.setCodeFontSize(16);
        cubit.setCodeFontFamily(CodeFontFamily.dejaVuSansMono);

        expect(cubit.state.codeFontSize, 16);
        expect(cubit.state.codeFontFamily, CodeFontFamily.dejaVuSansMono);
        expect(prefs.getDouble('settings_code_font_size'), 16);
        expect(
          prefs.getString('settings_code_font_family'),
          CodeFontFamily.dejaVuSansMono.id,
        );

        await cubit.close();

        final restored = SettingsCubit(prefs);
        expect(restored.state.codeFontSize, 16);
        expect(restored.state.codeFontFamily, CodeFontFamily.dejaVuSansMono);

        await restored.close();
      },
    );

    test('clamps code font size to the supported range', () async {
      SharedPreferences.setMockInitialValues({'settings_code_font_size': 4.0});
      final prefs = await SharedPreferences.getInstance();
      final cubit = SettingsCubit(prefs);

      expect(cubit.state.codeFontSize, minCodeFontSize);

      cubit.setCodeFontSize(99);
      expect(cubit.state.codeFontSize, maxCodeFontSize);

      cubit.setCodeFontSize(1);
      expect(cubit.state.codeFontSize, minCodeFontSize);

      await cubit.close();
    });

    test('persists provider-specific auto rename settings', () async {
      SharedPreferences.setMockInitialValues({});
      final prefs = await SharedPreferences.getInstance();
      final cubit = SettingsCubit(prefs);

      expect(cubit.state.autoRenameCodexSessions, isTrue);
      expect(cubit.state.autoRenameClaudeSessions, isFalse);

      cubit.setAutoRenameCodexSessions(false);
      cubit.setAutoRenameClaudeSessions(true);

      expect(cubit.state.autoRenameCodexSessions, isFalse);
      expect(cubit.state.autoRenameClaudeSessions, isTrue);
      expect(prefs.getBool('autoRenameCodexSessions'), isFalse);
      expect(prefs.getBool('autoRenameClaudeSessions'), isTrue);

      await cubit.close();

      final restored = SettingsCubit(prefs);
      expect(restored.state.autoRenameCodexSessions, isFalse);
      expect(restored.state.autoRenameClaudeSessions, isTrue);

      await restored.close();
    });

    test('extended Codex Efforts default off and persist', () async {
      SharedPreferences.setMockInitialValues({});
      final prefs = await SharedPreferences.getInstance();
      final cubit = SettingsCubit(prefs);

      expect(cubit.state.showExtendedCodexEfforts, isFalse);

      cubit.setShowExtendedCodexEfforts(true);

      expect(cubit.state.showExtendedCodexEfforts, isTrue);
      expect(prefs.getBool('settings_show_extended_codex_efforts'), isTrue);

      await cubit.close();

      final restored = SettingsCubit(prefs);
      expect(restored.state.showExtendedCodexEfforts, isTrue);

      await restored.close();
    });

    test('persists enabled agents through new session tabs', () async {
      SharedPreferences.setMockInitialValues({});
      final prefs = await SharedPreferences.getInstance();
      final cubit = SettingsCubit(prefs);

      expect(enabledProvidersFromTabs(cubit.state.newSessionTabs), {
        Provider.codex,
        Provider.claude,
        Provider.omp,
      });

      cubit.setAgentEnabled(Provider.claude, false);
      cubit.setAgentEnabled(Provider.omp, false);
      expect(cubit.state.newSessionTabs, [NewSessionTab.codex]);

      await cubit.close();

      final restored = SettingsCubit(prefs);
      expect(restored.state.newSessionTabs, [NewSessionTab.codex]);

      restored.setAgentEnabled(Provider.claude, true);
      expect(restored.state.newSessionTabs, [
        NewSessionTab.codex,
        NewSessionTab.claude,
      ]);

      await restored.close();
    });

    group('omp agent', () {
      const tabsKey = 'settings_new_session_tabs';
      const migratedKey = 'settings_new_session_tabs_omp_migrated_v1';

      test('fresh install enables omp and marks the migration done', () async {
        SharedPreferences.setMockInitialValues({});
        final prefs = await SharedPreferences.getInstance();
        final cubit = SettingsCubit(prefs);

        expect(cubit.state.newSessionTabs, [
          NewSessionTab.codex,
          NewSessionTab.claude,
          NewSessionTab.omp,
        ]);
        expect(prefs.getBool(migratedKey), isTrue);
        expect(prefs.getString(tabsKey), isNull);

        await cubit.close();
      });

      test('a stored tab list without omp gets omp appended once', () async {
        SharedPreferences.setMockInitialValues({
          tabsKey: tabsToJson(const [
            NewSessionTab.claude,
            NewSessionTab.codex,
          ]),
        });
        final prefs = await SharedPreferences.getInstance();
        final cubit = SettingsCubit(prefs);

        const migrated = [
          NewSessionTab.claude,
          NewSessionTab.codex,
          NewSessionTab.omp,
        ];
        expect(cubit.state.newSessionTabs, migrated);
        expect(tabsFromJson(prefs.getString(tabsKey)!), migrated);
        expect(prefs.getBool(migratedKey), isTrue);

        await cubit.close();

        final restored = SettingsCubit(prefs);
        expect(restored.state.newSessionTabs, migrated);
        await restored.close();
      });

      test('omp disabled after the migration stays disabled', () async {
        SharedPreferences.setMockInitialValues({
          tabsKey: tabsToJson(const [NewSessionTab.codex]),
        });
        final prefs = await SharedPreferences.getInstance();
        final cubit = SettingsCubit(prefs);
        expect(cubit.state.newSessionTabs, [
          NewSessionTab.codex,
          NewSessionTab.omp,
        ]);

        cubit.setAgentEnabled(Provider.omp, false);
        expect(cubit.state.newSessionTabs, [NewSessionTab.codex]);
        await cubit.close();

        final restored = SettingsCubit(prefs);
        expect(restored.state.newSessionTabs, [NewSessionTab.codex]);
        await restored.close();
      });

      test('a stored list that already has omp is kept as is', () async {
        SharedPreferences.setMockInitialValues({
          tabsKey: tabsToJson(const [NewSessionTab.omp, NewSessionTab.codex]),
        });
        final prefs = await SharedPreferences.getInstance();
        final cubit = SettingsCubit(prefs);

        expect(cubit.state.newSessionTabs, [
          NewSessionTab.omp,
          NewSessionTab.codex,
        ]);
        expect(prefs.getBool(migratedKey), isTrue);
        await cubit.close();
      });

      test('setAgentEnabled toggles agents but keeps the last one', () async {
        SharedPreferences.setMockInitialValues({});
        final prefs = await SharedPreferences.getInstance();
        final cubit = SettingsCubit(prefs);

        cubit.setAgentEnabled(Provider.codex, false);
        cubit.setAgentEnabled(Provider.claude, false);
        expect(cubit.state.newSessionTabs, [NewSessionTab.omp]);

        cubit.setAgentEnabled(Provider.omp, false);
        expect(cubit.state.newSessionTabs, [NewSessionTab.omp]);

        cubit.setAgentEnabled(Provider.claude, true);
        expect(cubit.state.newSessionTabs, [
          NewSessionTab.omp,
          NewSessionTab.claude,
        ]);
        expect(tabsFromJson(prefs.getString(tabsKey)!), [
          NewSessionTab.omp,
          NewSessionTab.claude,
        ]);

        await cubit.close();
      });

      test('omp auto rename defaults on and persists', () async {
        SharedPreferences.setMockInitialValues({});
        final prefs = await SharedPreferences.getInstance();
        final cubit = SettingsCubit(prefs);
        expect(cubit.state.autoRenameOmpSessions, isTrue);

        cubit.setAutoRenameOmpSessions(false);
        expect(cubit.state.autoRenameOmpSessions, isFalse);
        await cubit.close();

        final restored = SettingsCubit(prefs);
        expect(restored.state.autoRenameOmpSessions, isFalse);
        await restored.close();
      });
    });

    test('remote git status badge defaults off and persists', () async {
      SharedPreferences.setMockInitialValues({});
      final prefs = await SharedPreferences.getInstance();
      final cubit = SettingsCubit(prefs);

      expect(cubit.state.showRemoteGitStatusBadge, isFalse);

      cubit.setShowRemoteGitStatusBadge(true);

      expect(cubit.state.showRemoteGitStatusBadge, isTrue);
      expect(prefs.getBool('settings_show_remote_git_status_badge'), isTrue);

      await cubit.close();

      final restored = SettingsCubit(prefs);
      expect(restored.state.showRemoteGitStatusBadge, isTrue);

      await restored.close();
    });

    test('Bridge name display defaults on and persists', () async {
      SharedPreferences.setMockInitialValues({});
      final prefs = await SharedPreferences.getInstance();
      final cubit = SettingsCubit(prefs);

      expect(cubit.state.showBridgeNameInSessionList, isTrue);

      cubit.setShowBridgeNameInSessionList(false);

      expect(cubit.state.showBridgeNameInSessionList, isFalse);
      expect(
        prefs.getBool('settings_show_bridge_name_in_session_list'),
        isFalse,
      );

      await cubit.close();

      final restored = SettingsCubit(prefs);
      expect(restored.state.showBridgeNameInSessionList, isFalse);

      await restored.close();
    });

    test('hidden directories default off and persist', () async {
      SharedPreferences.setMockInitialValues({});
      final prefs = await SharedPreferences.getInstance();
      final cubit = SettingsCubit(prefs);

      expect(cubit.state.showHiddenDirectories, isFalse);

      cubit.setShowHiddenDirectories(true);

      expect(cubit.state.showHiddenDirectories, isTrue);
      expect(prefs.getBool('settings_show_hidden_directories'), isTrue);

      await cubit.close();

      final restored = SettingsCubit(prefs);
      expect(restored.state.showHiddenDirectories, isTrue);

      await restored.close();
    });
  });
}
