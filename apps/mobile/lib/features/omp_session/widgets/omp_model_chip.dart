import 'package:flutter/material.dart';

import '../../../l10n/app_localizations.dart';
import '../../../models/messages.dart';
import 'omp_settings_sheet.dart';

/// Mode bar chip of an omp session: "model · thinking level".
class OmpModelChip extends StatelessWidget {
  final String? model;
  final String? thinkingLevel;
  final List<OmpModelInfo> models;
  final VoidCallback? onTap;

  const OmpModelChip({
    super.key = const ValueKey('omp_model_chip'),
    required this.model,
    required this.thinkingLevel,
    required this.models,
    required this.onTap,
  });

  @override
  Widget build(BuildContext context) {
    final l = AppLocalizations.of(context);
    final fg = Theme.of(context).colorScheme.onSurfaceVariant;
    final name = ompModelDisplayName(model, models, l);
    final level = thinkingLevel;
    final label = level == null
        ? name
        : '$name · ${ompThinkingLevelLabel(level)}';

    return Material(
      color: Colors.transparent,
      borderRadius: BorderRadius.circular(10),
      clipBehavior: Clip.antiAlias,
      child: InkWell(
        onTap: onTap,
        child: Padding(
          padding: const EdgeInsets.symmetric(horizontal: 6, vertical: 4),
          child: Row(
            mainAxisSize: MainAxisSize.min,
            children: [
              ConstrainedBox(
                constraints: const BoxConstraints(maxWidth: 160),
                child: Text(
                  label,
                  maxLines: 1,
                  overflow: TextOverflow.ellipsis,
                  style: TextStyle(
                    fontSize: 11,
                    fontWeight: FontWeight.w600,
                    color: fg,
                  ),
                ),
              ),
              if (onTap != null)
                Icon(
                  Icons.arrow_drop_down,
                  size: 14,
                  color: fg.withValues(alpha: 0.5),
                ),
            ],
          ),
        ),
      ),
    );
  }
}
