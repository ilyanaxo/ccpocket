import 'package:ccpocket/models/messages.dart';
import 'package:ccpocket/models/new_session_tab.dart';
import 'package:flutter_test/flutter_test.dart';

void main() {
  group('enabledProvidersFromTabs', () {
    test('keeps the tab order', () {
      expect(
        enabledProvidersFromTabs(const [NewSessionTab.omp, NewSessionTab.codex])
            .toList(),
        [Provider.omp, Provider.codex],
      );
    });
  });

  group('tabsWithProvider', () {
    test('appends an enabled provider and removes a disabled one', () {
      expect(
        tabsWithProvider(const [NewSessionTab.codex], Provider.omp, true),
        [NewSessionTab.codex, NewSessionTab.omp],
      );
      expect(
        tabsWithProvider(
          const [NewSessionTab.codex, NewSessionTab.omp],
          Provider.codex,
          false,
        ),
        [NewSessionTab.omp],
      );
    });

    test('is a no-op for an already applied state', () {
      expect(
        tabsWithProvider(const [NewSessionTab.claude], Provider.claude, true),
        [NewSessionTab.claude],
      );
      expect(
        tabsWithProvider(const [NewSessionTab.claude], Provider.omp, false),
        [NewSessionTab.claude],
      );
    });

    test('never disables the last provider', () {
      expect(tabsWithProvider(const [NewSessionTab.omp], Provider.omp, false), [
        NewSessionTab.omp,
      ]);
    });
  });

  group('effectiveProviders', () {
    test('offers omp only when the Bridge supports it', () {
      expect(
        effectiveProviders(
          defaultNewSessionTabs,
          OmpSupport.supported,
        ).toList(),
        [Provider.codex, Provider.claude, Provider.omp],
      );
      expect(
        effectiveProviders(defaultNewSessionTabs, OmpSupport.unsupported),
        {Provider.codex, Provider.claude},
      );
      expect(effectiveProviders(defaultNewSessionTabs, OmpSupport.unknown), {
        Provider.codex,
        Provider.claude,
      });
    });

    test('respects disabled agents', () {
      expect(
        effectiveProviders(const [
          NewSessionTab.claude,
          NewSessionTab.omp,
        ], OmpSupport.supported),
        {Provider.claude, Provider.omp},
      );
    });

    test('falls back to Claude and Codex when only omp is enabled', () {
      expect(
        effectiveProviders(const [NewSessionTab.omp], OmpSupport.unsupported),
        {Provider.claude, Provider.codex},
      );
      expect(
        effectiveProviders(const [NewSessionTab.omp], OmpSupport.supported),
        {Provider.omp},
      );
    });
  });

  test('omp is enabled by default', () {
    expect(defaultNewSessionTabs, contains(NewSessionTab.omp));
  });
}
