import 'package:ccpocket/features/session_link/session_link_screen.dart';
import 'package:ccpocket/l10n/app_localizations.dart';
import 'package:ccpocket/services/bridge_service.dart';
import 'package:flutter/material.dart';
import 'package:flutter_bloc/flutter_bloc.dart';
import 'package:flutter_test/flutter_test.dart';

class _OmpSupportBridge extends BridgeService {
  _OmpSupportBridge(this.support);

  final OmpSupport support;
  var resolveCalls = 0;

  @override
  Future<OmpSupport> waitForConnectionOmpSupport({
    Duration timeout = const Duration(seconds: 10),
  }) async => support;

  @override
  Future<SessionLinkResolveResult> resolveSessionLink(
    String sessionId, {
    String provider = 'claude',
    Duration timeout = const Duration(seconds: 10),
  }) async {
    resolveCalls++;
    return const SessionLinkResolveResult.unavailable();
  }
}

void main() {
  Widget wrap(Widget child) {
    return MaterialApp(
      localizationsDelegates: AppLocalizations.localizationsDelegates,
      supportedLocales: AppLocalizations.supportedLocales,
      home: child,
    );
  }

  testWidgets('shows a friendly unavailable state with a recovery action', (
    tester,
  ) async {
    var openedRecentSessions = false;
    await tester.pumpWidget(
      wrap(
        SessionLinkStatusView(
          unavailable: true,
          resuming: false,
          onOpenRecentSessions: () => openedRecentSessions = true,
        ),
      ),
    );

    expect(find.text('Session unavailable'), findsOneWidget);
    expect(
      find.byKey(const ValueKey('open_recent_sessions_button')),
      findsOneWidget,
    );

    await tester.tap(find.byKey(const ValueKey('open_recent_sessions_button')));
    expect(openedRecentSessions, isTrue);
  });

  testWidgets('distinguishes resolving from resuming', (tester) async {
    await tester.pumpWidget(
      wrap(
        SessionLinkStatusView(
          unavailable: false,
          resuming: false,
          onOpenRecentSessions: () {},
        ),
      ),
    );
    expect(find.text('Finding session...'), findsOneWidget);

    await tester.pumpWidget(
      wrap(
        SessionLinkStatusView(
          unavailable: false,
          resuming: true,
          onOpenRecentSessions: () {},
        ),
      ),
    );
    expect(find.text('Resuming session...'), findsOneWidget);
  });

  testWidgets('shows the Bridge update state for an omp link', (tester) async {
    var openedRecentSessions = false;
    await tester.pumpWidget(
      wrap(
        SessionLinkStatusView(
          unavailable: false,
          bridgeUpdateRequired: true,
          resuming: false,
          onOpenRecentSessions: () => openedRecentSessions = true,
        ),
      ),
    );

    final l = AppLocalizations.of(
      tester.element(find.byType(SessionLinkBridgeUpdateView)),
    );
    expect(find.text(l.bridgeUpdateRequiredForOmp), findsOneWidget);
    expect(find.text('Session unavailable'), findsNothing);
    await tester.tap(find.byKey(const ValueKey('open_recent_sessions_button')));
    expect(openedRecentSessions, isTrue);
  });

  testWidgets('an omp link on a Bridge without omp asks for an update', (
    tester,
  ) async {
    final bridge = _OmpSupportBridge(OmpSupport.unsupported);
    addTearDown(bridge.dispose);
    await tester.pumpWidget(
      RepositoryProvider<BridgeService>.value(
        value: bridge,
        child: wrap(
          const SessionLinkScreen(sessionId: 'omp-1', provider: 'omp'),
        ),
      ),
    );
    await tester.pump();
    await tester.pump();

    final l = AppLocalizations.of(
      tester.element(find.byType(SessionLinkBridgeUpdateView)),
    );
    expect(find.text(l.bridgeUpdateRequiredForOmp), findsOneWidget);
    expect(bridge.resolveCalls, 0);
  });
}
