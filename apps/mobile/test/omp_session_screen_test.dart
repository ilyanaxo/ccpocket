import 'dart:convert';

import 'package:ccpocket/features/chat_session/widgets/chat_message_list.dart';
import 'package:ccpocket/features/chat_session/widgets/session_mode_bar.dart';
import 'package:ccpocket/features/omp_session/omp_session_screen.dart';
import 'package:ccpocket/l10n/app_localizations.dart';
import 'package:ccpocket/models/messages.dart';
import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';

import 'chat_screen/helpers/chat_test_helpers.dart';

const _ompInit = SystemMessage(
  subtype: 'init',
  provider: 'omp',
  model: 'anthropic/claude-opus-4-7',
  thinkingLevel: 'high',
  thinkingLevels: ['off', 'high', 'max'],
  executionMode: 'default',
  permissionMode: 'default',
);

AppLocalizations _l(WidgetTester tester) =>
    AppLocalizations.of(tester.element(find.byType(Scaffold).first));

Future<void> _pumpOmpScreen(
  WidgetTester tester,
  MockBridgeService bridge,
) async {
  await tester.pumpWidget(await buildTestOmpSessionScreen(bridge: bridge));
  await pumpN(tester);
  await emitAndPump(tester, bridge, [
    _ompInit,
    const StatusMessage(status: ProcessStatus.idle),
  ]);
  await pumpN(tester);
}

void main() {
  late MockBridgeService bridge;

  setUp(() {
    bridge = MockBridgeService();
  });

  tearDown(() {
    bridge.dispose();
  });

  group('OmpSessionScreen', () {
    testWidgets('mode bar has the model and approval chips only', (
      tester,
    ) async {
      await _pumpOmpScreen(tester, bridge);

      expect(find.byType(SessionModeBar), findsOneWidget);
      expect(find.byKey(const ValueKey('omp_model_chip')), findsOneWidget);
      expect(find.text('claude-opus-4-7 · High'), findsOneWidget);
      expect(find.byKey(const ValueKey('omp_approval_chip')), findsOneWidget);
      expect(find.byType(PlanModeChip), findsNothing);
      expect(find.byType(SandboxModeChip), findsNothing);
      expect(find.byType(PermissionModeChip), findsNothing);
      expect(find.text(_l(tester).ompMessagePlaceholder), findsOneWidget);
    });

    testWidgets('approval uses the session-scoped labels and scope note', (
      tester,
    ) async {
      await _pumpOmpScreen(tester, bridge);
      await emitAndPump(tester, bridge, [
        makeAssistantMessage(
          'a1',
          'Running a command.',
          toolUses: const [
            ToolUseContent(
              id: 'call-1',
              name: 'Bash',
              input: {'command': 'echo hi'},
            ),
          ],
        ),
        const PermissionRequestMessage(
          toolUseId: 'call-1',
          toolName: 'Bash',
          input: {
            'command': 'echo hi',
            'approvalDetails': ['Command: echo hi'],
          },
        ),
        const StatusMessage(status: ProcessStatus.waitingApproval),
      ]);
      await pumpN(tester);

      final l = _l(tester);
      expect(find.byKey(const ValueKey('approve_button')), findsOneWidget);
      expect(
        find.descendant(
          of: find.byKey(const ValueKey('approve_button')),
          matching: find.text(l.approve),
        ),
        findsOneWidget,
      );
      expect(
        find.descendant(
          of: find.byKey(const ValueKey('approve_always_button')),
          matching: find.text(l.approveSessionMain),
        ),
        findsOneWidget,
      );
      expect(find.text(l.ompApproveAlwaysScope), findsOneWidget);

      await tester.tap(find.byKey(const ValueKey('approve_always_button')));
      await pumpN(tester);

      final sent = findSentMessage(bridge, 'approve_always');
      expect(sent?['id'], 'call-1');
      expect(sent?['sessionId'], testSessionId);
    });

    testWidgets('question names omp and its decline stops the turn', (
      tester,
    ) async {
      await _pumpOmpScreen(tester, bridge);
      await emitAndPump(tester, bridge, [
        makeAskQuestionMessage('ask-1', const [
          {
            'id': 'color',
            'question': 'Which color do you prefer?',
            'options': [
              {'label': 'red'},
              {'label': 'blue'},
            ],
            'multiSelect': false,
          },
        ]),
        const StatusMessage(status: ProcessStatus.waitingApproval),
      ]);
      await pumpN(tester);

      final l = _l(tester);
      expect(find.text(l.agentIsAsking('omp')), findsOneWidget);
      expect(find.text(l.ompAskDeclineAborts), findsOneWidget);

      await tester.tap(find.byKey(const ValueKey('omp_ask_decline_button')));
      await pumpN(tester);

      final sent = findSentMessage(bridge, 'reject');
      expect(sent?['id'], 'ask-1');
      expect(sent?.containsKey('message'), isFalse);
    });

    Future<void> setBottomInset(WidgetTester tester, double inset) async {
      tester.view.padding = FakeViewPadding(
        bottom: inset * tester.view.devicePixelRatio,
      );
      await pumpN(tester);
    }

    testWidgets('the scope note alone pads for the bottom safe area', (
      tester,
    ) async {
      addTearDown(tester.view.resetPadding);
      double top(Finder finder) => tester.getTopLeft(finder).dy;
      double bottom(Finder finder) => tester.getBottomLeft(finder).dy;
      final screen = find.byType(Scaffold).first;

      await _pumpOmpScreen(tester, bridge);
      await emitAndPump(tester, bridge, [
        makeAssistantMessage(
          'a1',
          'Running a command.',
          toolUses: const [
            ToolUseContent(
              id: 'call-1',
              name: 'Bash',
              input: {'command': 'echo hi'},
            ),
          ],
        ),
        const PermissionRequestMessage(
          toolUseId: 'call-1',
          toolName: 'Bash',
          input: {'command': 'echo hi'},
        ),
        const StatusMessage(status: ProcessStatus.waitingApproval),
      ]);
      await pumpN(tester);
      final approve = find.byKey(const ValueKey('approve_button'));
      final scope = find.byKey(const ValueKey('omp_approve_always_scope'));

      await setBottomInset(tester, 0);
      final gap = top(scope) - bottom(approve);
      await setBottomInset(tester, 34);
      expect(top(scope) - bottom(approve), gap);
      expect(bottom(screen) - bottom(scope), greaterThanOrEqualTo(34));
    });

    testWidgets('the decline bar alone pads for the bottom safe area', (
      tester,
    ) async {
      addTearDown(tester.view.resetPadding);
      double top(Finder finder) => tester.getTopLeft(finder).dy;
      double bottom(Finder finder) => tester.getBottomLeft(finder).dy;
      final screen = find.byType(Scaffold).first;

      await _pumpOmpScreen(tester, bridge);
      await emitAndPump(tester, bridge, [
        makeAskQuestionMessage('ask-1', const [
          {
            'id': 'color',
            'question': 'Which color do you prefer?',
            'options': [
              {'label': 'red'},
              {'label': 'blue'},
            ],
            'multiSelect': false,
          },
        ]),
        const StatusMessage(status: ProcessStatus.waitingApproval),
      ]);
      await pumpN(tester);
      final lastOption = find.text('blue').last;
      final decline = find.byKey(const ValueKey('omp_ask_decline_button'));

      await setBottomInset(tester, 0);
      final gap = top(decline) - bottom(lastOption);
      await setBottomInset(tester, 34);
      expect(top(decline) - bottom(lastOption), gap);
      expect(bottom(screen) - bottom(decline), greaterThanOrEqualTo(34));
    });

    testWidgets('generic omp dialog declines without the abort note', (
      tester,
    ) async {
      await _pumpOmpScreen(tester, bridge);
      // §4.4: an extension or slash-command dialog arrives as a one-question
      // AskUserQuestion with an `omp-dialog:` id and no assistant tool call.
      await emitAndPump(tester, bridge, [
        const PermissionRequestMessage(
          toolUseId: 'omp-dialog:d1',
          toolName: 'AskUserQuestion',
          input: {
            'questions': [
              {
                'id': 'd1',
                'question': 'Pick a template',
                'options': [
                  {'label': 'minimal'},
                  {'label': 'full'},
                ],
              },
            ],
          },
        ),
        const StatusMessage(status: ProcessStatus.waitingApproval),
      ]);
      await pumpN(tester);

      final l = _l(tester);
      expect(find.text('Pick a template'), findsOneWidget);
      expect(find.text(l.ompAskDeclineAborts), findsNothing);
      expect(
        find.byKey(const ValueKey('omp_ask_decline_button')),
        findsOneWidget,
      );

      await tester.tap(find.byKey(const ValueKey('omp_ask_decline_button')));
      await pumpN(tester);

      final sent = findSentMessage(bridge, 'reject');
      expect(sent?['id'], 'omp-dialog:d1');
    });

    testWidgets('a refused rewind explains why and keeps the composer', (
      tester,
    ) async {
      await _pumpOmpScreen(tester, bridge);
      await emitAndPump(tester, bridge, [
        const UserInputMessage(
          text: 'Rename the helper',
          userMessageUuid: 'omp:entry:e1',
        ),
        makeAssistantMessage('a1', 'Done.'),
        const ResultMessage(subtype: 'success'),
        const StatusMessage(status: ProcessStatus.idle),
        const UserInputMessage(text: 'Second prompt'),
        const StatusMessage(status: ProcessStatus.running),
      ]);
      await pumpN(tester);
      final input = find.byKey(const ValueKey('message_input'));
      await tester.enterText(input, 'draft in progress');
      await pumpN(tester);

      final l = _l(tester);
      // The chat list is reversed: the last button belongs to the first
      // user message.
      await tester.tap(
        find.byKey(const ValueKey('user_message_actions_button')).last,
      );
      await tester.pump(const Duration(milliseconds: 400));
      await tester.pump(const Duration(milliseconds: 400));
      await tester.tap(find.text(l.rewindToHere));
      await tester.pump(const Duration(milliseconds: 400));
      await tester.pump(const Duration(milliseconds: 400));
      await tester.tap(
        find.byKey(const ValueKey('codex_rewind_confirm_button')),
      );
      await pumpN(tester);
      expect(findSentMessage(bridge, 'rewind')?['targetUuid'], 'omp:entry:e1');
      String composerText() => tester.widget<TextField>(input).controller!.text;
      expect(composerText(), 'Rename the helper');

      await emitAndPump(tester, bridge, [
        const RewindResultMessage(
          success: false,
          mode: 'conversation',
          error: 'Cannot rewind while omp is running',
        ),
      ]);
      await pumpN(tester);

      expect(
        find.text(l.ompRewindFailed('Cannot rewind while omp is running')),
        findsOneWidget,
      );
      expect(composerText(), 'draft in progress');
    });

    testWidgets('queue panel steers the queued message', (tester) async {
      await _pumpOmpScreen(tester, bridge);
      await emitAndPump(tester, bridge, [
        const StatusMessage(status: ProcessStatus.running),
        const ConversationQueueMessage(
          sessionId: testSessionId,
          limit: 1,
          items: [
            QueuedInputItem(
              itemId: 'q1',
              text: 'Also add tests',
              createdAt: '2026-09-29T00:00:00Z',
            ),
          ],
        ),
      ]);
      await pumpN(tester);

      expect(find.byKey(const ValueKey('codex_queue_panel')), findsOneWidget);
      expect(find.text('Also add tests'), findsOneWidget);

      await tester.tap(find.byKey(const ValueKey('codex_queue_steer_button')));
      await pumpN(tester);

      final sent = findSentMessage(bridge, 'steer_queued_input');
      expect(sent?['itemId'], 'q1');
    });

    testWidgets('conversation rewind puts the message back in the composer', (
      tester,
    ) async {
      await _pumpOmpScreen(tester, bridge);
      await emitAndPump(tester, bridge, [
        const UserInputMessage(
          text: 'Rename the helper',
          userMessageUuid: 'omp:entry:e1',
        ),
        makeAssistantMessage('a1', 'Done.'),
        const ResultMessage(subtype: 'success'),
        const StatusMessage(status: ProcessStatus.idle),
      ]);
      await pumpN(tester);

      await tester.tap(
        find.byKey(const ValueKey('user_message_actions_button')).first,
      );
      await tester.pumpAndSettle();
      await tester.tap(find.text(_l(tester).rewindToHere));
      await tester.pumpAndSettle();

      expect(find.text(_l(tester).codexRewindConfirmTitle), findsOneWidget);
      await tester.tap(
        find.byKey(const ValueKey('codex_rewind_confirm_button')),
      );
      await pumpN(tester);

      final sent = findSentMessage(bridge, 'rewind');
      expect(sent, {
        'type': 'rewind',
        'sessionId': testSessionId,
        'targetUuid': 'omp:entry:e1',
        'mode': 'conversation',
      });
      final composer = tester.widget<TextField>(
        find.byKey(const ValueKey('message_input')),
      );
      expect(composer.controller?.text, 'Rename the helper');
    });

    testWidgets('usage bar sums the omp results', (tester) async {
      await _pumpOmpScreen(tester, bridge);
      await emitAndPump(tester, bridge, [
        const ResultMessage(
          subtype: 'success',
          cost: 0.0123,
          duration: 2100,
          inputTokens: 1200,
          cachedInputTokens: 300,
          outputTokens: 450,
          toolCalls: 2,
          fileEdits: 1,
        ),
        const StatusMessage(status: ProcessStatus.idle),
      ]);
      await pumpN(tester);

      expect(find.byKey(const ValueKey('usage_summary_bar')), findsOneWidget);
      expect(find.textContaining('\$0.0123'), findsWidgets);
      expect(find.textContaining('out 450'), findsOneWidget);
    });

    testWidgets('failed messages are not retried', (tester) async {
      await _pumpOmpScreen(tester, bridge);

      final list = tester.widget<ChatMessageList>(find.byType(ChatMessageList));
      expect(list.onRetryMessage, isNull);
      expect(list.onForkMessage, isNull);
      expect(list.isCodex, isFalse);
    });
  });

  test('local notification payload routes to omp', () {
    expect(jsonDecode(ompNotificationPayload('bridge-1')), {
      'sessionId': 'bridge-1',
      'provider': 'omp',
    });
  });
}
