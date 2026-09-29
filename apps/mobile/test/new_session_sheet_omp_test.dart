import 'dart:async';

import 'package:ccpocket/l10n/app_localizations.dart';
import 'package:ccpocket/models/messages.dart';
import 'package:ccpocket/models/new_session_params.dart';
import 'package:ccpocket/models/new_session_tab.dart';
import 'package:ccpocket/services/bridge_service.dart';
import 'package:ccpocket/theme/app_theme.dart';
import 'package:ccpocket/widgets/new_session_sheet.dart';
import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:shared_preferences/shared_preferences.dart';

const _opus = OmpModelInfo(
  selector: 'anthropic/claude-opus-4-7',
  provider: 'anthropic',
  name: 'Claude Opus 4.7',
  thinkingLevels: ['off', 'low', 'high', 'max'],
  input: ['text', 'image'],
);
const _glm = OmpModelInfo(
  selector: 'baseten/zai-org/GLM-5.3-Fast',
  provider: 'baseten',
  name: 'GLM 5.3 Fast',
  thinkingLevels: ['off'],
  input: ['text'],
);

class _OmpBridge extends BridgeService {
  _OmpBridge({
    this.models = const [_opus, _glm],
    this.availability = OmpAvailability.available,
  });

  final List<OmpModelInfo> models;
  final OmpAvailability? availability;

  @override
  List<OmpModelInfo> get ompModels => models;

  @override
  OmpAvailability? get ompAvailability => availability;
}

/// A Bridge whose omp catalogue arrives after the sheet opened, like the
/// second `session_list` of a connection.
class _LateCatalogueBridge extends BridgeService {
  final _sessionLists = StreamController<List<SessionInfo>>.broadcast();
  List<OmpModelInfo> models = const [];
  OmpAvailability? availability;

  @override
  List<OmpModelInfo> get ompModels => models;

  @override
  OmpAvailability? get ompAvailability => availability;

  @override
  Stream<List<SessionInfo>> get sessionList => _sessionLists.stream;

  void deliverCatalogue(List<OmpModelInfo> catalogue) {
    models = catalogue;
    availability = OmpAvailability.available;
    _sessionLists.add(const []);
  }

  @override
  void dispose() {
    _sessionLists.close();
    super.dispose();
  }
}

const _allTabs = [NewSessionTab.codex, NewSessionTab.claude, NewSessionTab.omp];

void _enlargeViewport(WidgetTester tester) {
  tester.view.physicalSize = const Size(1080, 2400);
  tester.view.devicePixelRatio = 1.0;
  addTearDown(() {
    tester.view.resetPhysicalSize();
    tester.view.resetDevicePixelRatio();
  });
}

/// Opens the sheet on the omp page. [onResult] receives the started params.
Future<void> _openSheet(
  WidgetTester tester, {
  required BridgeService bridge,
  NewSessionParams? initialParams,
  List<NewSessionTab>? visibleTabs,
  ValueChanged<NewSessionParams?>? onResult,
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
            onPressed: () async {
              final result = visibleTabs == null
                  ? await showNewSessionSheet(
                      context: context,
                      bridge: bridge,
                      recentProjects: const [
                        (path: '/test/proj', name: 'proj'),
                      ],
                      initialParams: initialParams,
                    )
                  : await showNewSessionSheet(
                      context: context,
                      bridge: bridge,
                      recentProjects: const [
                        (path: '/test/proj', name: 'proj'),
                      ],
                      initialParams: initialParams,
                      visibleTabs: visibleTabs,
                    );
              onResult?.call(result);
            },
            child: const Text('Open'),
          ),
        ),
      ),
    ),
  );
  await tester.tap(find.text('Open'));
  await tester.pumpAndSettle();
}

NewSessionParams _ompInitial({
  ExecutionMode executionMode = ExecutionMode.defaultMode,
  String? ompModel,
  String? ompThinkingLevel,
}) => NewSessionParams(
  projectPath: '/test/proj',
  provider: Provider.omp,
  executionMode: executionMode,
  ompModel: ompModel,
  ompThinkingLevel: ompThinkingLevel,
);

AppLocalizations _l(WidgetTester tester) =>
    AppLocalizations.of(tester.element(find.byType(Scaffold).first));

Future<void> _tapVisible(WidgetTester tester, Finder finder) async {
  await tester.ensureVisible(finder);
  await tester.pumpAndSettle();
  await tester.tap(finder);
  await tester.pumpAndSettle();
}

void main() {
  setUp(() {
    SharedPreferences.setMockInitialValues({});
  });

  group('NewSessionSheet omp page', () {
    testWidgets('shows omp options and none of Claude or Codex', (
      tester,
    ) async {
      _enlargeViewport(tester);
      final bridge = _OmpBridge();
      addTearDown(bridge.dispose);
      await _openSheet(
        tester,
        bridge: bridge,
        initialParams: _ompInitial(),
        visibleTabs: _allTabs,
      );

      expect(find.byKey(const ValueKey('dialog_omp_approval_mode')), findsOne);
      expect(find.byKey(const ValueKey('dialog_omp_model')), findsOne);
      expect(find.byKey(const ValueKey('dialog_worktree')), findsOne);
      // "omp default" has no known thinking levels.
      expect(
        find.byKey(const ValueKey('dialog_omp_thinking_level')),
        findsNothing,
      );
      expect(
        find.byKey(const ValueKey('dialog_permission_mode')),
        findsNothing,
      );
      expect(
        find.byKey(const ValueKey('dialog_codex_permissions_mode')),
        findsNothing,
      );
      expect(find.byKey(const ValueKey('dialog_sandbox')), findsNothing);
      expect(find.byKey(const ValueKey('dialog_claude_model')), findsNothing);
      expect(find.byKey(const ValueKey('dialog_advanced_omp')), findsNothing);
      expect(find.text('Start with omp'), findsOneWidget);
      expect(find.text(_l(tester).ompDefaultModel), findsOneWidget);
    });

    testWidgets('model picker groups by provider and levels follow the model', (
      tester,
    ) async {
      _enlargeViewport(tester);
      final bridge = _OmpBridge();
      addTearDown(bridge.dispose);
      await _openSheet(
        tester,
        bridge: bridge,
        initialParams: _ompInitial(),
        visibleTabs: _allTabs,
      );

      await _tapVisible(tester, find.byKey(const ValueKey('dialog_omp_model')));
      expect(find.byKey(const ValueKey('omp_model_picker')), findsOneWidget);
      expect(
        find.byKey(const ValueKey('omp_model_option_default')),
        findsOneWidget,
      );
      final anthropic = tester.getTopLeft(
        find.byKey(const ValueKey('omp_model_group_anthropic')),
      );
      final opus = tester.getTopLeft(
        find.byKey(
          const ValueKey('omp_model_option_anthropic/claude-opus-4-7'),
        ),
      );
      final baseten = tester.getTopLeft(
        find.byKey(const ValueKey('omp_model_group_baseten')),
      );
      final glm = tester.getTopLeft(
        find.byKey(
          const ValueKey('omp_model_option_baseten/zai-org/GLM-5.3-Fast'),
        ),
      );
      expect(anthropic.dy, lessThan(opus.dy));
      expect(opus.dy, lessThan(baseten.dy));
      expect(baseten.dy, lessThan(glm.dy));

      await tester.tap(
        find.byKey(
          const ValueKey('omp_model_option_anthropic/claude-opus-4-7'),
        ),
      );
      await tester.pumpAndSettle();
      expect(find.text('Claude Opus 4.7'), findsOneWidget);

      final thinkingField = find.byKey(
        const ValueKey('dialog_omp_thinking_level'),
      );
      expect(thinkingField, findsOneWidget);
      await _tapVisible(tester, thinkingField);
      for (final level in const ['off', 'low', 'high', 'max']) {
        expect(
          find.byKey(ValueKey('omp_thinking_level_$level')),
          findsOneWidget,
        );
      }
      expect(
        find.byKey(const ValueKey('omp_thinking_level_default')),
        findsOneWidget,
      );
      expect(
        find.byKey(const ValueKey('omp_thinking_level_medium')),
        findsNothing,
      );
      await tester.tap(find.byKey(const ValueKey('omp_thinking_level_high')));
      await tester.pumpAndSettle();
      expect(find.text('High'), findsOneWidget);

      // GLM offers only "off": the chosen level falls back to omp's default.
      await _tapVisible(tester, find.byKey(const ValueKey('dialog_omp_model')));
      await tester.tap(
        find.byKey(
          const ValueKey('omp_model_option_baseten/zai-org/GLM-5.3-Fast'),
        ),
      );
      await tester.pumpAndSettle();
      expect(find.text('High'), findsNothing);
      await _tapVisible(tester, thinkingField);
      expect(find.byKey(const ValueKey('omp_thinking_level_off')), findsOne);
      expect(
        find.byKey(const ValueKey('omp_thinking_level_high')),
        findsNothing,
      );
    });

    testWidgets('tapping the selected row closes the omp pickers', (
      tester,
    ) async {
      _enlargeViewport(tester);
      final bridge = _OmpBridge();
      addTearDown(bridge.dispose);
      await _openSheet(
        tester,
        bridge: bridge,
        initialParams: _ompInitial(
          ompModel: _opus.selector,
          ompThinkingLevel: 'high',
        ),
        visibleTabs: _allTabs,
      );

      await _tapVisible(tester, find.byKey(const ValueKey('dialog_omp_model')));
      await tester.tap(
        find.byKey(
          const ValueKey('omp_model_option_anthropic/claude-opus-4-7'),
        ),
      );
      await tester.pumpAndSettle();
      expect(find.byKey(const ValueKey('omp_model_picker')), findsNothing);
      expect(find.text('Claude Opus 4.7'), findsOneWidget);

      await _tapVisible(
        tester,
        find.byKey(const ValueKey('dialog_omp_thinking_level')),
      );
      await tester.tap(find.byKey(const ValueKey('omp_thinking_level_high')));
      await tester.pumpAndSettle();
      expect(
        find.byKey(const ValueKey('omp_thinking_level_picker')),
        findsNothing,
      );
      expect(find.text('High'), findsOneWidget);
    });

    testWidgets('offers the three omp approval modes', (tester) async {
      _enlargeViewport(tester);
      final bridge = _OmpBridge();
      addTearDown(bridge.dispose);
      await _openSheet(
        tester,
        bridge: bridge,
        initialParams: _ompInitial(),
        visibleTabs: _allTabs,
      );

      final l = _l(tester);
      expect(find.text(l.ompApprovalAlwaysAsk), findsOneWidget);
      await _tapVisible(
        tester,
        find.byKey(const ValueKey('dialog_omp_approval_mode')),
      );
      expect(find.text(l.ompApprovalMenuTitle), findsOneWidget);
      expect(find.text(l.ompApprovalWrite), findsOneWidget);
      expect(find.text(l.ompApprovalWriteDescription), findsOneWidget);
      expect(find.text(l.ompApprovalYolo), findsOneWidget);
      // omp has no plan or auto mode.
      expect(find.text(PermissionMode.plan.label), findsNothing);
      expect(find.text(PermissionMode.auto.label), findsNothing);

      await tester.tap(find.text(l.ompApprovalYolo));
      await tester.pumpAndSettle();
      expect(find.text(l.ompApprovalYolo), findsOneWidget);
      expect(find.text(l.ompApprovalYoloDescription), findsOneWidget);
    });

    testWidgets('start returns only omp fields', (tester) async {
      _enlargeViewport(tester);
      final bridge = _OmpBridge();
      addTearDown(bridge.dispose);
      NewSessionParams? result;
      await _openSheet(
        tester,
        bridge: bridge,
        initialParams: _ompInitial(
          executionMode: ExecutionMode.acceptEdits,
          ompModel: _opus.selector,
          ompThinkingLevel: 'max',
        ),
        visibleTabs: _allTabs,
        onResult: (params) => result = params,
      );

      await _tapVisible(
        tester,
        find.byKey(const ValueKey('dialog_start_button')),
      );

      final params = result!;
      expect(params.provider, Provider.omp);
      expect(params.projectPath, '/test/proj');
      expect(params.executionMode, ExecutionMode.acceptEdits);
      expect(params.permissionMode, PermissionMode.acceptEdits);
      expect(params.ompModel, _opus.selector);
      expect(params.ompThinkingLevel, 'max');
      expect(params.planMode, isFalse);
      expect(params.sandboxMode, isNull);
      expect(params.claudePermissionMode, isNull);
      expect(params.model, isNull);
      expect(params.modelReasoningEffort, isNull);
      expect(params.networkAccessEnabled, isNull);
      expect(params.webSearchMode, isNull);
      expect(params.codexProfile, isNull);
      expect(params.codexModelOverridden, isFalse);
      expect(params.codexSandboxModeOverridden, isFalse);
      expect(params.claudeModel, isNull);
      expect(params.claudeEffort, isNull);
      expect(params.claudeMaxTurns, isNull);
      expect(params.claudeFallbackModel, isNull);
      expect(params.claudeForkSession, isNull);
      expect(params.claudePersistSession, isNull);
    });

    testWidgets('omp default starts without a model or thinking level', (
      tester,
    ) async {
      _enlargeViewport(tester);
      final bridge = _OmpBridge();
      addTearDown(bridge.dispose);
      NewSessionParams? result;
      await _openSheet(
        tester,
        bridge: bridge,
        initialParams: _ompInitial(
          ompModel: _opus.selector,
          ompThinkingLevel: 'high',
        ),
        visibleTabs: _allTabs,
        onResult: (params) => result = params,
      );

      await _tapVisible(tester, find.byKey(const ValueKey('dialog_omp_model')));
      await tester.tap(find.byKey(const ValueKey('omp_model_option_default')));
      await tester.pumpAndSettle();
      expect(
        find.byKey(const ValueKey('dialog_omp_thinking_level')),
        findsNothing,
      );
      await _tapVisible(
        tester,
        find.byKey(const ValueKey('dialog_start_button')),
      );

      expect(result!.ompModel, isNull);
      expect(result!.ompThinkingLevel, isNull);
    });

    testWidgets('a model missing from the catalogue falls back to default', (
      tester,
    ) async {
      _enlargeViewport(tester);
      final bridge = _OmpBridge();
      addTearDown(bridge.dispose);
      NewSessionParams? result;
      await _openSheet(
        tester,
        bridge: bridge,
        initialParams: _ompInitial(
          ompModel: 'retired/model',
          ompThinkingLevel: 'high',
        ),
        visibleTabs: _allTabs,
        onResult: (params) => result = params,
      );

      await _tapVisible(
        tester,
        find.byKey(const ValueKey('dialog_start_button')),
      );
      expect(result!.ompModel, isNull);
      expect(result!.ompThinkingLevel, isNull);
    });

    testWidgets('a kept level stays visible until the catalogue arrives', (
      tester,
    ) async {
      _enlargeViewport(tester);
      final bridge = _LateCatalogueBridge();
      addTearDown(bridge.dispose);
      NewSessionParams? result;
      await _openSheet(
        tester,
        bridge: bridge,
        initialParams: _ompInitial(
          ompModel: _opus.selector,
          ompThinkingLevel: 'high',
        ),
        visibleTabs: _allTabs,
        onResult: (params) => result = params,
      );

      final l = _l(tester);
      final levelField = find.byKey(
        const ValueKey('dialog_omp_thinking_level'),
      );
      Finder levelTitle(String title) =>
          find.descendant(of: levelField, matching: find.text(title));
      expect(find.text(l.loading), findsOneWidget);
      expect(levelTitle('High'), findsOneWidget);

      // The kept level can be changed before the catalogue arrives.
      await _tapVisible(tester, levelField);
      await tester.tap(find.byKey(const ValueKey('omp_thinking_level_max')));
      await tester.pumpAndSettle();
      expect(levelTitle('Max'), findsOneWidget);

      // The catalogue arrives while the sheet is open.
      bridge.deliverCatalogue(const [_opus, _glm]);
      await tester.pumpAndSettle();
      expect(find.text(l.loading), findsNothing);
      expect(find.text('Claude Opus 4.7'), findsOneWidget);
      expect(levelTitle('Max'), findsOneWidget);

      await _tapVisible(tester, find.byKey(const ValueKey('dialog_omp_model')));
      await tester.tap(
        find.byKey(
          const ValueKey('omp_model_option_baseten/zai-org/GLM-5.3-Fast'),
        ),
      );
      await tester.pumpAndSettle();
      // GLM offers only "off": the level falls back to omp's default.
      expect(levelTitle(l.ompDefaultModel), findsOneWidget);

      await _tapVisible(
        tester,
        find.byKey(const ValueKey('dialog_start_button')),
      );
      expect(result!.ompModel, _glm.selector);
      expect(result!.ompThinkingLevel, isNull);
    });

    testWidgets('a late catalogue drops a kept model it does not list', (
      tester,
    ) async {
      _enlargeViewport(tester);
      final bridge = _LateCatalogueBridge();
      addTearDown(bridge.dispose);
      NewSessionParams? result;
      await _openSheet(
        tester,
        bridge: bridge,
        initialParams: _ompInitial(
          ompModel: 'retired/model',
          ompThinkingLevel: 'high',
        ),
        visibleTabs: _allTabs,
        onResult: (params) => result = params,
      );

      bridge.deliverCatalogue(const [_opus, _glm]);
      await tester.pumpAndSettle();
      expect(
        find.byKey(const ValueKey('dialog_omp_thinking_level')),
        findsNothing,
      );
      await _tapVisible(
        tester,
        find.byKey(const ValueKey('dialog_start_button')),
      );
      expect(result!.ompModel, isNull);
      expect(result!.ompThinkingLevel, isNull);
    });

    testWidgets('additional directories explain omp, not Codex config', (
      tester,
    ) async {
      _enlargeViewport(tester);
      final bridge = _OmpBridge();
      addTearDown(bridge.dispose);
      await _openSheet(
        tester,
        bridge: bridge,
        initialParams: _ompInitial(),
        visibleTabs: _allTabs,
      );

      final l = _l(tester);
      expect(find.byTooltip(l.ompAdditionalDirsDescription), findsOneWidget);
      expect(
        find.byTooltip(
          '${l.additionalWritableRootsDescription}\n'
          '${l.additionalWritableRootsTooltip}',
        ),
        findsNothing,
      );

      await _tapVisible(
        tester,
        find.byKey(const ValueKey('additional_writable_root_add_button')),
      );
      expect(find.text(l.ompAdditionalDirsDescription), findsOneWidget);
      expect(find.text(l.additionalWritableRootsTooltip), findsNothing);
    });

    testWidgets('model field explains a Bridge without omp models', (
      tester,
    ) async {
      _enlargeViewport(tester);
      final bridge = _OmpBridge(
        models: const [],
        availability: OmpAvailability.noModels,
      );
      addTearDown(bridge.dispose);
      await _openSheet(
        tester,
        bridge: bridge,
        initialParams: _ompInitial(),
        visibleTabs: _allTabs,
      );

      expect(find.text(_l(tester).ompNoModels), findsOneWidget);
    });

    testWidgets('omp tab switch keeps Codex full access out of omp', (
      tester,
    ) async {
      _enlargeViewport(tester);
      final bridge = _OmpBridge();
      addTearDown(bridge.dispose);
      NewSessionParams? result;
      await _openSheet(
        tester,
        bridge: bridge,
        initialParams: NewSessionParams(
          projectPath: '/test/proj',
          provider: Provider.codex,
          codexPermissionsMode: CodexPermissionsMode.fullAccess,
        ),
        visibleTabs: _allTabs,
        onResult: (params) => result = params,
      );

      await tester.tap(find.text('omp'));
      await tester.pumpAndSettle();
      expect(find.text(_l(tester).ompApprovalAlwaysAsk), findsOneWidget);
      await _tapVisible(
        tester,
        find.byKey(const ValueKey('dialog_start_button')),
      );

      expect(result!.provider, Provider.omp);
      expect(result!.executionMode, ExecutionMode.defaultMode);
    });

    testWidgets('omp is not offered unless the caller passes its tab', (
      tester,
    ) async {
      _enlargeViewport(tester);
      final bridge = _OmpBridge();
      addTearDown(bridge.dispose);
      await _openSheet(tester, bridge: bridge);

      expect(find.text('Codex'), findsWidgets);
      expect(find.text('omp'), findsNothing);
    });
  });
}
