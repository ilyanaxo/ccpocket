import 'package:auto_route/auto_route.dart';
import 'package:flutter/material.dart';
import 'package:flutter_bloc/flutter_bloc.dart';

import '../../l10n/app_localizations.dart';
import '../../models/messages.dart';
import '../../router/app_router.dart';
import '../workspace/state/workspace_destination.dart';
import '../../router/session_stack_navigation.dart';
import '../../services/bridge_service.dart';
import 'state/session_link_cubit.dart';
import 'state/session_link_state.dart';
import 'widgets/session_unavailable_view.dart';

@RoutePage()
class SessionLinkScreen extends StatelessWidget {
  const SessionLinkScreen({
    super.key,
    required this.sessionId,
    this.provider = 'claude',
  });

  final String sessionId;
  final String provider;

  @override
  Widget build(BuildContext context) {
    return BlocProvider(
      create: (context) => SessionLinkCubit(
        bridge: context.read<BridgeService>(),
        sourceSessionId: sessionId,
        provider: provider,
      )..resolve(),
      child: _SessionLinkScreenBody(
        sourceSessionId: sessionId,
        provider: provider,
      ),
    );
  }
}

class _SessionLinkScreenBody extends StatelessWidget {
  const _SessionLinkScreenBody({
    required this.sourceSessionId,
    required this.provider,
  });

  final String sourceSessionId;
  final String provider;

  @override
  Widget build(BuildContext context) {
    return BlocConsumer<SessionLinkCubit, SessionLinkState>(
      listenWhen: (_, state) => switch (state) {
        SessionLinkOpenLive() ||
        SessionLinkOpenResumed() ||
        SessionLinkOpenLegacy() => true,
        _ => false,
      },
      listener: (context, state) {
        switch (state) {
          case SessionLinkOpenLive(:final bridgeSessionId, :final provider):
            _openSession(
              context,
              sessionId: bridgeSessionId,
              provider: provider,
            );
          case SessionLinkOpenResumed(:final session, :final gitBranch):
            _openSession(
              context,
              sessionId: session.sessionId!,
              provider: session.provider ?? provider,
              projectPath: session.projectPath,
              workspace: session.workspace,
              worktreePath: session.worktreePath,
              gitBranch: session.worktreeBranch ?? gitBranch,
              permissionMode: session.permissionMode,
              sandboxMode: session.sandboxMode,
              approvalPolicy: session.approvalPolicy,
              approvalsReviewer: session.approvalsReviewer,
            );
          case SessionLinkOpenLegacy():
            _openSession(
              context,
              sessionId: sourceSessionId,
              provider: provider,
            );
          default:
            return;
        }
      },
      builder: (context, state) {
        final isUnavailable = state is SessionLinkUnavailable;
        return SessionLinkStatusView(
          unavailable: isUnavailable,
          bridgeUpdateRequired: state is SessionLinkBridgeUpdateRequired,
          resuming: state is SessionLinkResuming,
          onOpenRecentSessions: () {
            context.router.replaceAll([AdaptiveHomeRoute()]);
          },
        );
      },
    );
  }

  void _openSession(
    BuildContext context, {
    required String sessionId,
    required String provider,
    String? projectPath,
    SessionWorkspaceInfo? workspace,
    String? gitBranch,
    String? worktreePath,
    String? permissionMode,
    String? sandboxMode,
    String? approvalPolicy,
    String? approvalsReviewer,
  }) {
    final normalizedProvider = providerFromValue(provider) ?? Provider.claude;
    if (SessionStackNavigation.revealStackedSession(
      context.router,
      sessionId: sessionId,
      provider: normalizedProvider.value,
    )) {
      return;
    }
    final selection = WorkspaceSessionSelection(
      sessionId: sessionId,
      provider: normalizedProvider,
      projectPath: projectPath,
      workspace: workspace,
      gitBranch: gitBranch,
      worktreePath: worktreePath,
      permissionMode: permissionMode,
      sandboxMode: sandboxMode,
      approvalPolicy: approvalPolicy,
      approvalsReviewer: approvalsReviewer,
    );
    if (SessionStackNavigation.openWorkspaceSession(
      context.router,
      selection,
    )) {
      return;
    }
    context.router.replaceAll([AdaptiveHomeRoute(initialSession: selection)]);
  }
}

class SessionLinkStatusView extends StatelessWidget {
  const SessionLinkStatusView({
    super.key,
    required this.unavailable,
    this.bridgeUpdateRequired = false,
    required this.resuming,
    required this.onOpenRecentSessions,
  });

  final bool unavailable;

  /// An omp link on a Bridge without omp support.
  final bool bridgeUpdateRequired;
  final bool resuming;
  final VoidCallback onOpenRecentSessions;

  @override
  Widget build(BuildContext context) {
    final l = AppLocalizations.of(context);
    return Scaffold(
      body: SafeArea(
        child: bridgeUpdateRequired
            ? SessionLinkBridgeUpdateView(
                onOpenRecentSessions: onOpenRecentSessions,
              )
            : unavailable
            ? SessionUnavailableView(onOpenRecentSessions: onOpenRecentSessions)
            : Center(
                child: Padding(
                  padding: const EdgeInsets.all(32),
                  child: Column(
                    mainAxisSize: MainAxisSize.min,
                    children: [
                      const CircularProgressIndicator.adaptive(
                        key: ValueKey('session_link_progress_indicator'),
                      ),
                      const SizedBox(height: 16),
                      Text(
                        resuming
                            ? l.resumingLinkedSession
                            : l.resolvingLinkedSession,
                        textAlign: TextAlign.center,
                      ),
                    ],
                  ),
                ),
              ),
      ),
    );
  }
}

/// An omp session link that the connected Bridge cannot open: the Bridge
/// has to be updated first.
class SessionLinkBridgeUpdateView extends StatelessWidget {
  const SessionLinkBridgeUpdateView({
    super.key,
    required this.onOpenRecentSessions,
  });

  final VoidCallback onOpenRecentSessions;

  @override
  Widget build(BuildContext context) {
    final l = AppLocalizations.of(context);
    final theme = Theme.of(context);
    return Center(
      child: Padding(
        padding: const EdgeInsets.all(32),
        child: Column(
          mainAxisSize: MainAxisSize.min,
          children: [
            Icon(
              Icons.system_update_alt,
              size: 48,
              color: theme.colorScheme.tertiary,
            ),
            const SizedBox(height: 20),
            Text(
              l.bridgeUpdateRequiredForOmp,
              key: const ValueKey('session_link_bridge_update_required'),
              textAlign: TextAlign.center,
              style: theme.textTheme.titleLarge,
            ),
            const SizedBox(height: 8),
            Text(
              l.ompNotAvailableOnBridge,
              textAlign: TextAlign.center,
              style: theme.textTheme.bodyMedium,
            ),
            const SizedBox(height: 24),
            FilledButton.icon(
              key: const ValueKey('open_recent_sessions_button'),
              onPressed: onOpenRecentSessions,
              icon: const Icon(Icons.history),
              label: Text(l.openRecentSessions),
            ),
          ],
        ),
      ),
    );
  }
}
