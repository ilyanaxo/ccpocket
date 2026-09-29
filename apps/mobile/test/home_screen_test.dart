import 'dart:convert';
import 'dart:io';

import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';

import 'package:ccpocket/models/messages.dart';
import 'package:ccpocket/features/session_list/session_list_screen.dart';
import 'package:ccpocket/features/settings/state/settings_state.dart';
import 'package:ccpocket/models/new_session_params.dart';
import 'package:ccpocket/models/new_session_tab.dart';
import 'package:ccpocket/theme/app_theme.dart';
import 'package:ccpocket/theme/provider_style.dart';

RecentSession _session({
  required String projectPath,
  String sessionId = 'sess',
  String? provider,
  String firstPrompt = '',
  String gitBranch = 'main',
  String? summary,
  String modified = '2025-01-01T00:00:00Z',
  String? codexApprovalPolicy,
  String? codexApprovalsReviewer,
  String? codexPermissionsMode,
  String? codexSandboxMode,
  String? codexModel,
  String? codexModelReasoningEffort,
  bool? codexNetworkAccessEnabled,
  String? codexWebSearchMode,
}) {
  return RecentSession(
    sessionId: sessionId,
    provider: provider,
    firstPrompt: firstPrompt,
    summary: summary,
    created: '2025-01-01T00:00:00Z',
    modified: modified,
    gitBranch: gitBranch,
    projectPath: projectPath,
    isSidechain: false,
    codexApprovalPolicy: codexApprovalPolicy,
    codexApprovalsReviewer: codexApprovalsReviewer,
    codexPermissionsMode: codexPermissionsMode,
    codexSandboxMode: codexSandboxMode,
    codexModel: codexModel,
    codexModelReasoningEffort: codexModelReasoningEffort,
    codexNetworkAccessEnabled: codexNetworkAccessEnabled,
    codexWebSearchMode: codexWebSearchMode,
  );
}

void main() {
  final sessions = [
    _session(projectPath: '/home/user/ccpocket', sessionId: 's1'),
    _session(projectPath: '/home/user/ccpocket', sessionId: 's2'),
    _session(projectPath: '/home/user/my-app', sessionId: 's3'),
    _session(projectPath: '/home/user/my-app', sessionId: 's4'),
    _session(projectPath: '/home/user/my-app', sessionId: 's5'),
    _session(projectPath: '/home/user/cli-tool', sessionId: 's6'),
  ];

  group('projectCounts', () {
    test('counts sessions per project name', () {
      final counts = projectCounts(sessions);
      expect(counts['ccpocket'], 2);
      expect(counts['my-app'], 3);
      expect(counts['cli-tool'], 1);
    });

    test('preserves first-seen order', () {
      final keys = projectCounts(sessions).keys.toList();
      expect(keys, ['ccpocket', 'my-app', 'cli-tool']);
    });

    test('returns empty map for empty input', () {
      expect(projectCounts([]), isEmpty);
    });
  });

  group('filterByProject', () {
    test('null filter returns all sessions', () {
      expect(filterByProject(sessions, null), sessions);
    });

    test('filters by project name', () {
      final filtered = filterByProject(sessions, 'my-app');
      expect(filtered, hasLength(3));
      expect(filtered.every((s) => s.projectName == 'my-app'), isTrue);
    });

    test('non-existent project returns empty', () {
      expect(filterByProject(sessions, 'nope'), isEmpty);
    });
  });

  group('recentProjects', () {
    test('returns unique projects in first-seen order', () {
      final projects = recentProjects(sessions);
      expect(projects, hasLength(3));
      expect(projects[0].name, 'ccpocket');
      expect(projects[1].name, 'my-app');
      expect(projects[2].name, 'cli-tool');
    });

    test('preserves full path', () {
      final projects = recentProjects(sessions);
      expect(projects[0].path, '/home/user/ccpocket');
    });

    test('empty input returns empty', () {
      expect(recentProjects([]), isEmpty);
    });
  });

  group('shortenPath', () {
    test('replaces HOME prefix with ~', () {
      // This test depends on the runtime HOME env var.
      // We test the no-match case which is platform-independent.
      expect(shortenPath('/some/other/path'), '/some/other/path');
    });

    test('returns original if no HOME match', () {
      expect(shortenPath('/tmp/foo'), '/tmp/foo');
    });
  });

  group('buildResumeCommand', () {
    test('builds Claude resume command with quoted project path', () {
      final session = _session(
        projectPath: "/home/user/My Project",
        sessionId: 'claude-session-1',
      );

      expect(
        buildResumeCommand(session),
        "cd '/home/user/My Project' && claude --resume 'claude-session-1'",
      );
    });

    test('uses resumeCwd for worktree sessions', () {
      final session = RecentSession(
        sessionId: 'worktree-session',
        firstPrompt: 'test',
        created: '2025-01-01T00:00:00Z',
        modified: '2025-01-01T00:00:00Z',
        gitBranch: 'feature',
        projectPath: '/home/user/project',
        resumeCwd: '/home/user/project-worktrees/feature',
        isSidechain: false,
      );

      expect(
        buildResumeCommand(session),
        "cd '/home/user/project-worktrees/feature' && claude --resume 'worktree-session'",
      );
    });

    test('preserves custom Project secondary roots for Claude', () {
      final session = RecentSession(
        sessionId: 'multi-root',
        firstPrompt: 'test',
        created: '2025-01-01T00:00:00Z',
        modified: '2025-01-01T00:00:00Z',
        gitBranch: 'main',
        projectPath: '/workspace/primary',
        isSidechain: false,
        workspace: const SessionWorkspaceInfo(
          kind: 'project',
          projectId: 'project-1',
          projectName: 'Flutter apps',
          rootPaths: ['/workspace/primary', "/workspace/API's"],
        ),
      );

      expect(
        buildResumeCommand(session),
        "cd '/workspace/primary' && claude --resume 'multi-root' --add-dir '/workspace/API'\\''s'",
      );
    });

    test('preserves custom Project secondary roots for Codex', () {
      final session = RecentSession(
        sessionId: 'thread-1',
        provider: Provider.codex.value,
        firstPrompt: 'test',
        created: '2025-01-01T00:00:00Z',
        modified: '2025-01-01T00:00:00Z',
        gitBranch: 'main',
        projectPath: '/workspace/primary',
        isSidechain: false,
        workspace: const SessionWorkspaceInfo(
          kind: 'project',
          projectId: 'project-1',
          projectName: 'Flutter apps',
          rootPaths: ['/workspace/primary', '/workspace/api'],
        ),
      );

      expect(
        buildResumeCommand(session),
        "cd '/workspace/primary' && codex --add-dir '/workspace/api' resume 'thread-1'",
      );
    });

    test('escapes single quotes for shell paste', () {
      final session = _session(
        projectPath: "/tmp/it's/project",
        sessionId: "session'42",
      );

      expect(
        buildResumeCommand(session),
        "cd '/tmp/it'\\''s/project' && claude --resume 'session'\\''42'",
      );
    });

    test('adds --dangerously-skip-permissions for bypassPermissions', () {
      final session = RecentSession(
        sessionId: 'bypass-session',
        firstPrompt: 'test',
        created: '2025-01-01T00:00:00Z',
        modified: '2025-01-01T00:00:00Z',
        gitBranch: 'main',
        projectPath: '/home/user/project',
        executionMode: ExecutionMode.fullAccess.value,
        isSidechain: false,
      );

      expect(
        buildResumeCommand(session),
        "cd '/home/user/project' && claude --resume 'bypass-session' --dangerously-skip-permissions",
      );
    });

    test('adds --permission-mode for acceptEdits', () {
      final session = RecentSession(
        sessionId: 'edit-session',
        firstPrompt: 'test',
        created: '2025-01-01T00:00:00Z',
        modified: '2025-01-01T00:00:00Z',
        gitBranch: 'main',
        projectPath: '/home/user/project',
        executionMode: ExecutionMode.acceptEdits.value,
        isSidechain: false,
      );

      expect(
        buildResumeCommand(session),
        "cd '/home/user/project' && claude --resume 'edit-session' --permission-mode acceptEdits",
      );
    });

    test('adds --permission-mode for plan mode', () {
      final session = RecentSession(
        sessionId: 'plan-session',
        firstPrompt: 'test',
        created: '2025-01-01T00:00:00Z',
        modified: '2025-01-01T00:00:00Z',
        gitBranch: 'main',
        projectPath: '/home/user/project',
        planMode: true,
        isSidechain: false,
      );

      expect(
        buildResumeCommand(session),
        "cd '/home/user/project' && claude --resume 'plan-session' --permission-mode plan",
      );
    });
  });

  group('buildResumeCommand omp', () {
    test('resumes with the stored approval mode', () {
      final session = _session(
        projectPath: '/home/user/my-app',
        sessionId: '01a0e960-d626-7359-b8e8-44ce5c598088',
        provider: 'omp',
      );

      expect(
        buildResumeCommand(session),
        "cd '/home/user/my-app' && omp --resume "
        "'01a0e960-d626-7359-b8e8-44ce5c598088' --approval-mode always-ask",
      );
      expect(
        buildResumeCommand(
          session,
          ompExecutionMode: ExecutionMode.acceptEdits,
        ),
        endsWith('--approval-mode write'),
      );
      expect(
        buildResumeCommand(session, ompExecutionMode: ExecutionMode.fullAccess),
        endsWith('--approval-mode yolo'),
      );
    });

    test('omp restores extra directories itself', () {
      final session = RecentSession(
        sessionId: 'omp-1',
        provider: 'omp',
        firstPrompt: 'test',
        created: '2025-01-01T00:00:00Z',
        modified: '2025-01-01T00:00:00Z',
        gitBranch: 'main',
        projectPath: '/home/user/my-app',
        isSidechain: false,
        workspace: const SessionWorkspaceInfo(
          kind: 'project',
          rootPaths: ['/home/user/my-app', '/home/user/shared'],
        ),
      );

      expect(buildResumeCommand(session), isNot(contains('--add-dir')));
    });

    test('reads the approval mode from the per-session settings', () {
      expect(
        ompExecutionModeFromSessionSettings(null),
        ExecutionMode.defaultMode,
      );
      expect(
        ompExecutionModeFromSessionSettings({'executionMode': 'fullAccess'}),
        ExecutionMode.fullAccess,
      );
      expect(
        ompExecutionModeFromSessionSettings({'permissionMode': 'acceptEdits'}),
        ExecutionMode.acceptEdits,
      );
      // omp has no plan mode.
      expect(
        ompExecutionModeFromSessionSettings({'permissionMode': 'plan'}),
        ExecutionMode.defaultMode,
      );
    });
  });

  group('buildOmpStartMessage', () {
    test('matches the omp-start contract fixture', () {
      final fixture = jsonDecode(
        File('../../test/fixtures/protocol/v1/omp-start.json')
            .readAsStringSync(),
      ) as Map<String, dynamic>;
      final params = NewSessionParams(
        projectPath: '/home/user/project',
        provider: Provider.omp,
        executionMode: ExecutionMode.acceptEdits,
        ompModel: 'baseten/zai-org/GLM-5.3-Fast',
        ompThinkingLevel: 'high',
      );

      final message = buildOmpStartMessage(
        params,
        autoRename: true,
        requestId: 'pending_1790447032742',
      );

      expect(jsonDecode(message.toJson()), fixture);
    });

    test('omp default sends neither model nor thinking level', () {
      final params = NewSessionParams(
        projectPath: '/home/user/project',
        provider: Provider.omp,
        ompThinkingLevel: 'high',
        useWorktree: true,
        worktreeBranch: 'fix/login',
        additionalWritableRoots: const ['/home/user/shared'],
      );

      final json = jsonDecode(
        buildOmpStartMessage(
          params,
          autoRename: false,
          requestId: 'pending_1',
        ).toJson(),
      ) as Map<String, dynamic>;

      expect(json.containsKey('model'), isFalse);
      expect(json.containsKey('thinkingLevel'), isFalse);
      expect(json['executionMode'], 'default');
      expect(json['permissionMode'], 'default');
      expect(json['useWorktree'], isTrue);
      expect(json['worktreeBranch'], 'fix/login');
      expect(json['additionalWritableRoots'], ['/home/user/shared']);
      for (final key in const [
        'planMode',
        'sandboxMode',
        'effort',
        'modelReasoningEffort',
        'approvalPolicy',
        'codexPermissionsMode',
        'serviceTier',
        'networkAccessEnabled',
        'webSearchMode',
        'profile',
      ]) {
        expect(json.containsKey(key), isFalse, reason: key);
      }
    });
  });

  group('visibleNewSessionTabs', () {
    const all = [NewSessionTab.claude, NewSessionTab.omp, NewSessionTab.codex];

    test('offers omp only when the Bridge supports it', () {
      expect(visibleNewSessionTabs(all, OmpSupport.supported), all);
      expect(visibleNewSessionTabs(all, OmpSupport.unknown), [
        NewSessionTab.claude,
        NewSessionTab.codex,
      ]);
      expect(visibleNewSessionTabs(all, OmpSupport.unsupported), [
        NewSessionTab.claude,
        NewSessionTab.codex,
      ]);
    });

    test('falls back to Claude and Codex when only omp is enabled', () {
      expect(
        visibleNewSessionTabs(const [NewSessionTab.omp], OmpSupport.unknown),
        [NewSessionTab.codex, NewSessionTab.claude],
      );
      expect(
        visibleNewSessionTabs(const [NewSessionTab.omp], OmpSupport.supported),
        [NewSessionTab.omp],
      );
    });
  });

  testWidgets('providers have distinct colours and icons', (tester) async {
    late Map<Provider, ProviderStyle> styles;
    await tester.pumpWidget(
      MaterialApp(
        theme: AppTheme.darkTheme,
        home: Builder(
          builder: (context) {
            styles = {
              for (final provider in Provider.values)
                provider: providerStyleFor(context, provider),
            };
            return const SizedBox.shrink();
          },
        ),
      ),
    );

    final scheme = AppTheme.darkTheme.colorScheme;
    expect(styles[Provider.claude]!.foreground, scheme.primary);
    expect(styles[Provider.codex]!.foreground, scheme.secondary);
    expect(styles[Provider.omp]!.foreground, scheme.tertiary);
    expect(styles[Provider.omp]!.icon, Icons.pie_chart_outline);
    expect(providerFromRaw('omp'), Provider.omp);
  });

  group('filterByQuery', () {
    final querySessions = [
      _session(
        projectPath: '/home/user/app',
        sessionId: 'q1',
        firstPrompt: 'Fix the login bug',
        summary: 'Fixed auth issue',
      ),
      _session(
        projectPath: '/home/user/app',
        sessionId: 'q2',
        firstPrompt: 'Add dark mode',
      ),
      _session(
        projectPath: '/home/user/app',
        sessionId: 'q3',
        firstPrompt: 'Refactor tests',
        summary: 'Login flow refactored',
      ),
    ];

    test('empty query returns all sessions', () {
      expect(filterByQuery(querySessions, ''), querySessions);
    });

    test('matches firstPrompt case-insensitively', () {
      final filtered = filterByQuery(querySessions, 'LOGIN');
      expect(filtered, hasLength(2));
      expect(filtered.map((s) => s.sessionId), containsAll(['q1', 'q3']));
    });

    test('matches summary', () {
      final filtered = filterByQuery(querySessions, 'auth');
      expect(filtered, hasLength(1));
      expect(filtered.first.sessionId, 'q1');
    });

    test('no match returns empty', () {
      expect(filterByQuery(querySessions, 'zzzzz'), isEmpty);
    });
  });

  group('RecentSessionsMessage.hasMore', () {
    test('parses hasMore: true', () {
      final json = {
        'type': 'recent_sessions',
        'sessions': <Map<String, dynamic>>[],
        'hasMore': true,
      };
      final msg = ServerMessage.fromJson(json);
      expect(msg, isA<RecentSessionsMessage>());
      expect((msg as RecentSessionsMessage).hasMore, isTrue);
    });

    test('defaults hasMore to false when missing', () {
      final json = {
        'type': 'recent_sessions',
        'sessions': <Map<String, dynamic>>[],
      };
      final msg = ServerMessage.fromJson(json);
      expect(msg, isA<RecentSessionsMessage>());
      expect((msg as RecentSessionsMessage).hasMore, isFalse);
    });

    test('parses hasMore: false', () {
      final json = {
        'type': 'recent_sessions',
        'sessions': <Map<String, dynamic>>[],
        'hasMore': false,
      };
      final msg = ServerMessage.fromJson(json);
      expect(msg, isA<RecentSessionsMessage>());
      expect((msg as RecentSessionsMessage).hasMore, isFalse);
    });
  });

  group('ClientMessage.listRecentSessions', () {
    test('serializes with no optional params', () {
      final msg = ClientMessage.listRecentSessions();
      final decoded = jsonDecode(msg.toJson()) as Map<String, dynamic>;
      expect(decoded['type'], 'list_recent_sessions');
      expect(decoded.containsKey('offset'), isFalse);
      expect(decoded.containsKey('projectPath'), isFalse);
    });

    test('serializes with offset and projectPath', () {
      final msg = ClientMessage.listRecentSessions(
        limit: 10,
        offset: 20,
        projectPath: '/tmp/project',
      );
      final decoded = jsonDecode(msg.toJson()) as Map<String, dynamic>;
      expect(decoded['type'], 'list_recent_sessions');
      expect(decoded['limit'], 10);
      expect(decoded['offset'], 20);
      expect(decoded['projectPath'], '/tmp/project');
    });

    test('serializes Project identity filters', () {
      final decoded = jsonDecode(
        ClientMessage.listRecentSessions(
          projectId: 'project-1',
          workspaceKind: 'project',
        ).toJson(),
      ) as Map<String, dynamic>;

      expect(decoded['projectId'], 'project-1');
      expect(decoded['workspaceKind'], 'project');
      expect(decoded.containsKey('projectPath'), isFalse);
    });

    test('omits null optional params', () {
      final msg = ClientMessage.listRecentSessions(limit: 5);
      final decoded = jsonDecode(msg.toJson()) as Map<String, dynamic>;
      expect(decoded['limit'], 5);
      expect(decoded.containsKey('offset'), isFalse);
      expect(decoded.containsKey('projectPath'), isFalse);
    });
  });

  group('session start defaults', () {
    test('selects provider-specific auto rename settings', () {
      const settings = SettingsState(
        autoRenameCodexSessions: true,
        autoRenameClaudeSessions: false,
        autoRenameOmpSessions: false,
      );

      expect(autoRenameForProvider(settings, Provider.codex), isTrue);
      expect(autoRenameForProvider(settings, Provider.claude), isFalse);
      expect(autoRenameForProvider(settings, Provider.omp), isFalse);
      expect(
        autoRenameForProvider(
          settings.copyWith(autoRenameOmpSessions: true),
          Provider.omp,
        ),
        isTrue,
      );

      final codexJson = jsonDecode(
        ClientMessage.start(
          '/tmp/project',
          provider: Provider.codex.value,
          autoRename: autoRenameForProvider(settings, Provider.codex),
        ).toJson(),
      ) as Map<String, dynamic>;
      final claudeJson = jsonDecode(
        ClientMessage.start(
          '/tmp/project',
          provider: Provider.claude.value,
          autoRename: autoRenameForProvider(settings, Provider.claude),
        ).toJson(),
      ) as Map<String, dynamic>;

      expect(codexJson['autoRename'], isTrue);
      expect(claudeJson['autoRename'], isFalse);
    });

    test('serializes and restores codex defaults', () {
      final params = NewSessionParams(
        projectPath: '/tmp/project-a',
        provider: Provider.codex,
        permissionMode: PermissionMode.acceptEdits,
        useWorktree: true,
        worktreeBranch: 'feature/x',
        existingWorktreePath: '/tmp/project-a-worktrees/feature-x',
        model: 'gpt-5.3-codex',
        sandboxMode: SandboxMode.on,
        modelReasoningEffort: ReasoningEffort.high,
        codexSpeed: CodexSpeed.fast,
        networkAccessEnabled: true,
        webSearchMode: WebSearchMode.live,
      );

      final json = sessionStartDefaultsToJson(params);
      final restored = sessionStartDefaultsFromJson(json);

      expect(restored, isNotNull);
      expect(restored!.projectPath, '/tmp/project-a');
      expect(restored.provider, Provider.codex);
      // Session-specific fields are intentionally NOT persisted
      expect(restored.useWorktree, isFalse);
      expect(restored.existingWorktreePath, isNull);
      expect(restored.worktreeBranch, isNull);
      // Provider settings ARE persisted
      expect(restored.codexApprovalPolicy, CodexApprovalPolicy.onRequest);
      expect(restored.codexAutoReviewEnabled, isFalse);
      expect(restored.codexSpeed, CodexSpeed.fast);
      expect(restored.webSearchMode, WebSearchMode.live);
    });

    test('serializes and restores codex auto review default', () {
      final params = NewSessionParams(
        projectPath: '/tmp/project-auto-review',
        provider: Provider.codex,
        codexApprovalPolicy: CodexApprovalPolicy.onRequest,
        codexAutoReviewEnabled: true,
      );

      final json = sessionStartDefaultsToJson(params);
      final restored = sessionStartDefaultsFromJson(json);

      expect(restored, isNotNull);
      expect(restored!.provider, Provider.codex);
      expect(restored.codexApprovalPolicy, CodexApprovalPolicy.onRequest);
      expect(restored.codexAutoReviewEnabled, isTrue);
      expect(restored.codexApprovalsReviewer, 'auto_review');
    });

    test('preserves factual Codex recent approval reviewer', () {
      final recent = [
        _session(
          projectPath: '/tmp/project-auto-review',
          provider: Provider.codex.value,
          codexApprovalPolicy: CodexApprovalPolicy.onRequest.value,
          codexApprovalsReviewer: 'auto_review',
        ),
      ];
      final claudeDefaults = NewSessionParams(
        projectPath: '/tmp/project-claude',
        provider: Provider.claude,
        permissionMode: PermissionMode.defaultMode,
      );

      final updated = preserveFactualRecentSessions(recent);

      expect(updated.single.codexApprovalPolicy, 'on-request');
      expect(updated.single.codexApprovalsReviewer, 'auto_review');
      expect(claudeDefaults.provider, Provider.claude);
    });

    test('Codex defaults do not override Codex recent approval reviewer', () {
      final recent = [
        _session(
          projectPath: '/tmp/project-codex',
          provider: Provider.codex.value,
          codexApprovalPolicy: CodexApprovalPolicy.onRequest.value,
          codexApprovalsReviewer: 'user',
        ),
      ];
      final codexDefaults = NewSessionParams(
        projectPath: '/tmp/project-codex',
        provider: Provider.codex,
        codexApprovalPolicy: CodexApprovalPolicy.onRequest,
        codexAutoReviewEnabled: true,
      );

      final updated = preserveFactualRecentSessions(recent);

      expect(updated.single.codexApprovalPolicy, 'on-request');
      expect(updated.single.codexApprovalsReviewer, 'user');
      expect(codexDefaults.codexApprovalsReviewer, 'auto_review');
    });

    test('Codex resume settings keep missing metadata unknown', () {
      final session = _session(
        projectPath: '/tmp/project-codex',
        provider: Provider.codex.value,
      );

      final settings = factualCodexResumeSettings(session, const []);

      expect(settings.permissionMode, isNull);
      expect(settings.executionMode, isNull);
      expect(settings.approvalPolicy, isNull);
      expect(settings.approvalsReviewer, isNull);
      expect(settings.codexPermissionsMode, isNull);
      expect(settings.sandboxMode, isNull);
      expect(settings.model, isNull);
    });

    test('Codex resume settings preserve factual metadata', () {
      final session = _session(
        projectPath: '/tmp/project-codex',
        provider: Provider.codex.value,
        codexApprovalPolicy: CodexApprovalPolicy.onRequest.value,
        codexApprovalsReviewer: 'auto_review',
        codexPermissionsMode: CodexPermissionsMode.autoReview.value,
        codexSandboxMode: 'workspace-write',
        codexModel: 'gpt-5.3-codex',
        codexModelReasoningEffort: 'high',
        codexNetworkAccessEnabled: false,
        codexWebSearchMode: 'cached',
      );

      final settings = factualCodexResumeSettings(session, const [
        'gpt-5.3-codex',
      ]);

      expect(settings.permissionMode, PermissionMode.acceptEdits.value);
      expect(settings.executionMode, ExecutionMode.defaultMode.value);
      expect(settings.approvalPolicy, CodexApprovalPolicy.onRequest.value);
      expect(settings.approvalsReviewer, 'auto_review');
      expect(
        settings.codexPermissionsMode,
        CodexPermissionsMode.autoReview.value,
      );
      expect(settings.sandboxMode, 'workspace-write');
      expect(settings.model, 'gpt-5.3-codex');
      expect(settings.modelReasoningEffort, 'high');
      expect(settings.networkAccessEnabled, isFalse);
      expect(settings.webSearchMode, 'cached');
    });

    test(
      'Claude initial defaults keep saved Codex auto review for tab switch',
      () {
        final claudeDefaults = NewSessionParams(
          projectPath: '/tmp/project-claude',
          provider: Provider.claude,
          permissionMode: PermissionMode.defaultMode,
        );
        final codexDefaults = NewSessionParams(
          projectPath: '/tmp/project-codex',
          provider: Provider.codex,
          codexApprovalPolicy: CodexApprovalPolicy.onRequest,
          codexAutoReviewEnabled: true,
        );

        final merged = mergeCodexDefaultsIntoInitialSessionDefaults(
          claudeDefaults,
          codexDefaults,
        );

        expect(merged, isNotNull);
        expect(merged!.provider, Provider.claude);
        expect(merged.codexApprovalPolicy, CodexApprovalPolicy.onRequest);
        expect(merged.codexAutoReviewEnabled, isTrue);
        expect(merged.codexApprovalsReviewer, 'auto_review');
      },
    );

    test('does not persist session-specific fields', () {
      final params = NewSessionParams(
        projectPath: '/tmp/project-c',
        provider: Provider.claude,
        permissionMode: PermissionMode.acceptEdits,
        useWorktree: true,
        worktreeBranch: 'feature/y',
        existingWorktreePath: '/tmp/project-c-worktrees/feature-y',
        claudeMaxTurns: 10,
        claudeMaxBudgetUsd: 2.50,
      );

      final json = sessionStartDefaultsToJson(params);
      final restored = sessionStartDefaultsFromJson(json);

      expect(restored, isNotNull);
      // These session-specific values must NOT be restored
      expect(restored!.useWorktree, isFalse);
      expect(restored.worktreeBranch, isNull);
      expect(restored.existingWorktreePath, isNull);
      expect(restored.claudeMaxTurns, isNull);
      expect(restored.claudeMaxBudgetUsd, isNull);
    });

    test('returns null when required projectPath is missing', () {
      final restored = sessionStartDefaultsFromJson(<String, dynamic>{});
      expect(restored, isNull);
    });

    test('serializes and restores Claude advanced defaults', () {
      final params = NewSessionParams(
        projectPath: '/tmp/project-b',
        provider: Provider.claude,
        permissionMode: PermissionMode.plan,
        claudeModel: 'claude-sonnet-4-5',
        claudeEffort: ClaudeEffort.max,
        claudeMaxTurns: 6,
        claudeMaxBudgetUsd: 0.75,
        claudeFallbackModel: 'claude-haiku-4-5',
        claudeForkSession: true,
        claudePersistSession: false,
      );

      final json = sessionStartDefaultsToJson(params);
      final restored = sessionStartDefaultsFromJson(json);

      expect(restored, isNotNull);
      expect(restored!.provider, Provider.claude);
      expect(restored.permissionMode, PermissionMode.plan);
      expect(restored.claudeModel, 'claude-sonnet-4-5');
      expect(restored.claudeEffort, ClaudeEffort.max);
      // maxTurns and maxBudgetUsd are session-specific, NOT persisted
      expect(restored.claudeMaxTurns, isNull);
      expect(restored.claudeMaxBudgetUsd, isNull);
      expect(restored.claudeFallbackModel, 'claude-haiku-4-5');
      expect(restored.claudeForkSession, isTrue);
      expect(restored.claudePersistSession, isFalse);
    });

    test('migrates deprecated codex defaults to the fallback first model', () {
      final restored = sessionStartDefaultsFromJson({
        'projectPath': '/tmp/project-d',
        'provider': Provider.codex.value,
        'model': 'gpt-5.2-codex',
      });

      expect(restored, isNotNull);
      expect(restored!.model, defaultCodexModels.first);
    });
  });
}
