import 'dart:async';

import 'package:flutter_bloc/flutter_bloc.dart';
import 'package:shared_preferences/shared_preferences.dart';

import '../../../models/messages.dart';
import '../../../models/new_session_tab.dart';
import '../../../services/bridge_service.dart';
import 'session_list_state.dart';

const _collapsedProjectPathsKey = 'session_list_collapsed_project_paths';
const _pinnedSessionKeysKey = 'session_list_pinned_session_keys_v1';
const _pinnedProjectPathsKey = 'session_list_pinned_project_paths_v1';
const _projectInitialSessionDisplayLimit = 5;
const _projectSessionDisplayPageSize = 20;

String sessionPinKey({
  required String? provider,
  required String projectPath,
  required String sessionId,
}) => '${provider ?? Provider.claude.value}\n$projectPath\n$sessionId';

String recentSessionPinKey(RecentSession session) => sessionPinKey(
  provider: session.provider,
  projectPath: session.projectPath,
  sessionId: session.sessionId,
);

String? runningSessionPinKey(SessionInfo session) {
  final providerSessionId = session.claudeSessionId;
  if (providerSessionId == null || providerSessionId.isEmpty) return null;
  return sessionPinKey(
    provider: session.provider,
    projectPath: session.projectPath,
    sessionId: providerSessionId,
  );
}

List<T> prioritizePinned<T>(
  Iterable<T> items, {
  required bool Function(T item) isPinned,
  bool Function(T item)? isProjectPinned,
}) {
  final pinned = <T>[];
  final pinnedProjects = <T>[];
  final others = <T>[];
  for (final item in items) {
    if (isPinned(item)) {
      pinned.add(item);
    } else if (isProjectPinned?.call(item) ?? false) {
      pinnedProjects.add(item);
    } else {
      others.add(item);
    }
  }
  return [...pinned, ...pinnedProjects, ...others];
}

/// Manages session list state: sessions, filters, pagination, and
/// accumulated project paths.
///
/// All filters (project, provider, namedOnly, searchQuery) are applied
/// server-side. Filter changes trigger a re-fetch from offset 0 with
/// a skeleton loading state.
class SessionListCubit extends Cubit<SessionListState> {
  final BridgeService _bridge;
  StreamSubscription<List<RecentSession>>? _recentSub;
  StreamSubscription<List<String>>? _projectHistorySub;
  StreamSubscription<ServerMessage>? _messageSub;
  StreamSubscription<OmpSupport>? _ompSupportSub;
  StreamSubscription<List<NewSessionTab>>? _enabledTabsSub;
  Timer? _searchDebounce;
  late final Future<void> _preferencesLoaded;

  /// Agents enabled in the settings: the constructor value, then every value
  /// of its `enabledTabsChanges` stream or [applyEnabledAgents] call.
  List<NewSessionTab> _enabledTabs;

  /// The filter the user chose, restricted to the enabled agents.
  /// [SessionListState.providerFilter] is this filter coerced to the
  /// providers currently offered. Hiding omp while the Bridge does not
  /// confirm it is never persisted, so a stored omp filter comes back once a
  /// Bridge confirms omp.
  ProviderFilter _preferredProviderFilter = ProviderFilter.all;

  /// Provider arguments of the last list request, to re-request "All" when
  /// the effective provider set changes.
  ({String? provider, List<String>? providers})? _lastProviderArgs;

  /// [enabledTabs] and [enabledTabsChanges] carry the agents enabled in the
  /// settings (`SettingsState.newSessionTabs`); every change re-derives the
  /// provider filter and the "All" request.
  SessionListCubit({
    required BridgeService bridge,
    List<NewSessionTab> enabledTabs = defaultNewSessionTabs,
    Stream<List<NewSessionTab>>? enabledTabsChanges,
  }) : _bridge = bridge,
       _enabledTabs = List.unmodifiable(enabledTabs),
       super(const SessionListState()) {
    _recentSub = _bridge.recentSessionsStream.listen(_onSessionsUpdate);
    _projectHistorySub = _bridge.projectHistoryStream.listen(
      _onProjectHistoryUpdate,
    );
    _messageSub = _bridge.messages.listen(_onBridgeMessage);
    _ompSupportSub = _bridge.ompSupportStream.listen(
      (_) => _coerceProviderFilter(),
    );
    _enabledTabsSub = enabledTabsChanges?.listen(applyEnabledAgents);
    _preferencesLoaded = _loadPreferences();
  }

  Future<void> _loadPreferences() async {
    final prefs = await SharedPreferences.getInstance();
    final providerStr = prefs.getString('session_list_provider');
    final namedOnly = prefs.getBool('session_list_named_only');
    final collapsedProjectPaths =
        prefs.getStringList(_collapsedProjectPathsKey)?.toSet() ??
        const <String>{};
    final pinnedSessionKeys =
        prefs.getStringList(_pinnedSessionKeysKey)?.toSet() ?? const <String>{};
    final pinnedProjectPaths =
        prefs.getStringList(_pinnedProjectPathsKey)?.toSet() ??
        const <String>{};

    final provider = switch (providerStr) {
      'claude' => ProviderFilter.claude,
      'codex' => ProviderFilter.codex,
      'omp' => ProviderFilter.omp,
      _ => ProviderFilter.all,
    };

    if (isClosed) return;
    _preferredProviderFilter = provider;
    _restrictPreferenceToEnabledAgents();
    emit(
      state.copyWith(
        providerFilter: coerceProviderFilter(
          _preferredProviderFilter,
          _allowedProviderFilters,
        ),
        namedOnly: namedOnly ?? false,
        collapsedProjectPaths: collapsedProjectPaths,
        pinnedSessionKeys: pinnedSessionKeys,
        pinnedProjectPaths: pinnedProjectPaths,
      ),
    );
  }

  void _onSessionsUpdate(List<RecentSession> sessions) {
    final response = _bridge.lastRecentSessionsMessage;
    final projectPath = response?.projectFilterKey;
    final isProjectPage =
        response?.requestScope == 'project' &&
        projectPath != null &&
        projectPath.isNotEmpty;
    final newPaths = sessions
        .map((s) => s.projectPath)
        .where((p) => p.isNotEmpty)
        .toSet();
    final current = state.accumulatedProjectPaths;
    final merged = newPaths.difference(current).isNotEmpty
        ? {...current, ...newPaths}
        : current;

    if (isProjectPage) {
      emit(
        state.copyWith(
          sessions: sessions,
          isInitialLoading: false,
          accumulatedProjectPaths: merged,
          loadingProjectPaths: {...state.loadingProjectPaths}
            ..remove(projectPath),
          exhaustedProjectPaths: response!.hasMore
              ? ({...state.exhaustedProjectPaths}..remove(projectPath))
              : {...state.exhaustedProjectPaths, projectPath},
        ),
      );
      return;
    }

    final hasMore = _bridge.recentSessionsHasMore;
    final isFirstPage = (response?.offset ?? 0) == 0;
    emit(
      state.copyWith(
        sessions: sessions,
        hasMore: hasMore,
        isLoadingMore: false,
        isInitialLoading: false,
        accumulatedProjectPaths: merged,
        loadingProjectPaths: const {},
        exhaustedProjectPaths: hasMore ? const {} : merged,
        projectSessionDisplayLimits: isFirstPage
            ? const {}
            : state.projectSessionDisplayLimits,
      ),
    );
  }

  void _onProjectHistoryUpdate(List<String> projects) {
    if (projects.isEmpty) return;
    final current = state.accumulatedProjectPaths;
    final newPaths = projects.toSet();
    if (newPaths.difference(current).isNotEmpty) {
      emit(state.copyWith(accumulatedProjectPaths: {...current, ...newPaths}));
    }
  }

  void _onBridgeMessage(ServerMessage message) {
    if (message is! ErrorMessage ||
        message.errorCode != 'recent_sessions_failed' ||
        isClosed) {
      return;
    }
    final projectPath = message.projectId?.isNotEmpty == true
        ? 'project:${message.projectId}'
        : message.path;
    if (message.requestScope == 'project' &&
        projectPath != null &&
        projectPath.isNotEmpty) {
      emit(
        state.copyWith(
          loadingProjectPaths: {...state.loadingProjectPaths}
            ..remove(projectPath),
        ),
      );
      return;
    }
    emit(state.copyWith(isInitialLoading: false, isLoadingMore: false));
  }

  // ---- Filter commands (all trigger server re-fetch) ----

  /// Switch project filter. Resets sessions on the server side and fetches
  /// from offset 0 for the selected project.
  void selectProject(String? projectPath) {
    emit(state.copyWith(isInitialLoading: true));
    _switchFilter(projectPath: projectPath);
  }

  /// Set search query with debounce (server-side).
  void setSearchQuery(String query) {
    emit(state.copyWith(searchQuery: query));
    _searchDebounce?.cancel();
    _searchDebounce = Timer(const Duration(milliseconds: 300), () {
      if (isClosed) return;
      emit(state.copyWith(isInitialLoading: true));
      _requestWithCurrentFilters();
    });
  }

  /// Toggle provider filter: All → Codex → Claude → omp → All, over the
  /// filters offered for the enabled agents (default: [_enabledTabs] and the
  /// Bridge's omp support).
  void toggleProviderFilter({List<ProviderFilter>? allowedFilters}) {
    final options = allowedFilters == null || allowedFilters.isEmpty
        ? _allowedProviderFilters
        : allowedFilters;
    final currentIndex = options.indexOf(state.providerFilter);
    final next = options[(currentIndex + 1) % options.length];
    setProviderFilter(next);
  }

  /// Select [next] as the user's filter and persist it.
  void setProviderFilter(ProviderFilter next) {
    _preferredProviderFilter = next;
    if (state.providerFilter == next) return;
    emit(state.copyWith(providerFilter: next, isInitialLoading: true));
    _requestWithCurrentFilters();
    _persistProviderFilter(next);
  }

  /// Restrict the provider filter to the agents enabled in the settings.
  void applyEnabledAgents(List<NewSessionTab> enabledTabs) {
    _enabledTabs = List.unmodifiable(enabledTabs);
    _coerceProviderFilter();
  }

  List<ProviderFilter> get _allowedProviderFilters =>
      providerFiltersForEnabledTabs(
        _enabledTabs,
        ompSupport: _bridge.ompSupport,
      );

  /// Restricts the user's filter to the enabled agents, with omp counted as
  /// offered. That coercion follows a settings choice and is persisted. The
  /// Bridge's omp support is applied only to the shown filter and never
  /// persisted (lead amendment A1).
  void _restrictPreferenceToEnabledAgents() {
    final next = coerceProviderFilter(
      _preferredProviderFilter,
      providerFiltersForEnabledTabs(
        _enabledTabs,
        ompSupport: OmpSupport.supported,
      ),
    );
    if (next == _preferredProviderFilter) return;
    _preferredProviderFilter = next;
    _persistProviderFilter(next);
  }

  /// Re-derives the shown filter from the user's choice.
  void _coerceProviderFilter() {
    if (isClosed) return;
    _restrictPreferenceToEnabledAgents();
    final next = coerceProviderFilter(
      _preferredProviderFilter,
      _allowedProviderFilters,
    );
    if (next != state.providerFilter) {
      emit(state.copyWith(providerFilter: next, isInitialLoading: true));
      _requestWithCurrentFilters();
      return;
    }
    // "All" covers a different provider set now (omp support or the enabled
    // agents changed).
    final lastArgs = _lastProviderArgs;
    if (lastArgs != null && !_sameProviderArgs(lastArgs, _providerArgs())) {
      _requestWithCurrentFilters();
    }
  }

  void _persistProviderFilter(ProviderFilter filter) {
    // Persist preference in background (fire-and-forget).
    SharedPreferences.getInstance().then(
      (prefs) => prefs.setString('session_list_provider', filter.name),
    );
  }

  /// Toggle named-only filter on/off.
  void toggleNamedOnly() async {
    final next = !state.namedOnly;
    emit(state.copyWith(namedOnly: next, isInitialLoading: true));
    _requestWithCurrentFilters();
    // Persist preference in background (fire-and-forget).
    SharedPreferences.getInstance().then(
      (prefs) => prefs.setBool('session_list_named_only', next),
    );
  }

  /// Load more sessions (pagination).
  void loadMore() {
    emit(state.copyWith(isLoadingMore: true));
    _bridge.loadMoreRecentSessions();
  }

  /// Load the next project-scoped page without replacing other projects.
  void loadMoreProject(String projectPath) {
    if (projectPath.isEmpty ||
        state.loadingProjectPaths.contains(projectPath)) {
      return;
    }
    final loadedCount = state.sessions
        .where((session) => session.workspaceGroupKey == projectPath)
        .length;
    final currentLimit =
        state.projectSessionDisplayLimits[projectPath] ??
        _projectInitialSessionDisplayLimit;
    final nextLimit = currentLimit + _projectSessionDisplayPageSize;
    final shouldFetch =
        nextLimit > loadedCount &&
        !state.exhaustedProjectPaths.contains(projectPath);
    emit(
      state.copyWith(
        projectSessionDisplayLimits: {
          ...state.projectSessionDisplayLimits,
          projectPath: nextLimit,
        },
        loadingProjectPaths: shouldFetch
            ? {...state.loadingProjectPaths, projectPath}
            : state.loadingProjectPaths,
      ),
    );
    if (!shouldFetch) return;
    _bridge.loadMoreRecentSessions(
      projectPath: projectPath,
      offset: loadedCount,
      pageSize: _projectSessionDisplayPageSize,
      requestScope: 'project',
    );
  }

  void toggleProjectCollapsed(String projectPath) {
    if (projectPath.isEmpty) return;
    final next = {...state.collapsedProjectPaths};
    if (!next.remove(projectPath)) {
      next.add(projectPath);
    }
    emit(state.copyWith(collapsedProjectPaths: next));
    SharedPreferences.getInstance().then(
      (prefs) => prefs.setStringList(_collapsedProjectPathsKey, next.toList()),
    );
  }

  bool isRecentSessionPinned(RecentSession session) =>
      state.pinnedSessionKeys.contains(recentSessionPinKey(session));

  bool isRunningSessionPinned(SessionInfo session) {
    final key = runningSessionPinKey(session);
    return key != null && state.pinnedSessionKeys.contains(key);
  }

  bool isProjectPinned(String projectPath) =>
      state.pinnedProjectPaths.contains(projectPath);

  Future<void> toggleRecentSessionPinned(RecentSession session) async {
    await _preferencesLoaded;
    if (isClosed) return;
    await _toggleSessionPin(recentSessionPinKey(session));
  }

  Future<void> toggleRunningSessionPinned(SessionInfo session) async {
    final key = runningSessionPinKey(session);
    if (key == null) return;
    await _preferencesLoaded;
    if (isClosed) return;
    await _toggleSessionPin(key);
  }

  Future<void> _toggleSessionPin(String key) async {
    final next = {...state.pinnedSessionKeys};
    if (!next.remove(key)) next.add(key);
    emit(state.copyWith(pinnedSessionKeys: next));
    await _persistStringSet(_pinnedSessionKeysKey, next);
  }

  Future<void> toggleProjectPinned(String projectPath) async {
    if (projectPath.isEmpty) return;
    await _preferencesLoaded;
    if (isClosed) return;
    final next = {...state.pinnedProjectPaths};
    if (!next.remove(projectPath)) next.add(projectPath);
    emit(state.copyWith(pinnedProjectPaths: next));
    await _persistStringSet(_pinnedProjectPathsKey, next);
  }

  Future<void> _persistStringSet(String key, Set<String> values) async {
    final sorted = values.toList()..sort();
    final prefs = await SharedPreferences.getInstance();
    await prefs.setStringList(key, sorted);
  }

  /// Request fresh data from the server.
  void refresh() {
    _bridge.requestSessionList();
    _requestWithCurrentFilters();
    _bridge.requestProjectHistory();
    _bridge.requestProjects();
  }

  /// Reset all filter state (used on disconnect).
  void resetFilters() {
    _searchDebounce?.cancel();
    emit(
      state.copyWith(
        sessions: const [],
        searchQuery: '',
        accumulatedProjectPaths: const {},
        loadingProjectPaths: const {},
        exhaustedProjectPaths: const {},
        projectSessionDisplayLimits: const {},
        isLoadingMore: false,
        isInitialLoading: true,
        providerFilter: ProviderFilter.all,
        namedOnly: false,
      ),
    );
    _preferredProviderFilter = ProviderFilter.all;
    _lastProviderArgs = null;
  }

  /// Optimistically update a session's name in the local state.
  void updateSessionName(String sessionId, String? name) {
    final updated = state.sessions.map((s) {
      if (s.sessionId == sessionId) {
        return name == null
            ? s.copyWithName(clearName: true)
            : s.copyWithName(name: name);
      }
      return s;
    }).toList();
    emit(state.copyWith(sessions: updated));
  }

  // ---- Private helpers ----

  /// Send a re-fetch request with all current filters applied.
  void _requestWithCurrentFilters() {
    _switchFilter(projectPath: _bridge.currentProjectFilter);
  }

  void _switchFilter({required String? projectPath}) {
    final args = _providerArgs();
    _lastProviderArgs = args;
    _bridge.switchFilter(
      projectPath: projectPath,
      provider: args.provider,
      providers: args.providers,
      namedOnly: state.namedOnly ? true : null,
      searchQuery: state.searchQuery.isNotEmpty ? state.searchQuery : null,
    );
  }

  /// Wire provider arguments for the current filter. "All" names the
  /// effective providers when they are a strict subset of what the Bridge
  /// supports (a single one as `provider`, which every Bridge understands;
  /// several as `providers`, which only omp-capable Bridges accept), else
  /// nothing.
  ({String? provider, List<String>? providers}) _providerArgs() {
    final filter = state.providerFilter;
    if (filter != ProviderFilter.all) {
      return (provider: _providerToString(filter), providers: null);
    }
    final support = _bridge.ompSupport;
    final effective = effectiveProviders(_enabledTabs, support);
    final bridgeProviders = {
      Provider.claude,
      Provider.codex,
      if (support == OmpSupport.supported) Provider.omp,
    };
    if (effective.containsAll(bridgeProviders)) {
      return (provider: null, providers: null);
    }
    if (effective.length == 1) {
      return (provider: effective.single.value, providers: null);
    }
    return (
      provider: null,
      providers: [for (final provider in effective) provider.value],
    );
  }

  static bool _sameProviderArgs(
    ({String? provider, List<String>? providers}) a,
    ({String? provider, List<String>? providers}) b,
  ) {
    if (a.provider != b.provider) return false;
    final left = a.providers ?? const <String>[];
    final right = b.providers ?? const <String>[];
    if (left.length != right.length) return false;
    for (var i = 0; i < left.length; i++) {
      if (left[i] != right[i]) return false;
    }
    return true;
  }

  /// Convert [ProviderFilter] enum to the wire-format string (or null for all).
  static String? _providerToString(ProviderFilter f) => switch (f) {
    ProviderFilter.all => null,
    ProviderFilter.claude => 'claude',
    ProviderFilter.codex => 'codex',
    ProviderFilter.omp => 'omp',
  };

  @override
  Future<void> close() {
    _searchDebounce?.cancel();
    _recentSub?.cancel();
    _projectHistorySub?.cancel();
    _messageSub?.cancel();
    _ompSupportSub?.cancel();
    _enabledTabsSub?.cancel();
    return super.close();
  }
}

/// Filters offered for the enabled agents, in toggle order
/// (All → Codex → Claude → omp). omp appears only while the Bridge supports
/// it (see [effectiveProviders]); "All" only when more than one provider is
/// offered.
List<ProviderFilter> providerFiltersForEnabledTabs(
  List<NewSessionTab> enabledTabs, {
  OmpSupport ompSupport = OmpSupport.unknown,
}) {
  final providers = effectiveProviders(enabledTabs, ompSupport);
  final filters = [
    if (providers.contains(Provider.codex)) ProviderFilter.codex,
    if (providers.contains(Provider.claude)) ProviderFilter.claude,
    if (providers.contains(Provider.omp)) ProviderFilter.omp,
  ];
  return filters.length > 1 ? [ProviderFilter.all, ...filters] : filters;
}

ProviderFilter coerceProviderFilter(
  ProviderFilter current,
  List<ProviderFilter> allowedFilters,
) {
  if (allowedFilters.contains(current)) return current;
  return allowedFilters.firstOrNull ?? ProviderFilter.all;
}
