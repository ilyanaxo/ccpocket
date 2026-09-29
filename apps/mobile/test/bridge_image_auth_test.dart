import 'dart:convert';
import 'dart:io';

import 'package:ccpocket/features/gallery/widgets/gallery_tile.dart';
import 'package:ccpocket/l10n/app_localizations.dart';
import 'package:ccpocket/models/messages.dart';
import 'package:ccpocket/services/bridge_http_auth.dart';
import 'package:ccpocket/theme/app_theme.dart';
import 'package:ccpocket/widgets/bubbles/image_preview.dart';
import 'package:ccpocket/widgets/bubbles/user_bubble.dart';
import 'package:extended_image/extended_image.dart';
import 'package:flutter/material.dart';
import 'package:flutter/painting.dart';
import 'package:flutter/services.dart';
import 'package:flutter_test/flutter_test.dart';

/// 1x1 transparent PNG.
final _png = base64Decode(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA'
  '60e6kgAAAABJRU5ErkJggg==',
);

/// Serves gallery images like Bridges from before HTTP authentication: the
/// raw request target must be exactly `/api/gallery/<id>`.
class _ExactPathGalleryBridge {
  final HttpServer _server;

  /// `Authorization` header per raw request target.
  final requests = <String, String?>{};

  _ExactPathGalleryBridge._(this._server) {
    _server.listen((request) async {
      final target = request.uri.toString();
      requests[target] = request.headers.value('authorization');
      final response = request.response;
      if (RegExp(r'^/api/gallery/([a-zA-Z0-9_-]+)$').hasMatch(target)) {
        response.headers.contentType = ContentType('image', 'png');
        response.add(_png);
      } else {
        response.statusCode = HttpStatus.notFound;
      }
      await response.close();
    });
  }

  static Future<_ExactPathGalleryBridge> start() async =>
      _ExactPathGalleryBridge._(
        await HttpServer.bind(InternetAddress.loopbackIPv4, 0),
      );

  String get baseUrl => 'http://127.0.0.1:${_server.port}';

  Future<void> close() => _server.close(force: true);
}

/// Creates real HTTP clients despite the test binding's stub.
class _RealHttpOverrides extends HttpOverrides {}

Widget _wrap(Widget child) {
  return MaterialApp(
    theme: AppTheme.darkTheme,
    localizationsDelegates: AppLocalizations.localizationsDelegates,
    supportedLocales: AppLocalizations.supportedLocales,
    locale: const Locale('en'),
    home: Scaffold(body: SingleChildScrollView(child: child)),
  );
}

void main() {
  const bridgeBaseUrl = 'http://127.0.0.1:41000';

  setUp(() {
    BridgeHttpAuth.current = const BridgeHttpAuth(
      baseUrl: bridgeBaseUrl,
      apiKey: 'secret',
    );
  });

  tearDown(() => BridgeHttpAuth.current = BridgeHttpAuth.none);

  testWidgets('Bridge images in previews carry the API key', (tester) async {
    await tester.pumpWidget(
      _wrap(
        const ImagePreviewWidget(
          images: [ImageRef(id: 'a', url: '/images/a', mimeType: 'image/png')],
          httpBaseUrl: bridgeBaseUrl,
        ),
      ),
    );

    final image = tester.widget<ExtendedImage>(find.byType(ExtendedImage));
    final provider = image.image as ExtendedNetworkImageProvider;
    expect(provider.url, '$bridgeBaseUrl/images/a');
    expect(provider.headers, {'Authorization': 'Bearer secret'});
  });

  testWidgets('Bridge images in user messages carry the API key', (
    tester,
  ) async {
    await tester.pumpWidget(
      _wrap(
        const UserBubble(
          text: 'see image',
          imageUrls: ['/images/b'],
          httpBaseUrl: bridgeBaseUrl,
        ),
      ),
    );

    final image = tester.widget<Image>(find.byType(Image));
    final provider = image.image as NetworkImage;
    expect(provider.url, '$bridgeBaseUrl/images/b');
    expect(provider.headers, {'Authorization': 'Bearer secret'});
  });

  testWidgets('gallery images load from Bridges that match exact paths', (
    tester,
  ) async {
    final server = (await tester.runAsync(_ExactPathGalleryBridge.start))!;
    // The image disk cache lives in the temporary directory.
    final cacheDir = Directory.systemTemp.createTempSync('gallery_cache');
    tester.binding.defaultBinaryMessenger.setMockMethodCallHandler(
      const MethodChannel('plugins.flutter.io/path_provider'),
      (_) async => cacheDir.path,
    );
    final client = HttpOverrides.runWithHttpOverrides(
      HttpClient.new,
      _RealHttpOverrides(),
    );
    debugNetworkImageHttpClientProvider = () => client;
    try {
      BridgeHttpAuth.current = BridgeHttpAuth(
        baseUrl: server.baseUrl,
        apiKey: 'secret',
      );
      await tester.pumpWidget(
        _wrap(
          SizedBox(
            width: 120,
            height: 160,
            child: GalleryTile(
              image: const GalleryImage(
                id: 'img-1',
                url: '/api/gallery/img-1',
                mimeType: 'image/png',
                projectPath: '/tmp/project',
                projectName: 'project',
                addedAt: '2026-09-29T00:00:00Z',
                sizeBytes: 68,
              ),
              httpBaseUrl: server.baseUrl,
              timeAgo: 'now',
            ),
          ),
        ),
      );
      // The image loads in the test zone: let real I/O and frames alternate.
      for (var i = 0; i < 100; i++) {
        if (find.byType(CircularProgressIndicator).evaluate().isEmpty) break;
        await tester.runAsync(
          () => Future<void>.delayed(const Duration(milliseconds: 20)),
        );
        await tester.pump();
      }

      expect(server.requests, {'/api/gallery/img-1': 'Bearer secret'});
      expect(find.byType(CircularProgressIndicator), findsNothing);
      expect(find.byIcon(Icons.broken_image), findsNothing);
    } finally {
      debugNetworkImageHttpClientProvider = null;
      client.close(force: true);
      tester.binding.defaultBinaryMessenger.setMockMethodCallHandler(
        const MethodChannel('plugins.flutter.io/path_provider'),
        null,
      );
      await tester.runAsync(server.close);
      cacheDir.deleteSync(recursive: true);
    }
  });

  testWidgets('images on other hosts never get the API key', (tester) async {
    BridgeHttpAuth.current = const BridgeHttpAuth(
      baseUrl: 'http://127.0.0.1:41001',
      apiKey: 'secret',
    );
    await tester.pumpWidget(
      _wrap(
        const ImagePreviewWidget(
          images: [ImageRef(id: 'a', url: '/images/a', mimeType: 'image/png')],
          httpBaseUrl: bridgeBaseUrl,
        ),
      ),
    );

    final image = tester.widget<ExtendedImage>(find.byType(ExtendedImage));
    final provider = image.image as ExtendedNetworkImageProvider;
    expect(provider.url, '$bridgeBaseUrl/images/a');
    expect(provider.headers, isNull);
  });
}
