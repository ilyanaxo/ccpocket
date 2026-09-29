import 'dart:convert';

import '../l10n/app_localizations.dart';
import 'messages.dart';

/// Tabs available in the new session sheet.
enum NewSessionTab {
  codex('codex', 'Codex'),
  claude('claude', 'Claude'),
  omp('omp', 'omp');

  final String value;
  final String label;
  const NewSessionTab(this.value, this.label);

  /// Convert to [Provider].
  Provider toProvider() => switch (this) {
    NewSessionTab.claude => Provider.claude,
    NewSessionTab.codex => Provider.codex,
    NewSessionTab.omp => Provider.omp,
  };

  /// Look up a tab by its wire-format value.
  static NewSessionTab? fromValue(String value) {
    for (final tab in values) {
      if (tab.value == value) return tab;
    }
    return null;
  }
}

enum EnabledAgentsMode { both, codex, claude }

extension NewSessionTabL10n on NewSessionTab {
  String localizedLabel(AppLocalizations l) => switch (this) {
    NewSessionTab.codex => l.newSessionTabCodex,
    NewSessionTab.claude => l.newSessionTabClaudeCode,
    // Brand name, not translated (like newSessionTabCodex).
    NewSessionTab.omp => NewSessionTab.omp.label,
  };
}

/// Default tab order when no user preference is saved.
const defaultNewSessionTabs = [
  NewSessionTab.codex,
  NewSessionTab.claude,
  NewSessionTab.omp,
];

/// Providers of the enabled [tabs], in tab order.
Set<Provider> enabledProvidersFromTabs(List<NewSessionTab> tabs) {
  return {for (final tab in tabs) tab.toProvider()};
}

NewSessionTab _tabForProvider(Provider provider) => switch (provider) {
  Provider.claude => NewSessionTab.claude,
  Provider.codex => NewSessionTab.codex,
  Provider.omp => NewSessionTab.omp,
};

/// Enables or disables [provider] in [tabs]. An enabled provider is appended
/// at the end when missing; a disabled one is removed. The last enabled
/// provider cannot be disabled: [tabs] is then returned unchanged.
List<NewSessionTab> tabsWithProvider(
  List<NewSessionTab> tabs,
  Provider provider,
  bool enabled,
) {
  final tab = _tabForProvider(provider);
  final ordered = <NewSessionTab>[];
  for (final current in tabs) {
    if (!ordered.contains(current)) ordered.add(current);
  }
  if (enabled) {
    if (!ordered.contains(tab)) ordered.add(tab);
    return ordered;
  }
  if (!ordered.contains(tab)) return ordered;
  if (ordered.length == 1) return tabs;
  return ordered..remove(tab);
}

/// Providers the app offers: the enabled ones, with omp only while the
/// Bridge supports it. Iteration follows the tab order. Falls back to
/// Claude and Codex when nothing else remains (only omp enabled on a Bridge
/// without omp). `unknown` hides omp; callers must not persist anything
/// derived from that coercion.
Set<Provider> effectiveProviders(
  List<NewSessionTab> enabledTabs,
  OmpSupport ompSupport,
) {
  final allowed = <Provider>{
    Provider.claude,
    Provider.codex,
    if (ompSupport == OmpSupport.supported) Provider.omp,
  };
  final effective = enabledProvidersFromTabs(enabledTabs)
      .where(allowed.contains)
      .toSet();
  if (effective.isNotEmpty) return effective;
  return {Provider.claude, Provider.codex};
}

EnabledAgentsMode enabledAgentsModeFromTabs(List<NewSessionTab> tabs) {
  final set = tabs.toSet();
  final hasCodex = set.contains(NewSessionTab.codex);
  final hasClaude = set.contains(NewSessionTab.claude);
  if (hasCodex && !hasClaude) return EnabledAgentsMode.codex;
  if (hasClaude && !hasCodex) return EnabledAgentsMode.claude;
  return EnabledAgentsMode.both;
}

List<NewSessionTab> tabsForEnabledAgentsMode(
  EnabledAgentsMode mode,
  List<NewSessionTab> current,
) {
  switch (mode) {
    case EnabledAgentsMode.both:
      final ordered = [
        for (final tab in current)
          if (NewSessionTab.values.contains(tab)) tab,
      ];
      final set = ordered.toSet();
      if (!set.contains(NewSessionTab.codex)) {
        ordered.add(NewSessionTab.codex);
      }
      if (!set.contains(NewSessionTab.claude)) {
        ordered.add(NewSessionTab.claude);
      }
      return ordered;
    case EnabledAgentsMode.codex:
      return const [NewSessionTab.codex];
    case EnabledAgentsMode.claude:
      return const [NewSessionTab.claude];
  }
}

bool isNewSessionTabEnabled(
  List<NewSessionTab> enabledTabs,
  NewSessionTab tab,
) {
  return enabledTabs.contains(tab);
}

/// Serialize a tab list to a JSON string for SharedPreferences.
String tabsToJson(List<NewSessionTab> tabs) =>
    jsonEncode(tabs.map((t) => t.value).toList());

/// Deserialize a JSON string to a tab list.
/// Returns null if the JSON is invalid or the result is empty.
List<NewSessionTab>? tabsFromJson(String json) {
  try {
    final list = (jsonDecode(json) as List).cast<String>();
    final tabs = list
        .map(NewSessionTab.fromValue)
        .whereType<NewSessionTab>()
        .toList();
    return tabs.isEmpty ? null : tabs;
  } catch (_) {
    return null;
  }
}
