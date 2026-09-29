import 'package:flutter/material.dart';

import '../l10n/app_localizations.dart';

/// Shows a dialog to rename a session. Returns the new name, empty string
/// to clear the name, or null if cancelled.
///
/// With [allowClear] false (omp: names cannot be cleared) the clear button is
/// hidden and an empty name cannot be saved, so the result is never empty.
Future<String?> showRenameSessionDialog(
  BuildContext context, {
  String? currentName,
  bool allowClear = true,
}) async {
  final l = AppLocalizations.of(context);
  final controller = TextEditingController(text: currentName ?? '');
  // Select all text for easy replacement
  controller.selection = TextSelection(
    baseOffset: 0,
    extentOffset: controller.text.length,
  );
  bool canSave(String value) => allowClear || value.trim().isNotEmpty;

  return showDialog<String>(
    context: context,
    builder: (ctx) => AlertDialog(
      title: Text(l.renameSession),
      content: TextField(
        key: const ValueKey('rename_session_field'),
        controller: controller,
        autofocus: true,
        decoration: InputDecoration(
          hintText: l.sessionNameHint,
          suffixIcon: allowClear
              ? IconButton(
                  key: const ValueKey('rename_session_clear_button'),
                  icon: const Icon(Icons.clear, size: 18),
                  tooltip: l.clearName,
                  onPressed: () => controller.clear(),
                )
              : null,
        ),
        onSubmitted: (v) {
          if (canSave(v)) Navigator.pop(ctx, v);
        },
      ),
      actions: [
        TextButton(onPressed: () => Navigator.pop(ctx), child: Text(l.cancel)),
        ValueListenableBuilder<TextEditingValue>(
          valueListenable: controller,
          builder: (context, value, _) => FilledButton(
            key: const ValueKey('rename_session_save_button'),
            onPressed: canSave(value.text)
                ? () => Navigator.pop(ctx, controller.text)
                : null,
            child: Text(l.save),
          ),
        ),
      ],
    ),
  );
}
