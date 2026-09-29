import 'package:flutter/material.dart';

import '../../../l10n/app_localizations.dart';
import '../../../models/messages.dart';

/// Moves a queued item back into the composer: the Bridge queue entry is
/// cancelled and the composer text is replaced by the item text.
void moveQueuedInputToComposer({
  required TextEditingController inputController,
  required QueuedInputItem item,
  required VoidCallback cancelQueuedInput,
}) {
  cancelQueuedInput();
  inputController.value = TextEditingValue(
    text: item.text,
    selection: TextSelection.collapsed(offset: item.text.length),
  );
}

/// The one-item input queue of Codex and omp sessions: steer, edit and cancel
/// the message waiting for the next turn.
class CodexQueuedInputPanel extends StatelessWidget {
  const CodexQueuedInputPanel({
    super.key,
    required this.item,
    required this.onSteer,
    required this.onEdit,
    required this.onCancel,
    this.isOfflinePending = false,
    this.isDeliveryPending = false,
  });

  final QueuedInputItem item;
  final VoidCallback? onSteer;
  final VoidCallback? onEdit;
  final VoidCallback? onCancel;
  final bool isOfflinePending;
  final bool isDeliveryPending;

  @override
  Widget build(BuildContext context) {
    final cs = Theme.of(context).colorScheme;
    final textTheme = Theme.of(context).textTheme;
    final l = AppLocalizations.of(context);
    final imageLabel = item.imageCount > 0
        ? ' · ${l.queuedInputImageCount(item.imageCount)}'
        : '';
    final title = isOfflinePending
        ? '${l.queuedInputForReconnect}$imageLabel'
        : isDeliveryPending
        ? '${l.queuedInputPendingDelivery}$imageLabel'
        : '${l.queuedInputForNextTurn}$imageLabel';

    return Material(
      key: const ValueKey('codex_queue_panel'),
      color: cs.surfaceContainerHighest,
      child: SafeArea(
        top: false,
        bottom: false,
        child: Padding(
          padding: const EdgeInsets.fromLTRB(12, 8, 8, 8),
          child: Row(
            crossAxisAlignment: CrossAxisAlignment.start,
            children: [
              Padding(
                padding: const EdgeInsets.only(top: 2),
                child: Icon(Icons.schedule, size: 18, color: cs.primary),
              ),
              const SizedBox(width: 10),
              Expanded(
                child: Column(
                  crossAxisAlignment: CrossAxisAlignment.start,
                  mainAxisSize: MainAxisSize.min,
                  children: [
                    Text(
                      title,
                      style: textTheme.labelMedium?.copyWith(
                        color: cs.onSurfaceVariant,
                        fontWeight: FontWeight.w600,
                      ),
                    ),
                    const SizedBox(height: 3),
                    Text(
                      item.text,
                      maxLines: 2,
                      overflow: TextOverflow.ellipsis,
                      style: textTheme.bodyMedium?.copyWith(
                        color: cs.onSurface,
                      ),
                    ),
                  ],
                ),
              ),
              if (!isDeliveryPending)
                IconButton(
                  key: const ValueKey('codex_queue_steer_button'),
                  tooltip: l.tooltipSteerQueuedMessage,
                  icon: const Icon(Icons.subdirectory_arrow_left, size: 20),
                  onPressed: onSteer,
                ),
              IconButton(
                key: const ValueKey('codex_queue_edit_button'),
                tooltip: l.tooltipMoveQueuedMessageToInput,
                icon: const Icon(Icons.edit_outlined, size: 20),
                onPressed: onEdit,
              ),
              IconButton(
                key: const ValueKey('codex_queue_cancel_button'),
                tooltip: l.tooltipCancelQueuedMessage,
                icon: const Icon(Icons.close, size: 20),
                onPressed: onCancel,
              ),
            ],
          ),
        ),
      ),
    );
  }
}
