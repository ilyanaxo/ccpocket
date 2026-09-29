enum OfflinePendingActionKind { start, resume }

enum OfflinePendingActionState { queuedForReconnect, processing }

class OfflinePendingAction {
  const OfflinePendingAction({
    required this.id,
    required this.kind,
    required this.projectPath,
    this.projectId,
    this.workspaceProjectName,
    required this.provider,
    required this.createdAt,
    this.state = OfflinePendingActionState.queuedForReconnect,
    this.canCancel = true,
    this.sessionId,
    this.bridgeUpdateRequired = false,
  });

  final String id;
  final OfflinePendingActionKind kind;
  final String projectPath;
  final String? projectId;
  final String? workspaceProjectName;
  final String provider;
  final DateTime createdAt;
  final OfflinePendingActionState state;
  final bool canCancel;
  final String? sessionId;

  /// The action needs a provider the connected Bridge does not support
  /// (omp without `provider_omp_v1`). It stays queued and is sent once a
  /// Bridge that supports it is connected; the user can cancel it.
  final bool bridgeUpdateRequired;

  String get projectName {
    if (workspaceProjectName?.isNotEmpty == true) {
      return workspaceProjectName!;
    }
    final normalized = projectPath.trim();
    if (normalized.isEmpty) return 'Unknown project';
    final parts = normalized.split('/').where((part) => part.isNotEmpty);
    return parts.isEmpty ? normalized : parts.last;
  }
}
