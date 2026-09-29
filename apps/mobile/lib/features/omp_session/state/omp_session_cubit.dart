import '../../../models/messages.dart';
import '../../chat_session/state/chat_session_cubit.dart';

/// omp-specific session cubit.
///
/// Extends [ChatSessionCubit] so that shared widgets
/// (`ChatMessageList`, `ChatInputWithOverlays`, etc.) that read
/// `context.read<ChatSessionCubit>()` continue to work. omp has no sandbox,
/// no plan mode and no Codex approval policy, so only the modes the
/// permission mode encodes are taken over.
class OmpSessionCubit extends ChatSessionCubit {
  OmpSessionCubit({
    required super.sessionId,
    required super.bridge,
    required super.streamingCubit,
    super.initialExplorerCurrentPath,
    super.initialRecentPeekedFiles,
    super.initialPermissionMode,
    super.initialProjectPath,
    super.initialWorktreePath,
    super.initialGitBranch,
  }) : super(provider: Provider.omp);
}
