import '../../../models/messages.dart';

/// Token totals over every `result` message of a session (Claude and omp
/// report them per run).
({int inputTokens, int cachedInputTokens, int outputTokens}) collectTokenUsage(
  List<ChatEntry> entries,
) {
  var inputTokens = 0;
  var cachedInputTokens = 0;
  var outputTokens = 0;

  for (final entry in entries) {
    if (entry is! ServerChatEntry) continue;
    final msg = entry.message;
    if (msg is! ResultMessage) continue;
    inputTokens += msg.inputTokens ?? 0;
    cachedInputTokens += msg.cachedInputTokens ?? 0;
    outputTokens += msg.outputTokens ?? 0;
  }

  return (
    inputTokens: inputTokens,
    cachedInputTokens: cachedInputTokens,
    outputTokens: outputTokens,
  );
}

/// Tool call and file edit totals over every `result` message of a session.
({int toolCalls, int fileEdits}) collectToolUsage(List<ChatEntry> entries) {
  var toolCalls = 0;
  var fileEdits = 0;

  for (final entry in entries) {
    if (entry is! ServerChatEntry) continue;
    final msg = entry.message;
    if (msg is! ResultMessage) continue;
    toolCalls += msg.toolCalls ?? 0;
    fileEdits += msg.fileEdits ?? 0;
  }

  return (toolCalls: toolCalls, fileEdits: fileEdits);
}
