import 'dart:async';

import 'package:ccpocket/features/session_link/state/session_link_cubit.dart';
import 'package:ccpocket/features/session_link/state/session_link_state.dart';
import 'package:ccpocket/features/session_list/services/session_resume_coordinator.dart';
import 'package:ccpocket/models/messages.dart';
import 'package:ccpocket/services/bridge_service.dart';
import 'package:flutter_test/flutter_test.dart';

class _SessionLinkBridge extends BridgeService {
  final controller = StreamController<ServerMessage>.broadcast();
  late SessionLinkResolveResult result;
  final resolvedProviders = <String>[];
  Completer<OmpSupport>? ompSupportAnswer;
  int ompSupportWaits = 0;

  @override
  Stream<ServerMessage> get messages => controller.stream;

  @override
  Future<SessionLinkResolveResult> resolveSessionLink(
    String sessionId, {
    String provider = 'claude',
    Duration timeout = const Duration(seconds: 10),
  }) async {
    resolvedProviders.add(provider);
    return result;
  }

  @override
  Future<OmpSupport> waitForConnectionOmpSupport({
    Duration timeout = const Duration(seconds: 10),
  }) {
    ompSupportWaits++;
    return (ompSupportAnswer ??= Completer<OmpSupport>()).future;
  }

  @override
  void dispose() {
    controller.close();
    super.dispose();
  }
}

class _ResumeCoordinator extends SessionResumeCoordinator {
  _ResumeCoordinator({required super.bridge});

  RecentSession? resumedSession;
  String? resumeRequestId;

  @override
  Future<SessionResumeDispatch> resume(
    RecentSession session, {
    String? resumeRequestId,
  }) async {
    resumedSession = session;
    this.resumeRequestId = resumeRequestId;
    return SessionResumeDispatch(
      disposition: SessionResumeDisposition.dispatched,
      projectPath: session.projectPath,
      gitBranch: session.gitBranch,
    );
  }
}

RecentSession _recentSession() => const RecentSession(
  sessionId: 'claude-uuid',
  provider: 'claude',
  firstPrompt: 'Continue',
  created: '2026-07-24T00:00:00Z',
  modified: '2026-07-24T01:00:00Z',
  gitBranch: 'main',
  projectPath: '/workspace/app',
  isSidechain: false,
);

void main() {
  late _SessionLinkBridge bridge;

  setUp(() {
    bridge = _SessionLinkBridge();
  });

  tearDown(() {
    bridge.dispose();
  });

  test('opens an exact live Bridge session', () async {
    bridge.result = const SessionLinkResolveResult.resolved(
      SessionLinkResolutionMessage(
        requestId: 'request-1',
        sourceSessionId: 'claude-uuid',
        status: SessionLinkResolutionStatus.live,
        bridgeSessionId: 'bridge-1',
        provider: 'claude',
      ),
    );
    final cubit = SessionLinkCubit(
      bridge: bridge,
      sourceSessionId: 'claude-uuid',
      provider: 'claude',
    );
    addTearDown(cubit.close);

    await cubit.resolve();

    expect(
      cubit.state,
      const SessionLinkState.openLive(
        bridgeSessionId: 'bridge-1',
        provider: 'claude',
      ),
    );
  });

  group('omp links', () {
    const liveOmp = SessionLinkResolveResult.resolved(
      SessionLinkResolutionMessage(
        requestId: 'request-1',
        sourceSessionId: '01a0e960',
        status: SessionLinkResolutionStatus.live,
        bridgeSessionId: 'bridge-omp',
        provider: 'omp',
      ),
    );

    SessionLinkCubit ompCubit() {
      final cubit = SessionLinkCubit(
        bridge: bridge,
        sourceSessionId: '01a0e960',
        provider: 'omp',
      );
      addTearDown(cubit.close);
      return cubit;
    }

    test('waits for the Bridge capabilities before resolving', () async {
      bridge.result = liveOmp;
      final cubit = ompCubit();

      final resolving = cubit.resolve();
      await Future<void>.delayed(Duration.zero);
      expect(cubit.state, const SessionLinkState.resolving());
      expect(bridge.resolvedProviders, isEmpty);

      bridge.ompSupportAnswer!.complete(OmpSupport.supported);
      await resolving;

      expect(bridge.resolvedProviders, ['omp']);
      expect(
        cubit.state,
        const SessionLinkState.openLive(
          bridgeSessionId: 'bridge-omp',
          provider: 'omp',
        ),
      );
    });

    test('asks for a Bridge update when omp is not supported', () async {
      bridge.ompSupportAnswer = Completer()..complete(OmpSupport.unsupported);
      final cubit = ompCubit();

      await cubit.resolve();

      expect(cubit.state, const SessionLinkState.bridgeUpdateRequired());
      expect(bridge.resolvedProviders, isEmpty);
    });

    test('is unavailable when the capabilities never arrive', () async {
      bridge.ompSupportAnswer = Completer()..complete(OmpSupport.unknown);
      final cubit = ompCubit();

      await cubit.resolve();

      expect(cubit.state, const SessionLinkState.unavailable());
      expect(bridge.resolvedProviders, isEmpty);
    });

    test('Claude links do not wait for omp capabilities', () async {
      bridge.result = const SessionLinkResolveResult.unsupported();
      final cubit = SessionLinkCubit(
        bridge: bridge,
        sourceSessionId: 'claude-uuid',
        provider: 'claude',
      );
      addTearDown(cubit.close);

      await cubit.resolve();

      expect(bridge.ompSupportWaits, 0);
      expect(bridge.resolvedProviders, ['claude']);
    });
  });

  test('falls back to the legacy route for an older Bridge', () async {
    bridge.result = const SessionLinkResolveResult.unsupported();
    final cubit = SessionLinkCubit(
      bridge: bridge,
      sourceSessionId: 'claude-uuid',
      provider: 'claude',
    );
    addTearDown(cubit.close);

    await cubit.resolve();

    expect(cubit.state, const SessionLinkState.openLegacy());
  });

  test('resumes an exact recent session and opens its new runtime', () async {
    final recentSession = _recentSession();
    bridge.result = SessionLinkResolveResult.resolved(
      SessionLinkResolutionMessage(
        requestId: 'request-1',
        sourceSessionId: recentSession.sessionId,
        status: SessionLinkResolutionStatus.recent,
        provider: 'claude',
        recentSession: recentSession,
      ),
    );
    final coordinator = _ResumeCoordinator(bridge: bridge);
    final cubit = SessionLinkCubit(
      bridge: bridge,
      sourceSessionId: recentSession.sessionId,
      provider: 'claude',
      resumeCoordinator: coordinator,
      resumeRequestId: 'link-request-1',
    );
    addTearDown(cubit.close);

    await cubit.resolve();
    expect(cubit.state, const SessionLinkState.resuming());
    expect(coordinator.resumedSession?.sessionId, recentSession.sessionId);
    expect(coordinator.resumeRequestId, 'link-request-1');

    bridge.controller.add(
      const SystemMessage(
        subtype: 'session_created',
        sessionId: 'bridge-2',
        resumeRequestId: 'link-request-1',
        provider: 'claude',
      ),
    );
    await Future.microtask(() {});

    expect(cubit.state, isA<SessionLinkOpenResumed>());
    expect(
      (cubit.state as SessionLinkOpenResumed).session.sessionId,
      'bridge-2',
    );
    expect((cubit.state as SessionLinkOpenResumed).gitBranch, 'main');
  });

  test('ignores resume completions owned by another caller', () async {
    final recentSession = _recentSession();
    bridge.result = SessionLinkResolveResult.resolved(
      SessionLinkResolutionMessage(
        requestId: 'request-1',
        sourceSessionId: recentSession.sessionId,
        status: SessionLinkResolutionStatus.recent,
        provider: 'claude',
        recentSession: recentSession,
      ),
    );
    final coordinator = _ResumeCoordinator(bridge: bridge);
    final cubit = SessionLinkCubit(
      bridge: bridge,
      sourceSessionId: recentSession.sessionId,
      provider: 'claude',
      resumeCoordinator: coordinator,
      resumeRequestId: 'link-request-1',
    );
    addTearDown(cubit.close);

    await cubit.resolve();
    bridge.controller.add(
      const SystemMessage(
        subtype: 'session_created',
        sessionId: 'bridge-other',
        resumeRequestId: 'other-request',
        provider: 'claude',
      ),
    );
    await Future.microtask(() {});

    expect(cubit.state, const SessionLinkState.resuming());
  });

  test('shows unavailable when the resolver has no exact match', () async {
    bridge.result = const SessionLinkResolveResult.resolved(
      SessionLinkResolutionMessage(
        requestId: 'request-1',
        sourceSessionId: 'missing',
        status: SessionLinkResolutionStatus.unavailable,
      ),
    );
    final cubit = SessionLinkCubit(
      bridge: bridge,
      sourceSessionId: 'missing',
      provider: 'claude',
    );
    addTearDown(cubit.close);

    await cubit.resolve();

    expect(cubit.state, const SessionLinkState.unavailable());
  });
}
