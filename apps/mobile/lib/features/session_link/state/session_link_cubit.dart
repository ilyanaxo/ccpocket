import 'dart:async';

import 'package:flutter_bloc/flutter_bloc.dart';

import '../../../models/messages.dart';
import '../../../services/bridge_service.dart';
import '../../session_list/services/session_resume_coordinator.dart';
import 'session_link_state.dart';

class SessionLinkCubit extends Cubit<SessionLinkState> {
  SessionLinkCubit({
    required BridgeService bridge,
    required String sourceSessionId,
    required String provider,
    SessionResumeCoordinator? resumeCoordinator,
    String? resumeRequestId,
    this.ompSupportTimeout = const Duration(seconds: 10),
  }) : _bridge = bridge,
       _sourceSessionId = sourceSessionId,
       _provider = provider,
       _resumeRequestId =
           resumeRequestId ??
           'session-link-${DateTime.now().microsecondsSinceEpoch}',
       _resumeCoordinator =
           resumeCoordinator ?? SessionResumeCoordinator(bridge: bridge),
       super(const SessionLinkState.resolving());

  final BridgeService _bridge;

  /// How long an omp link waits for the Bridge's capabilities.
  final Duration ompSupportTimeout;
  final String _sourceSessionId;
  final String _provider;
  final String _resumeRequestId;
  final SessionResumeCoordinator _resumeCoordinator;
  StreamSubscription<ServerMessage>? _resumeSubscription;
  bool _started = false;
  String? _resumeGitBranch;

  Future<void> resolve() async {
    if (_started) return;
    _started = true;
    if (_provider == Provider.omp.value) {
      // Decide only once this connection has announced its capabilities, so
      // a cold-start tap right after connect does not show a false "update
      // required".
      final support = await _bridge.waitForConnectionOmpSupport(
        timeout: ompSupportTimeout,
      );
      if (isClosed) return;
      switch (support) {
        case OmpSupport.supported:
          break;
        case OmpSupport.unsupported:
          emit(const SessionLinkState.bridgeUpdateRequired());
          return;
        case OmpSupport.unknown:
          emit(const SessionLinkState.unavailable());
          return;
      }
    }
    final result = await _bridge.resolveSessionLink(
      _sourceSessionId,
      provider: _provider,
    );
    if (isClosed) return;
    if (result.support == SessionLinkResolveSupport.unsupported) {
      emit(const SessionLinkState.openLegacy());
      return;
    }
    if (result.support == SessionLinkResolveSupport.unavailable) {
      emit(const SessionLinkState.unavailable());
      return;
    }

    final resolution = result.resolution;
    if (resolution == null) {
      emit(const SessionLinkState.unavailable());
      return;
    }
    switch (resolution.status) {
      case SessionLinkResolutionStatus.live:
        final bridgeSessionId = resolution.bridgeSessionId;
        if (bridgeSessionId == null || bridgeSessionId.isEmpty) {
          emit(const SessionLinkState.unavailable());
          return;
        }
        emit(
          SessionLinkState.openLive(
            bridgeSessionId: bridgeSessionId,
            provider: resolution.provider ?? _provider,
          ),
        );
      case SessionLinkResolutionStatus.recent:
        final recentSession = resolution.recentSession;
        if (recentSession == null) {
          emit(const SessionLinkState.unavailable());
          return;
        }
        await _resume(recentSession);
      case SessionLinkResolutionStatus.unavailable:
        emit(const SessionLinkState.unavailable());
    }
  }

  Future<void> _resume(RecentSession session) async {
    await _resumeSubscription?.cancel();
    _resumeSubscription = _bridge.messages.listen(_handleResumeMessage);
    emit(const SessionLinkState.resuming());
    final dispatch = await _resumeCoordinator.resume(
      session,
      resumeRequestId: _resumeRequestId,
    );
    if (isClosed) return;
    _resumeGitBranch = dispatch.gitBranch;
    if (dispatch.disposition == SessionResumeDisposition.alreadyQueued) {
      await _cancelResumeSubscription();
      emit(const SessionLinkState.unavailable());
    }
  }

  void _handleResumeMessage(ServerMessage message) {
    if (isClosed || message is! SystemMessage) return;
    if (message.resumeRequestId != _resumeRequestId) return;
    if (message.subtype == 'session_created' && message.sessionId != null) {
      unawaited(_cancelResumeSubscription());
      emit(
        SessionLinkState.openResumed(
          session: message,
          gitBranch: _resumeGitBranch,
        ),
      );
      return;
    }
    if (message.subtype == 'session_resume_failed') {
      unawaited(_cancelResumeSubscription());
      emit(const SessionLinkState.unavailable());
    }
  }

  Future<void> _cancelResumeSubscription() async {
    await _resumeSubscription?.cancel();
    _resumeSubscription = null;
  }

  @override
  Future<void> close() async {
    await _cancelResumeSubscription();
    return super.close();
  }
}
