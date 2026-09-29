import 'package:auto_route/auto_route.dart';
import 'package:flutter/material.dart';

import '../features/workspace/state/workspace_destination.dart';
import '../features/workspace/widgets/workspace_session_route_adapter.dart';
import '../models/messages.dart';

/// Route page for an omp session.
///
/// A thin wrapper like `WorkspaceCodexSessionScreen`: it opens the session in
/// the workspace shell, which builds the omp session screen for
/// [Provider.omp].
@RoutePage(name: 'OmpSessionRoute')
class WorkspaceOmpSessionScreen extends StatelessWidget {
  final String sessionId;
  final String? projectPath;
  final SessionWorkspaceInfo? workspace;
  final String? gitBranch;
  final String? worktreePath;
  final bool isPending;
  final String? initialPermissionMode;
  final ValueNotifier<SystemMessage?>? pendingSessionCreated;
  final VoidCallback? onBackToSessions;
  final bool hideSessionBackButton;

  const WorkspaceOmpSessionScreen({
    super.key,
    required this.sessionId,
    this.projectPath,
    this.workspace,
    this.gitBranch,
    this.worktreePath,
    this.isPending = false,
    this.initialPermissionMode,
    this.pendingSessionCreated,
    this.onBackToSessions,
    this.hideSessionBackButton = false,
  });

  @override
  Widget build(BuildContext context) {
    return WorkspaceSessionRouteAdapter(
      selection: WorkspaceSessionSelection(
        sessionId: sessionId,
        provider: Provider.omp,
        projectPath: projectPath,
        workspace: workspace,
        gitBranch: gitBranch,
        worktreePath: worktreePath,
        isPending: isPending,
        permissionMode: initialPermissionMode,
        pendingSessionCreated: pendingSessionCreated,
      ),
    );
  }
}
