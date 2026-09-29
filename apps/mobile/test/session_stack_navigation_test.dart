import 'package:flutter_test/flutter_test.dart';

import 'package:ccpocket/router/app_router.dart';
import 'package:ccpocket/router/session_stack_navigation.dart';

void main() {
  setUp(SessionRouteRegistry.instance.clear);
  tearDown(SessionRouteRegistry.instance.clear);

  group('SessionStackNavigation.matchesDestination', () {
    test('matches the same Claude session only', () {
      final routeIdentity = Object();
      final arguments = ClaudeSessionRoute(sessionId: 'claude-1').args;

      expect(
        SessionStackNavigation.matchesDestination(
          routeIdentity: routeIdentity,
          routeName: ClaudeSessionRoute.name,
          arguments: arguments,
          sessionId: 'claude-1',
          provider: 'claude',
        ),
        isTrue,
      );
      expect(
        SessionStackNavigation.matchesDestination(
          routeIdentity: routeIdentity,
          routeName: ClaudeSessionRoute.name,
          arguments: arguments,
          sessionId: 'claude-2',
          provider: 'claude',
        ),
        isFalse,
      );
      expect(
        SessionStackNavigation.matchesDestination(
          routeIdentity: routeIdentity,
          routeName: ClaudeSessionRoute.name,
          arguments: arguments,
          sessionId: 'claude-1',
          provider: 'codex',
        ),
        isFalse,
      );
    });

    test('matches the same Codex session only', () {
      final routeIdentity = Object();
      final arguments = CodexSessionRoute(sessionId: 'codex-1').args;

      expect(
        SessionStackNavigation.matchesDestination(
          routeIdentity: routeIdentity,
          routeName: CodexSessionRoute.name,
          arguments: arguments,
          sessionId: 'codex-1',
          provider: 'codex',
        ),
        isTrue,
      );
      expect(
        SessionStackNavigation.matchesDestination(
          routeIdentity: routeIdentity,
          routeName: CodexSessionRoute.name,
          arguments: arguments,
          sessionId: 'codex-1',
          provider: 'claude',
        ),
        isFalse,
      );
    });

    test('matches the same omp session only', () {
      final routeIdentity = Object();
      final arguments = OmpSessionRoute(sessionId: 'omp-1').args;

      expect(
        SessionStackNavigation.matchesDestination(
          routeIdentity: routeIdentity,
          routeName: OmpSessionRoute.name,
          arguments: arguments,
          sessionId: 'omp-1',
          provider: 'omp',
        ),
        isTrue,
      );
      expect(
        SessionStackNavigation.matchesDestination(
          routeIdentity: routeIdentity,
          routeName: OmpSessionRoute.name,
          arguments: arguments,
          sessionId: 'omp-1',
          provider: 'claude',
        ),
        isFalse,
      );
      expect(
        SessionStackNavigation.matchesDestination(
          routeIdentity: routeIdentity,
          routeName: OmpSessionRoute.name,
          arguments: arguments,
          sessionId: 'omp-2',
          provider: 'omp',
        ),
        isFalse,
      );
    });

    test('does not treat an in-flight session link as a destination', () {
      final routeIdentity = Object();
      final arguments = SessionLinkRoute(
        sessionId: 'linked-1',
        provider: 'claude',
      ).args;

      expect(
        SessionStackNavigation.matchesDestination(
          routeIdentity: routeIdentity,
          routeName: SessionLinkRoute.name,
          arguments: arguments,
          sessionId: 'linked-1',
          provider: 'claude',
        ),
        isFalse,
      );
    });

    test('prefers a live session identity over stale route arguments', () {
      final routeIdentity = Object();
      final owner = Object();
      final arguments = ClaudeSessionRoute(sessionId: 'old-session').args;
      SessionRouteRegistry.instance.update(
        routeIdentity: routeIdentity,
        owner: owner,
        sessionId: 'new-session',
        provider: 'claude',
      );

      expect(
        SessionStackNavigation.matchesDestination(
          routeIdentity: routeIdentity,
          routeName: ClaudeSessionRoute.name,
          arguments: arguments,
          sessionId: 'new-session',
          provider: 'claude',
        ),
        isTrue,
      );
      expect(
        SessionStackNavigation.matchesDestination(
          routeIdentity: routeIdentity,
          routeName: ClaudeSessionRoute.name,
          arguments: arguments,
          sessionId: 'old-session',
          provider: 'claude',
        ),
        isFalse,
      );
    });

    test('only the current owner can remove a route identity', () {
      final routeIdentity = Object();
      final oldOwner = Object();
      final newOwner = Object();
      SessionRouteRegistry.instance.update(
        routeIdentity: routeIdentity,
        owner: oldOwner,
        sessionId: 'old-session',
        provider: 'claude',
      );
      SessionRouteRegistry.instance.update(
        routeIdentity: routeIdentity,
        owner: newOwner,
        sessionId: 'new-session',
        provider: 'claude',
      );

      SessionRouteRegistry.instance.remove(
        routeIdentity: routeIdentity,
        owner: oldOwner,
      );

      expect(
        SessionRouteRegistry.instance.identityFor(routeIdentity)?.sessionId,
        'new-session',
      );
    });
  });
}
