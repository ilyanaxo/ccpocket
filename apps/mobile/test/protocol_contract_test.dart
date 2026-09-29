import 'dart:convert';
import 'dart:io';

import 'package:ccpocket/models/messages.dart';
import 'package:ccpocket/models/protocol_version.dart';
import 'package:flutter_test/flutter_test.dart';

Object? _decodeFixture(String name) {
  final contents = File('../../test/fixtures/protocol/v1/$name.json')
      .readAsStringSync();
  return jsonDecode(contents);
}

Map<String, dynamic> fixture(String name) =>
    _decodeFixture(name) as Map<String, dynamic>;

/// omp fixtures hold one message or an array of variants.
List<Map<String, dynamic>> fixtureVariants(String name) {
  final decoded = _decodeFixture(name);
  final list = decoded is List ? decoded : [decoded];
  return list.cast<Map<String, dynamic>>();
}

Map<String, dynamic> encode(ClientMessage message) =>
    jsonDecode(message.toJson()) as Map<String, dynamic>;

void main() {
  group('protocol v1 contract fixtures', () {
    for (final name in ['legacy-session-list', 'current-session-list']) {
      test('accepts $name', () {
        final json = fixture(name);
        final compatibility = ProtocolCompatibility.fromBridgeJson(json);
        final message = ServerMessage.fromJson(json);

        expect(compatibility.isCompatible, isTrue);
        expect(compatibility.selectedVersion, 1);
        expect(message, isA<SessionListMessage>());
      });
    }

    for (final name in [
      'legacy-client-capabilities',
      'current-client-capabilities',
    ]) {
      test('keeps $name as a frozen client fixture', () {
        final json = fixture(name);

        expect(json['type'], 'client_capabilities');
        expect(json['supportedServerMessages'], isA<List<dynamic>>());
      });
    }
  });

  group('omp server fixtures', () {
    test('omp-session-list parses the capability, session and catalogue', () {
      final json = fixture('omp-session-list');
      final compatibility = ProtocolCompatibility.fromBridgeJson(json);
      final message = ServerMessage.fromJson(json) as SessionListMessage;

      expect(compatibility.isCompatible, isTrue);
      expect(message.protocolCapabilities, contains('provider_omp_v1'));
      final session = message.sessions.single;
      expect(session.provider, Provider.omp.value);
      expect(session.claudeSessionId, '01a0e960-d626-7359-b8e8-44ce5c598088');
      expect(session.ompModel, 'baseten/zai-org/GLM-5.3-Fast');
      expect(session.ompThinkingLevel, 'high');
      expect(session.executionMode, 'acceptEdits');
      expect(session.effectivePermissionMode, 'acceptEdits');
      expect(session.resolvedPlanMode, isFalse);

      final models = message.ompModels!;
      expect(models.map((model) => model.selector), [
        'baseten/zai-org/GLM-5.3-Fast',
        'baseten/MiniMaxAI/MiniMax-M3',
      ]);
      expect(models.first.thinkingLevels, ['off', 'high', 'max']);
      expect(models.last.thinkingLevels, ['off']);
      expect(models.last.input, ['text']);
      expect(message.ompAvailability, OmpAvailability.available);
      expect(message.ompModelsRevision, 1);
    });

    test('omp-recent-sessions parses the omp entry', () {
      final message = ServerMessage.fromJson(
        fixture('omp-recent-sessions'),
      ) as RecentSessionsMessage;
      final session = message.sessions.single;

      expect(session.provider, Provider.omp.value);
      expect(session.name, 'Fix login redirect');
      expect(session.ompModel, 'baseten/zai-org/GLM-5.3-Fast');
      expect(session.ompThinkingLevel, 'high');
      expect(session.resumeCwd, '/home/user/project-worktrees/fix-login');
      expect(session.projectPath, '/home/user/project');
      expect(session.workspaceKind, 'unassigned');
      expect(message.requestId, 'recent-2');
    });

    test('omp-session-created parses the start and resume variants', () {
      final variants = fixtureVariants('omp-session-created')
          .map((json) => ServerMessage.fromJson(json) as SystemMessage)
          .toList();

      expect(variants, hasLength(2));
      for (final message in variants) {
        expect(message.subtype, 'session_created');
        expect(message.provider, Provider.omp.value);
        expect(message.model, 'baseten/zai-org/GLM-5.3-Fast');
        expect(message.thinkingLevel, 'high');
        expect(message.planMode, isFalse);
        expect(message.executionMode, 'acceptEdits');
      }
      expect(variants.first.requestId, 'pending_1790447032742');
      expect(
        variants.last.claudeSessionId,
        '01a0e960-d626-7359-b8e8-44ce5c598088',
      );
      expect(variants.last.resumeRequestId, startsWith('session-list:'));
    });

    test('omp-init and omp-settings carry model and thinking levels', () {
      final init = ServerMessage.fromJson(fixture('omp-init')) as SystemMessage;
      expect(init.subtype, 'init');
      expect(init.provider, Provider.omp.value);
      expect(init.thinkingLevel, 'high');
      expect(init.thinkingLevels, ['off', 'high', 'max']);
      expect(init.permissionMode, 'acceptEdits');

      final settings =
          ServerMessage.fromJson(fixture('omp-settings')) as SystemMessage;
      expect(settings.subtype, 'omp_settings');
      expect(settings.model, 'baseten/MiniMaxAI/MiniMax-M3');
      expect(settings.thinkingLevel, 'off');
      expect(settings.thinkingLevels, ['off']);
    });
  });

  group('omp client fixtures', () {
    test('clientCapabilities matches omp-client-capabilities', () {
      expect(
        encode(
          ClientMessage.clientCapabilities(
            protocolVersion: 1,
            minimumProtocolVersion: 1,
            supportedServerMessages: const [
              'conversation_queue',
              'session_context',
            ],
          ),
        ),
        fixture('omp-client-capabilities'),
      );
    });

    test('start matches omp-start', () {
      expect(
        encode(
          ClientMessage.start(
            '/home/user/project',
            provider: 'omp',
            permissionMode: 'acceptEdits',
            executionMode: 'acceptEdits',
            model: 'baseten/zai-org/GLM-5.3-Fast',
            thinkingLevel: 'high',
            autoRename: true,
            requestId: 'pending_1790447032742',
          ),
        ),
        fixture('omp-start'),
      );
    });

    test('resumeSession matches omp-resume', () {
      final expected = fixture('omp-resume');
      expect(
        encode(
          ClientMessage.resumeSession(
            expected['sessionId'] as String,
            expected['projectPath'] as String,
            provider: 'omp',
            executionMode: 'acceptEdits',
            resumeRequestId: expected['resumeRequestId'] as String,
          ),
        ),
        expected,
      );
    });

    test('setOmpModel matches omp-set-model', () {
      expect(
        encode(
          ClientMessage.setOmpModel(
            '3f9c2a1b',
            model: 'baseten/MiniMaxAI/MiniMax-M3',
            thinkingLevel: 'off',
          ),
        ),
        fixture('omp-set-model'),
      );
    });

    test(
      'listRecentSessions matches both omp-list-recent-sessions variants',
      () {
        final variants = fixtureVariants('omp-list-recent-sessions');
        expect(
          encode(
            ClientMessage.listRecentSessions(
              limit: 20,
              offset: 0,
              requestScope: 'list',
              requestId: 'recent-1',
              providers: const ['claude', 'codex'],
            ),
          ),
          variants.first,
        );
        expect(
          encode(
            ClientMessage.listRecentSessions(
              limit: 20,
              offset: 0,
              requestScope: 'list',
              requestId: 'recent-2',
              provider: 'omp',
            ),
          ),
          variants.last,
        );
      },
    );

    test('resolveSessionLink matches omp-resolve-session-link', () {
      expect(
        encode(
          ClientMessage.resolveSessionLink(
            requestId: 'session-link-1',
            sessionId: '01a0e960-d626-7359-b8e8-44ce5c598088',
            provider: 'omp',
          ),
        ),
        fixture('omp-resolve-session-link'),
      );
    });

    test('archiveSession matches omp-archive-session', () {
      expect(
        encode(
          ClientMessage.archiveSession(
            sessionId: '01a0e960-d626-7359-b8e8-44ce5c598088',
            provider: 'omp',
            projectPath: '/home/user/project',
          ),
        ),
        fixture('omp-archive-session'),
      );
    });
  });
}
