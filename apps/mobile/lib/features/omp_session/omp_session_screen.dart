import 'dart:async';
import 'dart:convert';

import 'package:auto_route/auto_route.dart';
import 'package:flutter/material.dart';
import 'package:flutter/services.dart';
import 'package:flutter_bloc/flutter_bloc.dart';
import 'package:flutter_hooks/flutter_hooks.dart';

import '../../constants/feature_flags.dart';
import '../../hooks/use_app_resume_callback.dart';
import '../../hooks/use_scroll_tracking.dart';
import '../../l10n/app_localizations.dart';
import '../../models/messages.dart';
import '../../models/new_session_params.dart' show permissionModeFromRaw;
import '../../providers/bridge_cubits.dart';
import '../../providers/machine_manager_cubit.dart';
import '../../router/app_router.dart';
import '../../router/session_stack_navigation.dart';
import '../../services/bridge_service.dart';
import '../../services/chat_message_handler.dart';
import '../../services/draft_service.dart';
import '../../services/notification_service.dart';
import '../../theme/app_theme.dart';
import '../../utils/composer_tokens.dart';
import '../../utils/diff_parser.dart';
import '../../utils/network_endpoint.dart';
import '../../utils/terminal_launcher.dart';
import '../../widgets/approval_bar.dart';
import '../../widgets/bubbles/ask_user_question_widget.dart';
import '../../widgets/rename_session_dialog.dart';
import '../../widgets/screenshot_sheet.dart';
import '../../widgets/session_name_title.dart';
import '../../widgets/workspace_pane_chrome.dart';
import '../chat_session/state/chat_session_cubit.dart';
import '../chat_session/state/chat_session_state.dart';
import '../chat_session/state/streaming_state_cubit.dart';
import '../chat_session/utils/session_usage.dart';
import '../chat_session/widgets/bottom_overlay_layout.dart';
import '../chat_session/widgets/chat_input_with_overlays.dart';
import '../chat_session/widgets/chat_message_list.dart';
import '../chat_session/widgets/queued_input_panel.dart';
import '../chat_session/widgets/reconnect_banner.dart';
import '../chat_session/widgets/scroll_to_bottom_button.dart';
import '../chat_session/widgets/session_file_list_scope.dart';
import '../chat_session/widgets/session_mode_bar.dart';
import '../chat_session/widgets/status_line_flexible_space.dart';
import '../claude_session/widgets/rewind_message_list_sheet.dart'
    show UserMessageHistorySheet;
import '../claude_session/widgets/usage_summary_bar.dart';
import '../codex_session/widgets/codex_rewind_dialog.dart';
import '../explore/explore_screen.dart';
import '../explore/state/explore_state.dart';
import '../file_browser/file_browser_reference.dart';
import '../git/state/git_status_cubit.dart';
import '../git/state/git_view_cache_service.dart';
import '../session_link/widgets/session_unavailable_view.dart';
import '../session_list/workspace_shell_screen.dart';
import '../settings/state/settings_cubit.dart';
import 'state/omp_session_cubit.dart';

const _fileListRefreshToolNames = {
  'Edit',
  'FileEdit',
  'FileChange',
  'MultiEdit',
  'Write',
  'NotebookEdit',
  'Bash',
};

class _NoopListenable implements Listenable {
  const _NoopListenable();

  @override
  void addListener(VoidCallback listener) {}

  @override
  void removeListener(VoidCallback listener) {}
}

/// omp chat screen.
///
/// Follows the Codex screen: the Bridge keeps a one-item input queue and
/// rewinds the conversation into a new Bridge session. omp has no plan mode,
/// sandbox, goals, tool suggestions, CLI join or fork, and failed messages
/// are not retried (a retry while omp is busy would be queued and drained as
/// a second entry). Shares `ChatMessageList`, `ChatInputWithOverlays` and
/// `SessionModeBar` through [OmpSessionCubit], which extends
/// [ChatSessionCubit].
class OmpSessionScreen extends StatefulWidget {
  final String sessionId;
  final String? projectPath;
  final SessionWorkspaceInfo? workspace;
  final String? gitBranch;
  final String? worktreePath;
  final bool isPending;
  final String? initialPermissionMode;
  final VoidCallback? onBackToSessions;
  final bool hideSessionBackButton;

  /// Notifier from the parent that may already hold a [SystemMessage]
  /// with subtype `session_created` (race condition fix).
  final ValueNotifier<SystemMessage?>? pendingSessionCreated;

  const OmpSessionScreen({
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
  State<OmpSessionScreen> createState() => _OmpSessionScreenState();
}

class _OmpSessionScreenState extends State<OmpSessionScreen> {
  late String _sessionId;
  late String? _projectPath;
  late SessionWorkspaceInfo? _workspace;
  late String? _gitBranch;
  late String? _worktreePath;
  late bool _isPending;
  var _explorerCurrentPath = '';
  List<String> _recentPeekedFiles = const [];
  PermissionMode? _permissionMode;
  StreamSubscription<ServerMessage>? _pendingSub;
  StreamSubscription<ServerMessage>? _sessionReplacedSub;
  StreamSubscription<String>? _sessionStoppedSub;
  final Object _sessionRouteOwner = Object();
  Object? _sessionRouteIdentity;

  @override
  void initState() {
    super.initState();
    final bridge = context.read<BridgeService>();
    _sessionId = widget.sessionId;
    _projectPath = widget.projectPath;
    _workspace = widget.workspace;
    _gitBranch = widget.gitBranch;
    _worktreePath = widget.worktreePath;
    _isPending = widget.isPending;
    _permissionMode = permissionModeFromRaw(widget.initialPermissionMode);
    final explorerHistory = bridge.getExplorerHistory(_sessionId);
    _explorerCurrentPath = explorerHistory.currentPath;
    _recentPeekedFiles = explorerHistory.recentPeekedFiles;

    if (_isPending) {
      _listenForSessionCreated();
    }
    _listenForSessionReplaced();
    _listenForSessionStopped();
  }

  @override
  void didChangeDependencies() {
    super.didChangeDependencies();
    final routeIdentity = ModalRoute.of(context)?.settings;
    if (!identical(_sessionRouteIdentity, routeIdentity)) {
      final previousIdentity = _sessionRouteIdentity;
      if (previousIdentity != null) {
        SessionRouteRegistry.instance.remove(
          routeIdentity: previousIdentity,
          owner: _sessionRouteOwner,
        );
      }
      _sessionRouteIdentity = routeIdentity;
    }
    _syncSessionRouteIdentity();
  }

  void _syncSessionRouteIdentity() {
    final routeIdentity = _sessionRouteIdentity;
    if (routeIdentity == null) return;
    SessionRouteRegistry.instance.update(
      routeIdentity: routeIdentity,
      owner: _sessionRouteOwner,
      sessionId: _sessionId,
      provider: Provider.omp.value,
    );
    final shell = WorkspaceShellScreen.maybeOf(context);
    if (shell != null) {
      shell.updateLiveSession(widget.sessionId, _sessionId);
    } else if (ModalRoute.of(context)?.isCurrent ?? false) {
      NotificationService.instance.setActiveSession(
        sessionId: _sessionId,
        provider: Provider.omp.value,
      );
    }
  }

  void _listenForSessionCreated() {
    // Check if session_list_screen already captured the message (race fix).
    final buffered = widget.pendingSessionCreated?.value;
    if (buffered != null && buffered.sessionId != null) {
      _resolveSession(buffered);
      return;
    }
    // Also listen for future notification via the ValueNotifier.
    widget.pendingSessionCreated?.addListener(_onPendingSessionCreated);

    final bridge = context.read<BridgeService>();
    _pendingSub = bridge.messages.listen((msg) {
      if (msg is SystemMessage && msg.subtype == 'session_created') {
        if (msg.requestId != null && msg.requestId != _sessionId) return;
        if (widget.projectPath != null &&
            msg.projectPath != null &&
            msg.projectPath != widget.projectPath) {
          return;
        }
        if (msg.sessionId != null && mounted) {
          _resolveSession(msg);
        }
      } else if (msg is ErrorMessage &&
          msg.requestId == _sessionId &&
          _isPending &&
          mounted) {
        _pendingSub?.cancel();
        _pendingSub = null;
        widget.pendingSessionCreated?.removeListener(_onPendingSessionCreated);
        if (widget.onBackToSessions case final onBack?) {
          onBack();
        } else {
          context.router.maybePop();
        }
        ScaffoldMessenger.of(context)
            .showSnackBar(SnackBar(content: Text(msg.message)));
      }
    });
  }

  void _onPendingSessionCreated() {
    final msg = widget.pendingSessionCreated?.value;
    if (msg != null &&
        msg.sessionId != null &&
        (msg.requestId == null || msg.requestId == _sessionId) &&
        mounted &&
        _isPending) {
      _resolveSession(msg);
    }
  }

  /// A conversation rewind replaces the Bridge session: the Bridge sends a
  /// `session_created` whose `sourceSessionId` is this session, and the
  /// screen follows it.
  void _listenForSessionReplaced() {
    final bridge = context.read<BridgeService>();
    _sessionReplacedSub = bridge.messages.listen((msg) {
      if (msg is SystemMessage &&
          msg.subtype == 'session_created' &&
          msg.sourceSessionId == _sessionId &&
          msg.sessionId != null &&
          msg.sessionId != _sessionId &&
          !_isPending &&
          mounted) {
        _switchSession(msg);
      }
    });
  }

  void _switchSession(SystemMessage msg) {
    final oldId = _sessionId;
    final newId = msg.sessionId!;
    final draftService = context.read<DraftService>();
    final bridge = context.read<BridgeService>();
    bridge.migrateExplorerHistory(oldId, newId);
    final explorerHistory = bridge.getExplorerHistory(newId);
    draftService.migrateDraft(oldId, newId);
    draftService.migrateImageDraft(oldId, newId);
    setState(() {
      _sessionId = newId;
      _projectPath = msg.projectPath ?? _projectPath;
      _workspace = msg.workspace ?? _workspace;
      _worktreePath = msg.worktreePath ?? _worktreePath;
      _gitBranch = msg.worktreeBranch ?? _gitBranch;
      _permissionMode =
          permissionModeFromRaw(msg.permissionMode) ?? _permissionMode;
      _explorerCurrentPath = explorerHistory.currentPath;
      _recentPeekedFiles = explorerHistory.recentPeekedFiles;
    });
    _syncSessionRouteIdentity();
  }

  void _resolveSession(SystemMessage msg) {
    widget.pendingSessionCreated?.removeListener(_onPendingSessionCreated);
    final oldId = _sessionId;
    final newId = msg.sessionId!;
    // Migrate draft from pending ID to real session ID
    final draftService = context.read<DraftService>();
    draftService.migrateDraft(oldId, newId);
    draftService.migrateImageDraft(oldId, newId);
    setState(() {
      _sessionId = newId;
      _projectPath = msg.projectPath ?? _projectPath;
      _workspace = msg.workspace ?? _workspace;
      _gitBranch = msg.worktreeBranch ?? _gitBranch;
      _worktreePath = msg.worktreePath ?? _worktreePath;
      _permissionMode =
          permissionModeFromRaw(msg.permissionMode) ?? _permissionMode;
      _isPending = false;
    });
    _syncSessionRouteIdentity();
    _pendingSub?.cancel();
    _pendingSub = null;
  }

  void _listenForSessionStopped() {
    final bridge = context.read<BridgeService>();
    _sessionStoppedSub = bridge.stoppedSessions.listen((stoppedSessionId) {
      if (!mounted || stoppedSessionId != _sessionId) return;
      setState(() {
        _explorerCurrentPath = '';
        _recentPeekedFiles = const [];
      });
    });
  }

  void updateExplorerState({
    required String currentPath,
    required List<String> recentPeekedFiles,
  }) {
    context.read<BridgeService>().setExplorerHistory(
      _sessionId,
      currentPath: currentPath,
      recentPeekedFiles: recentPeekedFiles,
    );
    setState(() {
      _explorerCurrentPath = currentPath;
      _recentPeekedFiles = recentPeekedFiles;
    });
  }

  @override
  void didUpdateWidget(covariant OmpSessionScreen oldWidget) {
    super.didUpdateWidget(oldWidget);
    if (oldWidget.sessionId == widget.sessionId &&
        oldWidget.projectPath == widget.projectPath &&
        oldWidget.workspace == widget.workspace &&
        oldWidget.worktreePath == widget.worktreePath &&
        oldWidget.gitBranch == widget.gitBranch &&
        oldWidget.isPending == widget.isPending &&
        oldWidget.initialPermissionMode == widget.initialPermissionMode) {
      return;
    }

    final explorerHistory = context.read<BridgeService>().getExplorerHistory(
      widget.sessionId,
    );
    setState(() {
      _sessionId = widget.sessionId;
      _projectPath = widget.projectPath;
      _workspace = widget.workspace;
      _worktreePath = widget.worktreePath;
      _gitBranch = widget.gitBranch;
      _isPending = widget.isPending;
      _permissionMode = permissionModeFromRaw(widget.initialPermissionMode);
      _explorerCurrentPath = explorerHistory.currentPath;
      _recentPeekedFiles = explorerHistory.recentPeekedFiles;
    });
    _syncSessionRouteIdentity();
  }

  @override
  void dispose() {
    final routeIdentity = _sessionRouteIdentity;
    if (routeIdentity != null) {
      SessionRouteRegistry.instance.remove(
        routeIdentity: routeIdentity,
        owner: _sessionRouteOwner,
      );
    }
    widget.pendingSessionCreated?.removeListener(_onPendingSessionCreated);
    _pendingSub?.cancel();
    _sessionReplacedSub?.cancel();
    _sessionStoppedSub?.cancel();
    super.dispose();
  }

  @override
  Widget build(BuildContext context) {
    if (_isPending) {
      final shell = WorkspaceShellScreen.maybeOf(context);
      final chrome = _resolveSessionPaneChrome(context, shell);
      final leading = _sessionAppBarLeading(
        context,
        onBackToSessions: widget.onBackToSessions,
        hideSessionBackButton: widget.hideSessionBackButton,
      );
      return Scaffold(
        appBar: chrome.wrapAppBar(
          AppBar(
            toolbarHeight: chrome.toolbarHeight,
            leading: chrome.wrapLeading(leading),
            automaticallyImplyLeading: false,
            leadingWidth: chrome.resolveLeadingWidth(
              hasLeading: leading != null,
              baseWidth: chrome.useMacOSAdaptiveChrome
                  ? kWorkspaceMacOSToolbarLeadingSlotWidth
                  : 64,
            ),
          ),
        ),
        body: const Center(
          child: Column(
            mainAxisSize: MainAxisSize.min,
            children: [
              CircularProgressIndicator.adaptive(),
              SizedBox(height: 16),
              Text('Creating session...', style: TextStyle(fontSize: 16)),
            ],
          ),
        ),
      );
    }

    return _OmpProviders(
      key: ValueKey(_sessionId),
      sessionId: _sessionId,
      projectPath: _projectPath,
      workspace: _workspace,
      gitBranch: _gitBranch,
      worktreePath: _worktreePath,
      explorerCurrentPath: _explorerCurrentPath,
      recentPeekedFiles: _recentPeekedFiles,
      permissionMode: _permissionMode,
      onBackToSessions: widget.onBackToSessions,
      hideSessionBackButton: widget.hideSessionBackButton,
    );
  }
}

// ---------------------------------------------------------------------------
// Provider wrapper — creates OmpSessionCubit + StreamingStateCubit
// ---------------------------------------------------------------------------

class _OmpProviders extends StatelessWidget {
  final String sessionId;
  final String? projectPath;
  final SessionWorkspaceInfo? workspace;
  final String? gitBranch;
  final String? worktreePath;
  final String explorerCurrentPath;
  final List<String> recentPeekedFiles;
  final PermissionMode? permissionMode;
  final VoidCallback? onBackToSessions;
  final bool hideSessionBackButton;

  const _OmpProviders({
    super.key,
    required this.sessionId,
    this.projectPath,
    this.workspace,
    this.gitBranch,
    this.worktreePath,
    this.explorerCurrentPath = '',
    this.recentPeekedFiles = const [],
    this.permissionMode,
    this.onBackToSessions,
    this.hideSessionBackButton = false,
  });

  @override
  Widget build(BuildContext context) {
    final bridge = context.read<BridgeService>();
    return MultiBlocProvider(
      providers: [
        BlocProvider(create: (_) => StreamingStateCubit()),
        // Register as ChatSessionCubit so shared widgets can find it.
        BlocProvider<ChatSessionCubit>(
          create: (context) => OmpSessionCubit(
            sessionId: sessionId,
            bridge: bridge,
            streamingCubit: context.read<StreamingStateCubit>(),
            initialExplorerCurrentPath: explorerCurrentPath,
            initialRecentPeekedFiles: recentPeekedFiles,
            initialPermissionMode: permissionMode,
            initialProjectPath: projectPath,
            initialWorktreePath: worktreePath,
            initialGitBranch: gitBranch,
          ),
        ),
      ],
      child: SessionFileListScope(
        bridge: bridge,
        fallbackProjectPath: projectPath,
        child: _OmpChatBody(
          sessionId: sessionId,
          projectPath: projectPath,
          workspace: workspace,
          gitBranch: gitBranch,
          worktreePath: worktreePath,
          onBackToSessions: onBackToSessions,
          hideSessionBackButton: hideSessionBackButton,
        ),
      ),
    );
  }
}

// ---------------------------------------------------------------------------
// Chat body
// ---------------------------------------------------------------------------

class _OmpChatBody extends HookWidget {
  final String sessionId;
  final String? projectPath;
  final SessionWorkspaceInfo? workspace;
  final String? gitBranch;
  final String? worktreePath;
  final VoidCallback? onBackToSessions;
  final bool hideSessionBackButton;

  const _OmpChatBody({
    required this.sessionId,
    this.projectPath,
    this.workspace,
    this.gitBranch,
    this.worktreePath,
    this.onBackToSessions,
    this.hideSessionBackButton = false,
  });

  @override
  Widget build(BuildContext context) {
    final appColors = Theme.of(context).extension<AppColors>()!;
    final l = AppLocalizations.of(context);
    final shell = WorkspaceShellScreen.maybeOf(context);
    final presentationListenable = shell?.presentationListenable;
    // Mutable branch state (refreshed from Bridge)
    final currentBranch = useState(gitBranch);
    final showRemoteGitStatusBadge = context.select(
      (SettingsCubit cubit) => cubit.state.showRemoteGitStatusBadge,
    );
    final settingsCubit = context.read<SettingsCubit>();

    // Custom hooks
    final lifecycleState = useAppLifecycleState();
    final isBackground =
        lifecycleState != null && lifecycleState != AppLifecycleState.resumed;
    final isBackgroundRef = useRef(isBackground);
    isBackgroundRef.value = isBackground;
    final scroll = useScrollTracking(sessionId);

    // Chat input controller
    final chatInputController = useMemoized(ComposerTextEditingController.new);
    useEffect(() => chatInputController.dispose, [chatInputController]);
    final planFeedbackController = useTextEditingController();
    final draftService = context.read<DraftService>();

    // --- Draft persistence: restore on mount, auto-save on change ---
    useEffect(() {
      final draft = draftService.getDraft(sessionId);
      if (draft != null && draft.isNotEmpty) {
        chatInputController.text = draft;
        chatInputController.selection = TextSelection.collapsed(
          offset: draft.length,
        );
      }

      Timer? debounce;
      void onChanged() {
        debounce?.cancel();
        debounce = Timer(const Duration(milliseconds: 500), () {
          draftService.saveDraft(sessionId, chatInputController.text);
        });
      }

      chatInputController.addListener(onChanged);
      return () {
        debounce?.cancel();
        // Flush current text on dispose (navigating away)
        draftService.saveDraft(sessionId, chatInputController.text);
        chatInputController.removeListener(onChanged);
      };
    }, [sessionId]);
    // Collapse tool results notifier (shared widget needs it)
    final collapseToolResults = useMemoized(() => ValueNotifier<int>(0));
    useEffect(() => collapseToolResults.dispose, const []);

    // Scroll-to-user-entry notifier (for message history jump)
    final scrollToUserEntry = useMemoized(
      () => ValueNotifier<UserChatEntry?>(null),
    );
    useEffect(() => scrollToUserEntry.dispose, const []);

    // Diff selection from GitScreen navigation
    final diffSelectionFromNav = useState<DiffSelection?>(null);

    // --- Bloc state ---
    final chatSessionCubit = context.read<ChatSessionCubit>();
    final sessionState = context.watch<ChatSessionCubit>().state;
    final bridgeState = context.watch<ConnectionCubit>().state;
    final effectiveProjectPath = _firstNonEmptyProjectPath(
      sessionState.projectPath,
      projectPath,
    );
    final effectiveWorktreePath = _firstNonEmptyProjectPath(
      sessionState.worktreePath,
      worktreePath,
    );
    final gitProjectPath = effectiveWorktreePath ?? effectiveProjectPath;
    final gitBadgeTone = _gitBadgeToneOf(
      context,
      sessionId,
      gitProjectPath,
      showRemoteGitStatusBadge: showRemoteGitStatusBadge,
    );
    final parentState = context
        .findAncestorStateOfType<_OmpSessionScreenState>();
    void handleExploreResult(ExploreScreenResult result) {
      if (!context.mounted) return;
      parentState?.updateExplorerState(
        currentPath: result.currentPath,
        recentPeekedFiles: result.recentPeekedFiles,
      );
      final cubit = context.read<ChatSessionCubit>();
      cubit.setExplorerCurrentPath(result.currentPath);
      cubit.setRecentPeekedFiles(result.recentPeekedFiles);
    }

    void handleFilePeekOpened(String filePath) {
      if (!context.mounted) return;
      final currentPath =
          parentState?._explorerCurrentPath ?? sessionState.explorerCurrentPath;
      final recentPeekedFiles = updateRecentPeekedFiles(
        parentState?._recentPeekedFiles ?? sessionState.recentPeekedFiles,
        filePath,
      );
      parentState?.updateExplorerState(
        currentPath: currentPath,
        recentPeekedFiles: recentPeekedFiles,
      );
      context.read<ChatSessionCubit>().setRecentPeekedFiles(recentPeekedFiles);
    }

    useEffect(() {
      final shell = WorkspaceShellScreen.maybeOf(context);
      shell?.registerSessionToolPaneBindings(
        sessionId: sessionId,
        diffSelectionNotifier: diffSelectionFromNav,
        onExploreResultChanged: handleExploreResult,
        onFilePeekOpened: handleFilePeekOpened,
      );
      final unregisterReference = FileBrowserReferences.register(
        context.read<BridgeService>(),
        sessionId,
        chatInputController.insertFileReference,
      );
      return () {
        unregisterReference();
        shell?.unregisterSessionToolPaneBindings(sessionId);
      };
    }, [sessionId]);

    final tokenUsage = collectTokenUsage(sessionState.entries);
    final toolUsage = collectToolUsage(sessionState.entries);

    // --- Side effects subscription ---
    useEffect(() {
      final sub = chatSessionCubit.sideEffects.listen(
        (effects) => _executeSideEffects(
          effects,
          sessionId: sessionId,
          isBackground: isBackgroundRef.value,
          remoteNotificationsReady: settingsCubit.state.fcmReady,
          approval: chatSessionCubit.state.approval,
          l: l,
          collapseToolResults: collapseToolResults,
          planFeedbackController: planFeedbackController,
          isReadingHistory: scroll.isReadingHistoryNow,
        ),
      );
      return sub.cancel;
    }, [sessionId]);

    // --- Initial requests on mount ---
    useEffect(
      () {
        final bridge = context.read<BridgeService>();
        final path = gitProjectPath;
        if (!isBackground && effectiveProjectPath != null) {
          bridge.requestFileList(effectiveProjectPath);
        }
        if (!isBackground && path != null && path.isNotEmpty) {
          try {
            context.read<GitStatusCubit>().refresh(
              sessionId: sessionId,
              projectPath: path,
              includeRemote: showRemoteGitStatusBadge,
            );
          } catch (_) {}
        }
        if (!isBackground) {
          bridge.requestSessionList();
          bridge.refreshBranch(sessionId);
        }
        return null;
      },
      [
        sessionId,
        effectiveProjectPath,
        gitProjectPath,
        showRemoteGitStatusBadge,
      ],
    );

    useEffect(
      () {
        if (effectiveProjectPath == null) return null;

        final bridge = context.read<BridgeService>();
        GitStatusCubit? gitStatusCubit;
        GitViewCacheService? gitViewCache;
        try {
          gitStatusCubit = context.read<GitStatusCubit>();
          gitViewCache = context.read<GitViewCacheService>();
        } catch (_) {}
        final sub = bridge.messagesForSession(sessionId).listen((msg) {
          if (isBackgroundRef.value) return;
          if (msg case ToolResultMessage(:final toolName)
              when _fileListRefreshToolNames.contains(toolName)) {
            bridge.requestFileList(effectiveProjectPath);
          } else if (msg case ResultMessage(:final fileEdits)) {
            if ((fileEdits ?? 0) > 0) {
              bridge.requestFileList(effectiveProjectPath);
            }
            gitStatusCubit?.refresh(
              sessionId: sessionId,
              projectPath: gitProjectPath!,
              includeRemote: showRemoteGitStatusBadge,
            );
            gitViewCache?.refreshIfPresent(sessionId);
          }
        });
        return sub.cancel;
      },
      [
        sessionId,
        effectiveProjectPath,
        gitProjectPath,
        showRemoteGitStatusBadge,
      ],
    );

    // --- Listen for branch updates ---
    useEffect(() {
      final sub = context.read<BridgeService>().messages.listen((msg) {
        if (msg is BranchUpdateMessage && msg.sessionId == sessionId) {
          currentBranch.value = msg.branch.isNotEmpty ? msg.branch : null;
        }
      });
      return sub.cancel;
    }, [sessionId]);

    // --- App resume: verify WebSocket health + refresh history ---
    // Only triggers on genuine resume from paused/hidden/detached, not from
    // inactive (e.g. Android notification shade).
    useAppResumeCallback(lifecycleState, () {
      final bridge = context.read<BridgeService>();
      bridge.ensureConnected();
      if (bridge.isConnected) {
        context.read<ChatSessionCubit>().refreshHistory();
        if (effectiveProjectPath != null) {
          bridge.requestFileList(effectiveProjectPath);
        }
        if (gitProjectPath != null && gitProjectPath.isNotEmpty) {
          try {
            context.read<GitStatusCubit>().refresh(
              sessionId: sessionId,
              projectPath: gitProjectPath,
              includeRemote: showRemoteGitStatusBadge,
            );
          } catch (_) {}
        }
        bridge.requestSessionList();
        bridge.refreshBranch(sessionId);
      }
    });

    // --- Destructure state ---
    final status = sessionState.status;
    final approval = sessionState.approval;
    final queuedInput = sessionState.queuedInput;

    // Approval state pattern matching (omp: permission + ask-user only)
    String? pendingToolUseId;
    PermissionRequestMessage? pendingPermission;
    String? askToolUseId;
    Map<String, dynamic>? askInput;

    switch (approval) {
      case ApprovalPermission(:final toolUseId, :final request):
        pendingToolUseId = toolUseId;
        pendingPermission = request;
      case ApprovalAskUser(:final toolUseId, :final input):
        askToolUseId = toolUseId;
        askInput = input;
      case ApprovalNone():
        break;
    }

    void approveToolUse() {
      if (pendingToolUseId == null) return;
      context.read<ChatSessionCubit>().approve(pendingToolUseId);
      planFeedbackController.clear();
    }

    void rejectToolUse() {
      if (pendingToolUseId == null) return;
      context.read<ChatSessionCubit>().reject(pendingToolUseId);
      planFeedbackController.clear();
    }

    void approveAlwaysToolUse() {
      if (pendingToolUseId == null) return;
      HapticFeedback.mediumImpact();
      context.read<ChatSessionCubit>().approveAlways(pendingToolUseId);
    }

    void answerQuestion(String toolUseId, String result) {
      context.read<ChatSessionCubit>().answer(toolUseId, result);
    }

    void declineQuestion(String toolUseId) {
      HapticFeedback.mediumImpact();
      context.read<ChatSessionCubit>().reject(toolUseId);
    }

    // --- Build ---
    return BlocListener<ConnectionCubit, BridgeConnectionState>(
      listener: (context, state) {
        if (state == BridgeConnectionState.connected) {
          context.read<ChatSessionCubit>().refreshHistory();
        }
      },
      child: CallbackShortcuts(
        bindings: <ShortcutActivator, VoidCallback>{
          const SingleActivator(LogicalKeyboardKey.escape): () {
            Navigator.of(context).maybePop();
          },
          // Cmd+Shift+P: approval mode menu
          const SingleActivator(
            LogicalKeyboardKey.keyP,
            meta: true,
            shift: true,
          ): () {
            showOmpApprovalMenu(context, context.read<ChatSessionCubit>());
          },
          // Cmd+Enter: approve pending tool use
          const SingleActivator(LogicalKeyboardKey.enter, meta: true): () {
            if (pendingToolUseId != null) approveToolUse();
          },
        },
        child: Focus(
          autofocus: true,
          child: ListenableBuilder(
            listenable: presentationListenable ?? const _NoopListenable(),
            builder: (context, child) {
              final currentShell = WorkspaceShellScreen.maybeOf(context);
              final isSinglePane = currentShell?.isSinglePane ?? true;
              final chrome = _resolveSessionPaneChrome(context, currentShell);
              final leading = _sessionAppBarLeading(
                context,
                onBackToSessions: onBackToSessions,
                hideSessionBackButton: hideSessionBackButton,
              );
              final showMessageHistoryAction = !isSinglePane;
              final double defaultTitleSpacing = isSinglePane
                  ? NavigationToolbar.kMiddleSpacing
                  : (leading == null ? 16 : 12);

              return Scaffold(
                appBar: chrome.wrapAppBar(
                  AppBar(
                    toolbarHeight: chrome.toolbarHeight,
                    leading: chrome.wrapLeading(leading),
                    automaticallyImplyLeading: false,
                    leadingWidth: chrome.resolveLeadingWidth(
                      hasLeading: leading != null,
                      baseWidth: chrome.useMacOSAdaptiveChrome
                          ? kWorkspaceMacOSToolbarLeadingSlotWidth
                          : 64.0,
                    ),
                    titleSpacing: chrome.resolveTitleSpacing(
                      hasLeading: leading != null,
                      fallback: defaultTitleSpacing,
                    ),
                    title: chrome.wrapTitle(
                      SessionNameTitle(
                        sessionId: sessionId,
                        projectPath: effectiveProjectPath,
                        workspace: workspace,
                      ),
                    ),
                    flexibleSpace: StatusLineFlexibleSpace(
                      status: status,
                      inPlanMode: false,
                    ),
                    actions: [
                      if (effectiveProjectPath != null)
                        IconButton(
                          key: const ValueKey('appbar_explore_button'),
                          icon: Icon(
                            Icons.folder_outlined,
                            size: 18,
                            color: Theme.of(context)
                                .colorScheme
                                .onSurfaceVariant,
                          ),
                          padding: EdgeInsets.zero,
                          constraints: const BoxConstraints(
                            minWidth: 32,
                            minHeight: 32,
                          ),
                          tooltip: 'Explore',
                          onPressed: () async {
                            final shell = WorkspaceShellScreen.maybeOf(context);
                            final initialPath =
                                parentState?._explorerCurrentPath ??
                                sessionState.explorerCurrentPath;
                            final recentPeekedFiles =
                                parentState?._recentPeekedFiles ??
                                sessionState.recentPeekedFiles;
                            if (shell?.canOpenToolPane ?? false) {
                              shell!.openExplorePane(
                                sessionId: sessionId,
                                projectPath: effectiveProjectPath,
                                initialFiles: context
                                    .read<FileListCubit>()
                                    .state,
                                initialPath: initialPath,
                                recentPeekedFiles: recentPeekedFiles,
                                onResultChanged: handleExploreResult,
                              );
                              return;
                            }
                            final result = await openExplorerScreen(
                              context,
                              sessionId: sessionId,
                              projectPath: effectiveProjectPath,
                              initialFiles: context.read<FileListCubit>().state,
                              initialPath: initialPath,
                              recentPeekedFiles: recentPeekedFiles,
                            );
                            if (result is! ExploreScreenResult ||
                                !context.mounted) {
                              return;
                            }
                            handleExploreResult(result);
                          },
                        ),
                      if (effectiveProjectPath != null)
                        IconButton(
                          key: const ValueKey('appbar_view_changes'),
                          icon: Badge(
                            isLabelVisible: gitBadgeTone != null,
                            backgroundColor: _gitBadgeColor(
                              context,
                              gitBadgeTone,
                            ),
                            smallSize: 8,
                            child: Icon(
                              Icons.difference,
                              size: 18,
                              color: Theme.of(context)
                                  .colorScheme
                                  .onSurfaceVariant,
                            ),
                          ),
                          padding: EdgeInsets.zero,
                          constraints: const BoxConstraints(
                            minWidth: 32,
                            minHeight: 32,
                          ),
                          onPressed: () {
                            _openGitScreen(
                              context,
                              effectiveWorktreePath ?? effectiveProjectPath,
                              diffSelectionFromNav,
                              sessionId: sessionId,
                              worktreePath: effectiveWorktreePath,
                              onFilePeekOpened: handleFilePeekOpened,
                            );
                          },
                        ),
                      if (showMessageHistoryAction)
                        IconButton(
                          key: const ValueKey('appbar_message_history_button'),
                          icon: Icon(
                            Icons.history,
                            size: 18,
                            color: Theme.of(context)
                                .colorScheme
                                .onSurfaceVariant,
                          ),
                          padding: EdgeInsets.zero,
                          constraints: const BoxConstraints(
                            minWidth: 32,
                            minHeight: 32,
                          ),
                          tooltip: l.messageHistory,
                          onPressed: () {
                            _showUserMessageHistory(
                              context,
                              scrollToUserEntry,
                              sessionId,
                              chatInputController,
                              draftService,
                            );
                          },
                        ),
                      _OmpOverflowMenu(
                        sessionId: sessionId,
                        projectPath: effectiveProjectPath,
                        showMessageHistoryItem: !showMessageHistoryAction,
                        onShowMessageHistory: () => _showUserMessageHistory(
                          context,
                          scrollToUserEntry,
                          sessionId,
                          chatInputController,
                          draftService,
                        ),
                      ),
                    ],
                  ),
                ),
                body: sessionState.sessionUnavailable
                    ? SessionUnavailableView(
                        onOpenRecentSessions:
                            onBackToSessions ??
                            () {
                              context.router.replaceAll([AdaptiveHomeRoute()]);
                            },
                      )
                    : child,
              );
            },
            child: Column(
              children: [
                UsageSummaryBar(
                  totalCost: sessionState.totalCost,
                  totalDuration: sessionState.totalDuration,
                  inputTokens: tokenUsage.inputTokens,
                  cachedInputTokens: tokenUsage.cachedInputTokens,
                  outputTokens: tokenUsage.outputTokens,
                  toolCalls: toolUsage.toolCalls,
                  fileEdits: toolUsage.fileEdits,
                ),
                if (bridgeState == BridgeConnectionState.reconnecting ||
                    bridgeState == BridgeConnectionState.disconnected)
                  ReconnectBanner(bridgeState: bridgeState),
                Expanded(
                  child: BottomOverlayLayout(
                    overlay:
                        askToolUseId == null &&
                            askInput == null &&
                            pendingToolUseId == null
                        ? null
                        : NotificationListener<ScrollNotification>(
                            onNotification: (notification) {
                              if (notification is UserScrollNotification) {
                                FocusScope.of(context).unfocus();
                              }
                              return false;
                            },
                            child: SingleChildScrollView(
                              reverse: true,
                              child: Column(
                                mainAxisSize: MainAxisSize.min,
                                children: [
                                  if (askToolUseId case final askId?
                                      when askInput != null) ...[
                                    AskUserQuestionWidget(
                                      toolUseId: askId,
                                      input: askInput,
                                      agentName: Provider.omp.label,
                                      onAnswer: answerQuestion,
                                    ),
                                    OmpAskDeclineBar(
                                      abortsTurn: !_isOmpGenericDialogId(askId),
                                      onDecline: () => declineQuestion(askId),
                                    ),
                                  ],
                                  if (pendingToolUseId != null) ...[
                                    ApprovalBar(
                                      key: ValueKey(
                                        'approval_$pendingToolUseId',
                                      ),
                                      appColors: appColors,
                                      pendingPermission: pendingPermission,
                                      isPlanApproval: false,
                                      planApprovalUiMode:
                                          PlanApprovalUiMode.codex,
                                      planFeedbackController:
                                          planFeedbackController,
                                      onApprove: approveToolUse,
                                      onReject: rejectToolUse,
                                      onApproveAlways: approveAlwaysToolUse,
                                    ),
                                    if (pendingPermission
                                            ?.canApproveForSession ??
                                        true)
                                      const OmpApproveAlwaysScopeNote(),
                                  ],
                                ],
                              ),
                            ),
                          ),
                    topOverlay: sessionState.sessionContextLoaded
                        ? const Positioned(
                            top: 0,
                            left: 0,
                            right: 0,
                            child: Center(child: SessionModeBar()),
                          )
                        : null,
                    floatingButtonBuilder: (overlayHeight) {
                      if (!scroll.showScrollToLatest) {
                        return const SizedBox.shrink();
                      }
                      return Positioned(
                        right: 12,
                        bottom: overlayHeight + 12,
                        child: ScrollToBottomButton(
                          onPressed: scroll.goToLatest,
                        ),
                      );
                    },
                    content: ChatMessageList(
                      sessionId: sessionId,
                      scrollController: scroll.controller,
                      httpBaseUrl: context.read<BridgeService>().httpBaseUrl,
                      projectPath: effectiveProjectPath,
                      onRetryMessage: null,
                      onRewindMessage: (entry) {
                        _showOmpRewindDialog(
                          context,
                          entry,
                          sessionId: sessionId,
                          inputController: chatInputController,
                          draftService: draftService,
                        );
                      },
                      scrollToUserEntry: scrollToUserEntry,
                      collapseToolResults: collapseToolResults,
                      bottomPadding: 8,
                      isCodex: false,
                      isReadingHistory: scroll.isReadingHistory,
                      onScrollMetricsChanged: scroll.onScrollMetricsChanged,
                      onFilePeekOpened: context
                          .read<ChatSessionCubit>()
                          .recordPeekedFile,
                    ),
                  ),
                ),
                if (approval is ApprovalNone)
                  if (queuedInput != null)
                    CodexQueuedInputPanel(
                      item: queuedInput,
                      isOfflinePending: ChatSessionCubit.isOfflineQueuedInput(
                        queuedInput,
                      ),
                      isDeliveryPending:
                          ChatSessionCubit.isDeliveryPendingQueuedInput(
                            queuedInput,
                          ),
                      onSteer:
                          ChatSessionCubit.isOfflineQueuedInput(queuedInput) ||
                              ChatSessionCubit.isDeliveryPendingQueuedInput(
                                queuedInput,
                              )
                          ? null
                          : () => context
                                .read<ChatSessionCubit>()
                                .steerQueuedInput(queuedInput),
                      onEdit: () => moveQueuedInputToComposer(
                        inputController: chatInputController,
                        item: queuedInput,
                        cancelQueuedInput: () => context
                            .read<ChatSessionCubit>()
                            .cancelQueuedInput(queuedInput),
                      ),
                      onCancel: () => context
                          .read<ChatSessionCubit>()
                          .cancelQueuedInput(queuedInput),
                    ),
                if (approval is ApprovalNone)
                  ChatInputWithOverlays(
                    sessionId: sessionId,
                    workspace: workspace,
                    status: status,
                    onGoToLatest: scroll.goToLatest,
                    inputController: chatInputController,
                    hintText: l.ompMessagePlaceholder,
                    inputBlocked: queuedInput != null,
                    initialDiffSelection: diffSelectionFromNav.value,
                    onDiffSelectionConsumed: () {},
                    onDiffSelectionCleared: () =>
                        diffSelectionFromNav.value = null,
                    onOpenGitScreen: effectiveProjectPath != null
                        ? (_) => _openGitScreen(
                            context,
                            effectiveWorktreePath ?? effectiveProjectPath,
                            diffSelectionFromNav,
                            sessionId: sessionId,
                            worktreePath: effectiveWorktreePath,
                            onFilePeekOpened: handleFilePeekOpened,
                          )
                        : null,
                  ),
              ],
            ),
          ),
        ),
      ),
    );
  }
}

/// Whether [toolUseId] names a generic omp extension or slash-command dialog
/// (§4.4) rather than a question of omp's `ask` tool.
bool _isOmpGenericDialogId(String toolUseId) =>
    toolUseId.startsWith('omp-dialog:');

/// Decline action for an omp question. omp can only decline an `ask` question
/// by cancelling it, which stops the whole turn, so the action says so
/// ([abortsTurn]). A generic dialog is only cancelled; that it stops the turn
/// is not established, so it gets the action without the note.
class OmpAskDeclineBar extends StatelessWidget {
  final VoidCallback onDecline;
  final bool abortsTurn;

  const OmpAskDeclineBar({
    super.key,
    required this.onDecline,
    this.abortsTurn = true,
  });

  @override
  Widget build(BuildContext context) {
    final l = AppLocalizations.of(context);
    final appColors = Theme.of(context).extension<AppColors>()!;
    return Material(
      color: appColors.askBubble.withValues(alpha: 0.7),
      child: SafeArea(
        top: false,
        child: Padding(
          padding: const EdgeInsets.fromLTRB(16, 0, 8, 4),
          child: Row(
            children: [
              if (abortsTurn) ...[
                Icon(Icons.info_outline, size: 14, color: appColors.subtleText),
                const SizedBox(width: 6),
                Expanded(
                  child: Text(
                    l.ompAskDeclineAborts,
                    key: const ValueKey('omp_ask_decline_note'),
                    style: TextStyle(fontSize: 12, color: appColors.subtleText),
                  ),
                ),
              ] else
                const Spacer(),
              TextButton(
                key: const ValueKey('omp_ask_decline_button'),
                onPressed: onDecline,
                child: Text(l.reject),
              ),
            ],
          ),
        ),
      ),
    );
  }
}

/// Scope of omp's approve-always: every call of that tool for the rest of
/// this session.
class OmpApproveAlwaysScopeNote extends StatelessWidget {
  const OmpApproveAlwaysScopeNote({super.key});

  @override
  Widget build(BuildContext context) {
    final l = AppLocalizations.of(context);
    final appColors = Theme.of(context).extension<AppColors>()!;
    return Material(
      color: appColors.approvalBar,
      child: SafeArea(
        top: false,
        child: Padding(
          padding: const EdgeInsets.fromLTRB(16, 0, 16, 8),
          child: Row(
            children: [
              Icon(Icons.info_outline, size: 14, color: appColors.subtleText),
              const SizedBox(width: 6),
              Expanded(
                child: Text(
                  l.ompApproveAlwaysScope,
                  key: const ValueKey('omp_approve_always_scope'),
                  style: TextStyle(fontSize: 12, color: appColors.subtleText),
                ),
              ),
            ],
          ),
        ),
      ),
    );
  }
}

class _OmpOverflowMenu extends StatelessWidget {
  final String sessionId;
  final String? projectPath;
  final bool showMessageHistoryItem;
  final VoidCallback onShowMessageHistory;

  const _OmpOverflowMenu({
    required this.sessionId,
    required this.projectPath,
    required this.showMessageHistoryItem,
    required this.onShowMessageHistory,
  });

  @override
  Widget build(BuildContext context) {
    final projectPath = this.projectPath;
    return PopupMenuButton<String>(
      key: const ValueKey('session_overflow_menu'),
      icon: Icon(
        Icons.more_horiz,
        size: 18,
        color: Theme.of(context).colorScheme.onSurfaceVariant,
      ),
      padding: EdgeInsets.zero,
      constraints: const BoxConstraints(minWidth: 32, minHeight: 32),
      onSelected: (value) {
        switch (value) {
          case 'history':
            onShowMessageHistory();
          case 'screenshot':
            if (projectPath == null) return;
            showScreenshotSheet(
              context: context,
              bridge: context.read<BridgeService>(),
              projectPath: projectPath,
              sessionId: sessionId,
            );
          case 'gallery':
            _openGalleryScreen(context, sessionId: sessionId);
          case 'rename':
            _renameSession(context, sessionId);
          case 'terminal':
            _openInTerminal(context, projectPath);
        }
      },
      itemBuilder: (context) {
        final terminalConfig = context.read<SettingsCubit>().state.terminalApp;
        final l = AppLocalizations.of(context);
        return [
          const PopupMenuItem(
            key: ValueKey('menu_rename'),
            value: 'rename',
            child: ListTile(
              leading: Icon(Icons.edit_outlined, size: 20),
              title: Text('Rename'),
              dense: true,
              contentPadding: EdgeInsets.zero,
            ),
          ),
          if (showMessageHistoryItem)
            PopupMenuItem(
              key: const ValueKey('menu_message_history'),
              value: 'history',
              child: ListTile(
                leading: const Icon(Icons.chat_outlined, size: 20),
                title: Text(l.messageHistory),
                dense: true,
                contentPadding: EdgeInsets.zero,
              ),
            ),
          if (projectPath != null)
            const PopupMenuItem(
              key: ValueKey('menu_screenshot'),
              value: 'screenshot',
              child: ListTile(
                leading: Icon(Icons.screenshot_monitor, size: 20),
                title: Text('Screenshot'),
                dense: true,
                contentPadding: EdgeInsets.zero,
              ),
            ),
          const PopupMenuItem(
            key: ValueKey('menu_gallery'),
            value: 'gallery',
            child: ListTile(
              leading: Icon(Icons.collections, size: 20),
              title: Text('Gallery'),
              dense: true,
              contentPadding: EdgeInsets.zero,
            ),
          ),
          if (FeatureFlags.current.isEnabled(
                AppFeature.terminalAppIntegration,
              ) &&
              terminalConfig.isConfigured &&
              projectPath != null)
            PopupMenuItem(
              key: const ValueKey('menu_terminal'),
              value: 'terminal',
              child: ListTile(
                leading: const Icon(Icons.terminal, size: 20),
                title: Text(l.openInTerminal),
                dense: true,
                contentPadding: EdgeInsets.zero,
              ),
            ),
        ];
      },
    );
  }
}

Widget? _sessionAppBarLeading(
  BuildContext context, {
  VoidCallback? onBackToSessions,
  bool hideSessionBackButton = false,
}) {
  if (!hideSessionBackButton && onBackToSessions != null) {
    return BackButton(
      key: const ValueKey('session_back_button'),
      onPressed: onBackToSessions,
    );
  }
  if (hideSessionBackButton) {
    return null;
  }
  return BackButton(
    key: const ValueKey('session_back_button'),
    onPressed: () => Navigator.of(context).maybePop(),
  );
}

WorkspacePaneChrome _resolveSessionPaneChrome(
  BuildContext context,
  WorkspaceShellScreenState? shell,
) {
  return resolveWorkspacePaneChrome(
    platform: Theme.of(context).platform,
    isAdaptiveWorkspace: shell != null && !shell.isSinglePane,
    isLeftPaneVisible: shell?.isLeftPaneVisible ?? false,
    slot: WorkspacePaneSlot.center,
  );
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

enum _GitBadgeTone { dirty, remote }

String? _firstNonEmptyProjectPath(String? primary, String? fallback) {
  if (primary?.trim().isNotEmpty == true) return primary;
  if (fallback?.trim().isNotEmpty == true) return fallback;
  return null;
}

_GitBadgeTone? _gitBadgeToneOf(
  BuildContext context,
  String sessionId,
  String? projectPath, {
  required bool showRemoteGitStatusBadge,
}) {
  if (projectPath == null || projectPath.isEmpty) return null;
  try {
    return context.select((GitStatusCubit cubit) {
      final entry = cubit.state.entryFor(sessionId);
      if (entry?.projectPath != projectPath) return null;
      if (entry?.showDirtyBadge == true) return _GitBadgeTone.dirty;
      if (entry?.showRemoteBadge(enabled: showRemoteGitStatusBadge) == true) {
        return _GitBadgeTone.remote;
      }
      return null;
    });
  } catch (_) {
    return null;
  }
}

Color? _gitBadgeColor(BuildContext context, _GitBadgeTone? tone) {
  final error = Theme.of(context).colorScheme.error;
  return switch (tone) {
    _GitBadgeTone.dirty => error,
    _GitBadgeTone.remote => error.withValues(alpha: 0.45),
    null => null,
  };
}

Future<void> _openGitScreen(
  BuildContext context,
  String projectPath,
  ValueNotifier<DiffSelection?> diffSelectionNotifier, {
  String? sessionId,
  String? worktreePath,
  ValueChanged<String>? onFilePeekOpened,
}) async {
  final shell = WorkspaceShellScreen.maybeOf(context);
  if (shell?.canOpenToolPane ?? false) {
    shell!.openGitPane(
      projectPath: projectPath,
      sessionId: sessionId,
      worktreePath: worktreePath,
      diffSelectionNotifier: diffSelectionNotifier,
      onFilePeekOpened: onFilePeekOpened,
    );
    return;
  }
  final selection = await context.router.push<DiffSelection>(
    GitRoute(
      projectPath: projectPath,
      sessionId: sessionId,
      worktreePath: worktreePath,
      onFilePeekOpened: onFilePeekOpened,
    ),
  );
  if (selection != null) {
    diffSelectionNotifier.value = selection.isEmpty ? null : selection;
  }
}

void _openGalleryScreen(BuildContext context, {required String sessionId}) {
  final shell = WorkspaceShellScreen.maybeOf(context);
  if (shell?.canOpenToolPane ?? false) {
    shell!.openSessionGalleryPane(sessionId: sessionId);
    return;
  }
  context.router.push(GalleryRoute(sessionId: sessionId));
}

/// Local notification payload for omp: `main.dart` routes a JSON payload
/// with a provider, a bare id would open the Claude screen.
@visibleForTesting
String ompNotificationPayload(String sessionId) =>
    jsonEncode({'sessionId': sessionId, 'provider': Provider.omp.value});

void _executeSideEffects(
  Set<ChatSideEffect> effects, {
  required String sessionId,
  required bool isBackground,
  required bool remoteNotificationsReady,
  required ApprovalState approval,
  required AppLocalizations l,
  required TextEditingController planFeedbackController,
  required ValueNotifier<int> collapseToolResults,
  required bool Function() isReadingHistory,
}) {
  final useLocalNotification = shouldUseLocalNotificationFallback(
    isBackground: isBackground,
    remoteNotificationsReady: remoteNotificationsReady,
  );
  final payload = ompNotificationPayload(sessionId);
  for (final effect in effects) {
    switch (effect) {
      case ChatSideEffect.heavyHaptic:
        HapticFeedback.heavyImpact();
      case ChatSideEffect.mediumHaptic:
        HapticFeedback.mediumImpact();
      case ChatSideEffect.lightHaptic:
        HapticFeedback.lightImpact();
      case ChatSideEffect.collapseToolResults:
        if (shouldAutoCollapseToolResults(isReadingHistory())) {
          collapseToolResults.value++;
        }
      case ChatSideEffect.clearPlanFeedback:
        planFeedbackController.clear();
      case ChatSideEffect.notifyApprovalRequired:
        if (useLocalNotification) {
          final permission = _notificationPermissionFor(approval);
          if (permission != null) {
            NotificationService.instance.showApprovalNotification(
              permission,
              l: l,
              id: 1,
              payload: payload,
            );
          }
        }
      case ChatSideEffect.notifyAskQuestion:
        if (useLocalNotification) {
          final permission = _notificationPermissionFor(approval);
          if (permission != null) {
            NotificationService.instance.showApprovalNotification(
              permission,
              l: l,
              id: 2,
              payload: payload,
            );
          }
        }
      // omp has no goals.
      case ChatSideEffect.notifyGoalProgress:
      case ChatSideEffect.notifyGoalComplete:
      case ChatSideEffect.notifyGoalBlocked:
      case ChatSideEffect.notifyGoalBudgetLimited:
      case ChatSideEffect.notifyGoalUsageLimited:
        break;
      case ChatSideEffect.notifySessionComplete:
        if (useLocalNotification) {
          NotificationService.instance.showSessionCompleteNotification(
            body: l.ompSessionDone,
            id: 3,
            payload: payload,
          );
        }
    }
  }
}

PermissionRequestMessage? _notificationPermissionFor(ApprovalState approval) {
  return switch (approval) {
    ApprovalPermission(:final request) => request,
    ApprovalAskUser(:final toolUseId, :final input) => PermissionRequestMessage(
      toolUseId: toolUseId,
      toolName: 'AskUserQuestion',
      input: input,
    ),
    _ => null,
  };
}

Future<void> _openInTerminal(BuildContext context, String? projectPath) async {
  if (!FeatureFlags.current.isEnabled(AppFeature.terminalAppIntegration)) {
    return;
  }
  if (projectPath == null) return;
  final config = context.read<SettingsCubit>().state.terminalApp;
  if (!config.isConfigured) return;

  final bridge = context.read<BridgeService>();
  final url = bridge.lastUrl;
  final uri = url != null
      ? Uri.tryParse(
          url
              .replaceFirst('ws://', 'http://')
              .replaceFirst('wss://', 'https://'),
        )
      : null;
  final host = normalizeHostInput(uri?.host ?? '');

  // Resolve SSH user from machine config
  String? sshUser;
  try {
    final machines = context.read<MachineManagerCubit>().state.machines;
    for (final item in machines) {
      if (canonicalHostIdentity(item.machine.host) ==
          canonicalHostIdentity(host)) {
        sshUser = item.machine.sshUsername;
        break;
      }
    }
  } catch (_) {
    // MachineManagerCubit may not be available
  }

  final launched = await launchTerminalApp(
    config: config,
    host: host,
    sshUser: sshUser,
    projectPath: projectPath,
  );

  if (!launched && context.mounted) {
    final l = AppLocalizations.of(context);
    ScaffoldMessenger.of(context)
        .showSnackBar(SnackBar(content: Text(l.terminalAppNotInstalled)));
  }
}

/// omp session names cannot be cleared, so the dialog never returns an
/// empty name.
Future<void> _renameSession(BuildContext context, String sessionId) async {
  final bridge = context.read<BridgeService>();
  final session = bridge.sessions.where((s) => s.id == sessionId).firstOrNull;
  final newName = await showRenameSessionDialog(
    context,
    currentName: session?.name,
    allowClear: false,
  );
  if (newName == null || newName.trim().isEmpty || !context.mounted) return;
  bridge.renameSession(sessionId: sessionId, name: newName);
}

void _showUserMessageHistory(
  BuildContext context,
  ValueNotifier<UserChatEntry?> scrollToUserEntry,
  String sessionId,
  TextEditingController inputController,
  DraftService draftService,
) {
  final cubit = context.read<ChatSessionCubit>();
  final messages = cubit.allUserMessages;

  showModalBottomSheet<void>(
    context: context,
    isScrollControlled: true,
    constraints: macOSModalBottomSheetConstraints(context),
    useSafeArea: true,
    builder: (_) => UserMessageHistorySheet(
      messages: messages,
      onScrollToMessage: (msg) {
        scrollToUserEntry.value = msg;
      },
      onRewindMessage: (msg) => _showOmpRewindDialog(
        context,
        msg,
        sessionId: sessionId,
        inputController: inputController,
        draftService: draftService,
      ),
    ),
  );
}

/// Conversation rewind (omp has no file rewind): the Bridge branches the
/// session before the message and the message goes back to the composer.
void _showOmpRewindDialog(
  BuildContext context,
  UserChatEntry message, {
  required String sessionId,
  required TextEditingController inputController,
  required DraftService draftService,
}) {
  final cubit = context.read<ChatSessionCubit>();

  if (message.messageUuid == null) return;

  showDialog<void>(
    context: context,
    builder: (dialogContext) {
      return CodexRewindDialog(
        messageText: message.text,
        onConfirm: () {
          Navigator.of(dialogContext).pop();
          _restoreRewindMessageToComposer(
            inputController: inputController,
            draftService: draftService,
            sessionId: sessionId,
            text: message.text,
          );
          cubit.rewind(message.messageUuid!, 'conversation');
        },
      );
    },
  );
}

void _restoreRewindMessageToComposer({
  required TextEditingController inputController,
  required DraftService draftService,
  required String sessionId,
  required String text,
}) {
  inputController.value = TextEditingValue(
    text: text,
    selection: TextSelection.collapsed(offset: text.length),
  );
  draftService.saveDraft(sessionId, text);
}
