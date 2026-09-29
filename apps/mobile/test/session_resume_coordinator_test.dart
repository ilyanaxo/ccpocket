import 'dart:convert';
import 'dart:io';

import 'package:ccpocket/features/session_list/services/session_resume_coordinator.dart';
import 'package:ccpocket/models/messages.dart';
import 'package:ccpocket/models/offline_pending_action.dart';
import 'package:ccpocket/services/bridge_service.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:shared_preferences/shared_preferences.dart';

class _ResumeBridge extends BridgeService {
  final sentMessages = <ClientMessage>[];
  List<OfflinePendingAction> pendingActions = const [];

  @override
  List<OfflinePendingAction> get offlinePendingActions => pendingActions;

  @override
  void send(ClientMessage message) {
    sentMessages.add(message);
  }
}

const _session = RecentSession(
  sessionId: 'claude-uuid',
  provider: 'claude',
  rawPermissionMode: 'acceptEdits',
  firstPrompt: 'Continue',
  created: '2026-07-24T00:00:00Z',
  modified: '2026-07-24T01:00:00Z',
  gitBranch: 'main',
  projectPath: '/workspace/app',
  resumeCwd: '/workspace/app/worktree',
  isSidechain: false,
);

void main() {
  TestWidgetsFlutterBinding.ensureInitialized();

  late _ResumeBridge bridge;

  setUp(() {
    SharedPreferences.setMockInitialValues({
      'claude_session_settings_claude-uuid': jsonEncode({
        'permissionMode': 'plan',
        'executionMode': 'plan',
        'planMode': true,
        'sandboxMode': 'on',
        'claudeEffort': 'high',
        'claudeModel': 'opus',
        'claudeFallbackModel': 'sonnet',
        'claudeForkSession': true,
        'claudePersistSession': false,
      }),
    });
    bridge = _ResumeBridge();
  });

  tearDown(() {
    bridge.dispose();
  });

  test('resumes a deep link with the same persisted Claude settings', () async {
    final result = await SessionResumeCoordinator(bridge: bridge)
        .resume(_session, resumeRequestId: 'link-request-1');

    expect(result.disposition, SessionResumeDisposition.dispatched);
    expect(result.projectPath, '/workspace/app/worktree');
    final message =
        jsonDecode(bridge.sentMessages.single.toJson()) as Map<String, dynamic>;
    expect(message, containsPair('type', 'resume_session'));
    expect(message, containsPair('sessionId', 'claude-uuid'));
    expect(message, containsPair('projectPath', '/workspace/app/worktree'));
    expect(message, containsPair('permissionMode', 'plan'));
    expect(message, containsPair('executionMode', 'default'));
    expect(message, containsPair('planMode', true));
    expect(message, containsPair('sandboxMode', 'on'));
    expect(message, containsPair('effort', 'high'));
    expect(message, containsPair('model', 'opus'));
    expect(message, containsPair('fallbackModel', 'sonnet'));
    expect(message, containsPair('forkSession', true));
    expect(message, containsPair('persistSession', false));
    expect(message, containsPair('resumeRequestId', 'link-request-1'));
  });

  test('resumes a Codex profile without stale permission overrides', () async {
    const codexSession = RecentSession(
      sessionId: 'codex-thread',
      provider: 'codex',
      firstPrompt: 'Continue',
      created: '2026-07-24T00:00:00Z',
      modified: '2026-07-24T01:00:00Z',
      gitBranch: 'main',
      projectPath: '/workspace/app',
      isSidechain: false,
      codexApprovalPolicy: 'on-request',
      codexApprovalsReviewer: 'user',
      codexPermissionsMode: 'custom',
      codexSandboxMode: 'workspace-write',
      codexProfile: 'unrestricted',
    );

    final result = await SessionResumeCoordinator(bridge: bridge)
        .resume(codexSession);

    expect(result.disposition, SessionResumeDisposition.dispatched);
    final message =
        jsonDecode(bridge.sentMessages.single.toJson()) as Map<String, dynamic>;
    expect(message, containsPair('type', 'resume_session'));
    expect(message, containsPair('sessionId', 'codex-thread'));
    expect(message, containsPair('provider', 'codex'));
    expect(message, containsPair('profile', 'unrestricted'));
    expect(message, isNot(contains('approvalPolicy')));
    expect(message, isNot(contains('approvalsReviewer')));
    expect(message, isNot(contains('codexPermissionsMode')));
    expect(message, isNot(contains('sandboxMode')));
  });

  test('resumes a multi-root Project with its stable identity', () async {
    const projectSession = RecentSession(
      sessionId: 'project-thread',
      provider: 'codex',
      firstPrompt: 'Continue',
      created: '2026-09-01T00:00:00Z',
      modified: '2026-09-01T01:00:00Z',
      gitBranch: 'main',
      projectPath: '/workspace/app',
      isSidechain: false,
      workspace: SessionWorkspaceInfo(
        kind: 'project',
        projectId: 'project-1',
        projectName: 'App and API',
        rootPaths: ['/workspace/app', '/workspace/api'],
      ),
    );

    await SessionResumeCoordinator(bridge: bridge).resume(projectSession);

    final message =
        jsonDecode(bridge.sentMessages.single.toJson()) as Map<String, dynamic>;
    expect(message, containsPair('projectId', 'project-1'));
    expect(message, containsPair('workspaceKind', 'project'));
    expect(
      message,
      containsPair('additionalWritableRoots', ['/workspace/api']),
    );
  });

  test('does not enqueue the same offline resume twice', () async {
    bridge.pendingActions = [
      OfflinePendingAction(
        id: 'resume:claude-uuid',
        kind: OfflinePendingActionKind.resume,
        projectPath: _session.projectPath,
        provider: 'claude',
        createdAt: DateTime.utc(2026, 7, 24),
        sessionId: _session.sessionId,
      ),
    ];

    final result = await SessionResumeCoordinator(bridge: bridge)
        .resume(_session);

    expect(result.disposition, SessionResumeDisposition.alreadyQueued);
    expect(bridge.sentMessages, isEmpty);
  });

  group('omp resume', () {
    Map<String, dynamic> fixture(String name) => jsonDecode(
      File('../../test/fixtures/protocol/v1/$name.json').readAsStringSync(),
    ) as Map<String, dynamic>;

    final ompSession = RecentSession.fromJson(
      (fixture('omp-recent-sessions')['sessions'] as List).single
          as Map<String, dynamic>,
    );
    const ompId = '01a0e960-d626-7359-b8e8-44ce5c598088';
    const settingsKey = 'claude_session_settings_$ompId';

    Map<String, dynamic> sent() =>
        jsonDecode(bridge.sentMessages.single.toJson()) as Map<String, dynamic>;

    Future<Map<String, dynamic>> stored() async {
      // The post-resume save is not awaited by resume().
      await Future<void>.delayed(Duration.zero);
      final prefs = await SharedPreferences.getInstance();
      return jsonDecode(prefs.getString(settingsKey)!) as Map<String, dynamic>;
    }

    test('sends only the stored approval mode (omp-resume fixture)', () async {
      SharedPreferences.setMockInitialValues({
        settingsKey: jsonEncode({
          'permissionMode': 'acceptEdits',
          'executionMode': 'acceptEdits',
        }),
        // Claude defaults must not leak into an omp resume.
        'session_start_defaults_claude_v1': jsonEncode({
          'projectPath': '/workspace/app',
          'provider': 'claude',
          'claudeModel': 'claude-opus-4-7',
          'claudeEffort': 'high',
          'sandboxMode': 'on',
        }),
      });
      final expected = fixture('omp-resume');

      final result = await SessionResumeCoordinator(bridge: bridge).resume(
        ompSession,
        resumeRequestId: expected['resumeRequestId'] as String,
      );

      expect(result.disposition, SessionResumeDisposition.dispatched);
      expect(result.projectPath, '/home/user/project-worktrees/fix-login');
      expect(sent(), expected);
      expect(await stored(), {
        'permissionMode': 'acceptEdits',
        'executionMode': 'acceptEdits',
      });
    });

    test('falls back to the omp start defaults', () async {
      SharedPreferences.setMockInitialValues({
        'session_start_defaults_omp_v1': jsonEncode({
          'projectPath': '/home/user/project',
          'provider': 'omp',
          'executionMode': 'fullAccess',
          'ompModel': 'baseten/zai-org/GLM-5.3-Fast',
          'ompThinkingLevel': 'high',
        }),
      });

      await SessionResumeCoordinator(bridge: bridge).resume(ompSession);

      final message = sent();
      expect(message['executionMode'], 'fullAccess');
      for (final key in [
        'model',
        'thinkingLevel',
        'permissionMode',
        'planMode',
        'sandboxMode',
        'effort',
      ]) {
        expect(message.containsKey(key), isFalse, reason: key);
      }
      expect(await stored(), {
        'permissionMode': 'bypassPermissions',
        'executionMode': 'fullAccess',
      });
    });

    test('maps settings an old app stored for the omp id', () async {
      SharedPreferences.setMockInitialValues({
        settingsKey: jsonEncode({
          'permissionMode': 'plan',
          'planMode': true,
          'sandboxMode': 'on',
          'claudeModel': 'claude-opus-4-7',
        }),
      });

      await SessionResumeCoordinator(bridge: bridge).resume(ompSession);

      final message = sent();
      expect(message['provider'], 'omp');
      expect(message['executionMode'], 'default');
      expect(message.containsKey('planMode'), isFalse);
      expect(message.containsKey('model'), isFalse);
      expect(message.containsKey('sandboxMode'), isFalse);
      final settings = await stored();
      expect(settings['permissionMode'], 'default');
      expect(settings['executionMode'], 'default');
    });
  });
}
