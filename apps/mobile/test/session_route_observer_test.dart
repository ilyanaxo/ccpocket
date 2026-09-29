import 'package:flutter/widgets.dart';
import 'package:flutter_test/flutter_test.dart';

import 'package:ccpocket/router/app_router.dart';
import 'package:ccpocket/router/session_route_observer.dart';
import 'package:ccpocket/services/notification_service.dart';

class _SessionArgs {
  _SessionArgs(this.sessionId);

  final String sessionId;
}

Route<dynamic> _route({String? name, Object? arguments}) {
  return PageRouteBuilder<void>(
    settings: RouteSettings(name: name, arguments: arguments),
    pageBuilder: (_, _, _) => const SizedBox.shrink(),
  );
}

class _TestPopupRoute extends PopupRoute<void> {
  _TestPopupRoute({String? name}) : super(settings: RouteSettings(name: name));

  @override
  Color? get barrierColor => null;

  @override
  bool get barrierDismissible => true;

  @override
  String? get barrierLabel => null;

  @override
  Duration get transitionDuration => Duration.zero;

  @override
  Widget buildPage(
    BuildContext context,
    Animation<double> animation,
    Animation<double> secondaryAnimation,
  ) => const SizedBox.shrink();
}

void main() {
  TestWidgetsFlutterBinding.ensureInitialized();
  final observer = SessionRouteObserver();

  setUp(() {
    NotificationService.instance.clearActiveSession();
  });

  test('does not throw when route has no arguments', () {
    NotificationService.instance.setActiveSession(
      sessionId: 'seed',
      provider: 'claude',
    );

    expect(
      () => observer.didPush(_route(name: AdaptiveHomeRoute.name), null),
      returnsNormally,
    );
    expect(
      NotificationService.instance.isActiveSession(
        sessionId: 'seed',
        provider: 'claude',
      ),
      isFalse,
    );
  });

  test('tracks claude session route', () {
    observer.didPush(
      _route(
        name: ClaudeSessionRoute.name,
        arguments: _SessionArgs('claude-1'),
      ),
      null,
    );

    expect(
      NotificationService.instance.isActiveSession(
        sessionId: 'claude-1',
        provider: 'claude',
      ),
      isTrue,
    );
  });

  test('tracks codex session route', () {
    observer.didPush(
      _route(name: CodexSessionRoute.name, arguments: _SessionArgs('codex-1')),
      null,
    );

    expect(
      NotificationService.instance.isActiveSession(
        sessionId: 'codex-1',
        provider: 'codex',
      ),
      isTrue,
    );
  });

  test('tracks omp session route', () {
    observer.didPush(
      _route(name: OmpSessionRoute.name, arguments: _SessionArgs('omp-1')),
      null,
    );

    expect(
      NotificationService.instance.isActiveSession(
        sessionId: 'omp-1',
        provider: 'omp',
      ),
      isTrue,
    );
    expect(
      NotificationService.instance.isActiveSession(
        sessionId: 'omp-1',
        provider: 'claude',
      ),
      isFalse,
    );
  });

  test('supports map-style arguments', () {
    observer.didPush(
      _route(
        name: ClaudeSessionRoute.name,
        arguments: <String, Object?>{'sessionId': 'map-1'},
      ),
      null,
    );

    expect(
      NotificationService.instance.isActiveSession(
        sessionId: 'map-1',
        provider: 'claude',
      ),
      isTrue,
    );
  });

  test('clears active session for non-session routes', () {
    NotificationService.instance.setActiveSession(
      sessionId: 'seed',
      provider: 'claude',
    );

    observer.didPush(_route(name: SettingsRoute.name), null);

    expect(NotificationService.instance.activeSessionId, isNull);
    expect(NotificationService.instance.activeProvider, isNull);
  });

  test('keeps active session when popup route is pushed over a session', () {
    observer.didPush(
      _route(
        name: ClaudeSessionRoute.name,
        arguments: _SessionArgs('claude-1'),
      ),
      null,
    );

    observer.didPush(_TestPopupRoute(name: 'test_popup'), null);

    expect(NotificationService.instance.activeSessionId, 'claude-1');
    expect(NotificationService.instance.activeProvider, 'claude');
  });
}
