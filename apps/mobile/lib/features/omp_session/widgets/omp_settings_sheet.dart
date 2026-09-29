import 'package:flutter/material.dart';
import 'package:flutter/services.dart';
import 'package:flutter_bloc/flutter_bloc.dart';

import '../../../l10n/app_localizations.dart';
import '../../../models/messages.dart';
import '../../chat_session/state/chat_session_cubit.dart';
import '../../chat_session/state/chat_session_state.dart';

/// Display label of an omp thinking level wire value (`off` … `max`).
String ompThinkingLevelLabel(String level) =>
    switch (ompThinkingLevelFromValue(level)) {
      OmpThinkingLevel.off => 'Off',
      OmpThinkingLevel.minimal => 'Minimal',
      OmpThinkingLevel.low => 'Low',
      OmpThinkingLevel.medium => 'Medium',
      OmpThinkingLevel.high => 'High',
      OmpThinkingLevel.xhigh => 'Extra High',
      OmpThinkingLevel.max => 'Max',
      null => level,
    };

/// Description of an omp thinking level; reuses the reasoning effort texts.
String ompThinkingLevelDescription(String level, AppLocalizations l) =>
    switch (ompThinkingLevelFromValue(level)) {
      OmpThinkingLevel.off => l.reasoningEffortNoneDesc,
      OmpThinkingLevel.minimal => l.reasoningEffortMinimalDesc,
      OmpThinkingLevel.low => l.reasoningEffortLowDesc,
      OmpThinkingLevel.medium => l.reasoningEffortMediumDesc,
      OmpThinkingLevel.high => l.reasoningEffortHighDesc,
      OmpThinkingLevel.xhigh => l.reasoningEffortXhighDesc,
      OmpThinkingLevel.max => l.reasoningEffortMaxDesc,
      null => '',
    };

/// Display name of an omp model selector: the catalogue name, else the id
/// part of `<provider>/<id>`, else "omp default" for no selector.
String ompModelDisplayName(
  String? selector,
  Iterable<OmpModelInfo> models,
  AppLocalizations l,
) {
  if (selector == null || selector.isEmpty) return l.ompDefaultModel;
  for (final model in models) {
    if (model.selector == selector && model.name.isNotEmpty) return model.name;
  }
  final slash = selector.indexOf('/');
  return slash >= 0 && slash < selector.length - 1
      ? selector.substring(slash + 1)
      : selector;
}

/// One row of the grouped omp model list.
sealed class OmpModelListEntry {
  const OmpModelListEntry();
}

/// The "omp default" row (no `--model`).
class OmpModelDefaultEntry extends OmpModelListEntry {
  const OmpModelDefaultEntry();
}

/// A provider heading.
class OmpModelGroupEntry extends OmpModelListEntry {
  final String provider;
  const OmpModelGroupEntry(this.provider);
}

/// A selectable model.
class OmpModelOptionEntry extends OmpModelListEntry {
  final OmpModelInfo model;
  const OmpModelOptionEntry(this.model);
}

/// Flattens [models] into rows grouped by [OmpModelInfo.provider]; groups
/// keep the order in which their provider first appears in the catalogue.
List<OmpModelListEntry> ompModelListEntries(
  Iterable<OmpModelInfo> models, {
  required bool showDefault,
}) {
  final groups = <String, List<OmpModelInfo>>{};
  for (final model in models) {
    groups.putIfAbsent(model.provider, () => []).add(model);
  }
  return [
    if (showDefault) const OmpModelDefaultEntry(),
    for (final MapEntry(key: provider, value: group) in groups.entries) ...[
      OmpModelGroupEntry(provider),
      for (final model in group) OmpModelOptionEntry(model),
    ],
  ];
}

/// Opens the model and thinking level sheet of a running omp session.
///
/// Rebuilds from the cubit state, so a confirmed or rolled back change is
/// shown while the sheet is open.
void showOmpSettingsSheet(BuildContext context, ChatSessionCubit chatCubit) {
  showModalBottomSheet<void>(
    context: context,
    isScrollControlled: true,
    builder: (_) => BlocProvider<ChatSessionCubit>.value(
      value: chatCubit,
      child: BlocBuilder<ChatSessionCubit, ChatSessionState>(
        builder: (context, state) => OmpSettingsSheet(
          models: chatCubit.ompModels,
          model: state.ompModel,
          thinkingLevel: state.ompThinkingLevel,
          thinkingLevels: state.ompThinkingLevels,
          onModelSelected: (selector) => chatCubit.setOmpModel(model: selector),
          onThinkingLevelSelected: (level) =>
              chatCubit.setOmpModel(thinkingLevel: level),
        ),
      ),
    ),
  );
}

/// Model and thinking level picker of a running omp session.
///
/// A running session cannot switch back to omp's configured default (the
/// Bridge needs a selector), so the "omp default" row only marks a session
/// whose model is not known yet.
class OmpSettingsSheet extends StatelessWidget {
  final List<OmpModelInfo> models;
  final String? model;
  final String? thinkingLevel;
  final List<String> thinkingLevels;
  final ValueChanged<String> onModelSelected;
  final ValueChanged<String> onThinkingLevelSelected;

  const OmpSettingsSheet({
    super.key = const ValueKey('omp_settings_sheet'),
    required this.models,
    required this.model,
    required this.thinkingLevel,
    required this.thinkingLevels,
    required this.onModelSelected,
    required this.onThinkingLevelSelected,
  });

  @override
  Widget build(BuildContext context) {
    final l = AppLocalizations.of(context);
    final entries = ompModelListEntries(models, showDefault: model == null);
    return SafeArea(
      child: ConstrainedBox(
        constraints: BoxConstraints(
          maxHeight: MediaQuery.sizeOf(context).height * 0.8,
        ),
        child: CustomScrollView(
          shrinkWrap: true,
          slivers: [
            if (thinkingLevels.isNotEmpty)
              SliverToBoxAdapter(
                child: Column(
                  mainAxisSize: MainAxisSize.min,
                  crossAxisAlignment: CrossAxisAlignment.start,
                  children: [
                    OmpSheetSectionTitle(title: l.reasoning),
                    OmpThinkingLevelList(
                      levels: thinkingLevels,
                      selected: thinkingLevel,
                      onSelected: (level) {
                        if (level != null) onThinkingLevelSelected(level);
                      },
                    ),
                    const Divider(height: 16),
                  ],
                ),
              ),
            SliverToBoxAdapter(child: OmpSheetSectionTitle(title: l.model)),
            SliverPadding(
              padding: const EdgeInsets.only(bottom: 16),
              sliver: SliverList.builder(
                itemCount: entries.length,
                itemBuilder: (context, index) => OmpModelListTile(
                  entry: entries[index],
                  selected: model,
                  onSelected: (selector) {
                    if (selector != null) onModelSelected(selector);
                  },
                ),
              ),
            ),
          ],
        ),
      ),
    );
  }
}

class OmpSheetSectionTitle extends StatelessWidget {
  final String title;

  const OmpSheetSectionTitle({super.key, required this.title});

  @override
  Widget build(BuildContext context) {
    final cs = Theme.of(context).colorScheme;
    return Padding(
      padding: const EdgeInsets.fromLTRB(16, 16, 16, 4),
      child: Text(
        title,
        style: TextStyle(
          fontSize: 14,
          fontWeight: FontWeight.w600,
          color: cs.onSurface,
        ),
      ),
    );
  }
}

/// Thinking levels as selectable rows (`omp_thinking_level_<level>`), with
/// an optional "omp default" row (`omp_thinking_level_default`, level null).
class OmpThinkingLevelList extends StatelessWidget {
  final List<String> levels;
  final String? selected;
  final bool showDefault;
  final ValueChanged<String?> onSelected;

  const OmpThinkingLevelList({
    super.key,
    required this.levels,
    required this.selected,
    this.showDefault = false,
    required this.onSelected,
  });

  @override
  Widget build(BuildContext context) {
    final l = AppLocalizations.of(context);
    final cs = Theme.of(context).colorScheme;
    Widget row({
      required Key key,
      required String title,
      required String subtitle,
      required bool isSelected,
      required VoidCallback onTap,
    }) {
      return ListTile(
        key: key,
        dense: true,
        leading: Icon(
          Icons.psychology_outlined,
          color: isSelected ? cs.primary : cs.onSurfaceVariant,
        ),
        title: Text(title),
        subtitle: subtitle.isEmpty
            ? null
            : Text(subtitle, style: const TextStyle(fontSize: 12)),
        trailing: isSelected
            ? Icon(Icons.check, color: cs.primary, size: 20)
            : null,
        onTap: () {
          if (isSelected) return;
          HapticFeedback.selectionClick();
          onTap();
        },
      );
    }

    return Column(
      mainAxisSize: MainAxisSize.min,
      children: [
        if (showDefault)
          row(
            key: const ValueKey('omp_thinking_level_default'),
            title: l.ompDefaultModel,
            subtitle: '',
            isSelected: selected == null,
            onTap: () => onSelected(null),
          ),
        for (final level in levels)
          row(
            key: ValueKey('omp_thinking_level_$level'),
            title: ompThinkingLevelLabel(level),
            subtitle: ompThinkingLevelDescription(level, l),
            isSelected: level == selected,
            onTap: () => onSelected(level),
          ),
      ],
    );
  }
}

/// Picker for the omp model of a new session: "omp default" and the
/// catalogue grouped by provider. [onSelected] gets null for "omp default".
Future<void> showOmpModelPicker(
  BuildContext context, {
  required List<OmpModelInfo> models,
  required String? selected,
  required ValueChanged<String?> onSelected,
}) {
  final l = AppLocalizations.of(context);
  final entries = ompModelListEntries(models, showDefault: true);
  return showModalBottomSheet<void>(
    context: context,
    isScrollControlled: true,
    builder: (sheetContext) => SafeArea(
      child: ConstrainedBox(
        key: const ValueKey('omp_model_picker'),
        constraints: BoxConstraints(
          maxHeight: MediaQuery.sizeOf(sheetContext).height * 0.8,
        ),
        child: CustomScrollView(
          shrinkWrap: true,
          slivers: [
            SliverToBoxAdapter(
              child: Padding(
                padding: const EdgeInsets.fromLTRB(16, 16, 16, 8),
                child: Column(
                  crossAxisAlignment: CrossAxisAlignment.start,
                  children: [
                    Text(
                      l.model,
                      style: const TextStyle(
                        fontSize: 14,
                        fontWeight: FontWeight.w600,
                      ),
                    ),
                    const SizedBox(height: 4),
                    Text(
                      l.sheetSubtitleModel,
                      style: TextStyle(
                        fontSize: 12,
                        color: Theme.of(sheetContext)
                            .colorScheme
                            .onSurfaceVariant,
                      ),
                    ),
                  ],
                ),
              ),
            ),
            SliverPadding(
              padding: const EdgeInsets.only(bottom: 16),
              sliver: SliverList.builder(
                itemCount: entries.length,
                itemBuilder: (context, index) => OmpModelListTile(
                  entry: entries[index],
                  selected: selected,
                  onSelected: (selector) {
                    Navigator.pop(sheetContext);
                    onSelected(selector);
                  },
                ),
              ),
            ),
          ],
        ),
      ),
    ),
  );
}

/// Picker for the omp thinking level of a new session: "omp default" and
/// the levels of the chosen model. [onSelected] gets null for "omp default".
Future<void> showOmpThinkingLevelPicker(
  BuildContext context, {
  required List<String> levels,
  required String? selected,
  required ValueChanged<String?> onSelected,
}) {
  final l = AppLocalizations.of(context);
  return showModalBottomSheet<void>(
    context: context,
    isScrollControlled: true,
    builder: (sheetContext) => SafeArea(
      child: SingleChildScrollView(
        key: const ValueKey('omp_thinking_level_picker'),
        child: Column(
          mainAxisSize: MainAxisSize.min,
          crossAxisAlignment: CrossAxisAlignment.start,
          children: [
            OmpSheetSectionTitle(title: l.reasoning),
            OmpThinkingLevelList(
              levels: levels,
              selected: selected,
              showDefault: true,
              onSelected: (level) {
                Navigator.pop(sheetContext);
                onSelected(level);
              },
            ),
            const SizedBox(height: 8),
          ],
        ),
      ),
    ),
  );
}

/// omp approval modes (`always-ask`, `write`, `yolo`) as [ExecutionMode]s,
/// with their chip and menu texts.
({IconData icon, String label, String chipLabel, String description})
ompApprovalModeDetails(ExecutionMode mode, AppLocalizations l) =>
    switch (mode) {
      ExecutionMode.defaultMode => (
        icon: Icons.back_hand_outlined,
        label: l.ompApprovalAlwaysAsk,
        chipLabel: l.ompApprovalChipAlwaysAsk,
        description: l.ompApprovalAlwaysAskDescription,
      ),
      ExecutionMode.acceptEdits => (
        icon: Icons.edit_note,
        label: l.ompApprovalWrite,
        chipLabel: l.ompApprovalChipWrite,
        description: l.ompApprovalWriteDescription,
      ),
      ExecutionMode.fullAccess => (
        icon: Icons.flash_on,
        label: l.ompApprovalYolo,
        chipLabel: l.ompApprovalChipYolo,
        description: l.ompApprovalYoloDescription,
      ),
    };

/// One row of [ompModelListEntries]: a provider heading, a model
/// (`omp_model_option_<selector>`) or "omp default"
/// (`omp_model_option_default`, selector null).
class OmpModelListTile extends StatelessWidget {
  final OmpModelListEntry entry;
  final String? selected;
  final ValueChanged<String?> onSelected;

  const OmpModelListTile({
    super.key,
    required this.entry,
    required this.selected,
    required this.onSelected,
  });

  @override
  Widget build(BuildContext context) {
    final l = AppLocalizations.of(context);
    final cs = Theme.of(context).colorScheme;
    return switch (entry) {
      OmpModelGroupEntry(:final provider) => Padding(
        key: ValueKey('omp_model_group_$provider'),
        padding: const EdgeInsets.fromLTRB(16, 10, 16, 2),
        child: Text(
          provider,
          style: TextStyle(
            fontSize: 11,
            fontWeight: FontWeight.w600,
            letterSpacing: 0.5,
            color: cs.onSurfaceVariant,
          ),
        ),
      ),
      OmpModelDefaultEntry() => _OmpModelOptionTile(
        key: const ValueKey('omp_model_option_default'),
        title: l.ompDefaultModel,
        isSelected: selected == null,
        onTap: () => onSelected(null),
      ),
      OmpModelOptionEntry(:final model) => _OmpModelOptionTile(
        key: ValueKey('omp_model_option_${model.selector}'),
        title: model.name,
        subtitle: model.name == model.selector ? null : model.selector,
        isSelected: model.selector == selected,
        onTap: () => onSelected(model.selector),
      ),
    };
  }
}

class _OmpModelOptionTile extends StatelessWidget {
  final String title;
  final String? subtitle;
  final bool isSelected;
  final VoidCallback onTap;

  const _OmpModelOptionTile({
    super.key,
    required this.title,
    this.subtitle,
    required this.isSelected,
    required this.onTap,
  });

  @override
  Widget build(BuildContext context) {
    final cs = Theme.of(context).colorScheme;
    return ListTile(
      dense: true,
      title: Text(title),
      subtitle: subtitle == null
          ? null
          : Text(subtitle!, style: const TextStyle(fontSize: 11)),
      trailing: isSelected
          ? Icon(Icons.check, color: cs.primary, size: 20)
          : null,
      onTap: () {
        if (isSelected) return;
        HapticFeedback.selectionClick();
        onTap();
      },
    );
  }
}
