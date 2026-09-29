import 'package:flutter/foundation.dart' show kIsWeb;

/// Query parameter carrying the Bridge API key, as on the WebSocket URL.
const bridgeApiKeyQueryParameter = 'token';

/// Adds the Bridge API key to HTTP requests sent to one Bridge origin.
///
/// Requests use the `Authorization: Bearer` header where the request API
/// accepts headers; image widgets get theirs from [imageRequest]. URL-only
/// consumers such as media players use [authorizeUrl], which adds the `token`
/// query parameter instead. The key is only attached to URLs with the Bridge
/// origin, so absolute URLs to other hosts never receive it.
class BridgeHttpAuth {
  static const none = BridgeHttpAuth(baseUrl: null, apiKey: null);

  /// Credentials of the Bridge the app is connected to.
  ///
  /// [BridgeService] updates this on every connect and disconnect, so code
  /// that only holds a Bridge URL can authorize its request.
  static BridgeHttpAuth current = none;

  /// Bridge HTTP base URL, e.g. `http://127.0.0.1:8765`.
  final String? baseUrl;

  final String? apiKey;

  const BridgeHttpAuth({required this.baseUrl, required this.apiKey});

  /// Whether requests to [uri] must carry the API key.
  bool appliesTo(Uri uri) {
    final key = apiKey;
    final base = baseUrl == null ? null : Uri.tryParse(baseUrl!);
    if (key == null || key.isEmpty || base == null) return false;
    if (base.scheme != 'http' && base.scheme != 'https') return false;
    return uri.scheme == base.scheme &&
        uri.host.toLowerCase() == base.host.toLowerCase() &&
        _effectivePort(uri) == _effectivePort(base);
  }

  /// Headers for a request to [uri]; empty unless it targets the Bridge.
  Map<String, String> headersFor(Uri uri) => appliesTo(uri)
      ? {'Authorization': 'Bearer $apiKey'}
      : const <String, String>{};

  /// [url] with the API key as `token` query parameter when it targets the
  /// Bridge; otherwise [url] unchanged.
  String authorizeUrl(String url) {
    final uri = Uri.tryParse(url);
    if (uri == null || !appliesTo(uri)) return url;
    return uri
        .replace(
          queryParameters: {
            ...uri.queryParametersAll,
            bridgeApiKeyQueryParameter: apiKey!,
          },
        )
        .toString();
  }

  /// URL and headers with which an image widget loads [url].
  ///
  /// Native platforms send the key as header. It stays out of image cache
  /// keys, and Bridges from before HTTP authentication ignore it, whereas
  /// their gallery route answers a URL with a query string with 404. On the
  /// [web], images load without custom headers, and such Bridges do not allow
  /// the `Authorization` header cross-origin, so the key goes in the URL.
  ({String url, Map<String, String>? headers}) imageRequest(
    String url, {
    bool web = kIsWeb,
  }) {
    if (web) return (url: authorizeUrl(url), headers: null);
    final uri = Uri.tryParse(url);
    final headers = uri == null ? const <String, String>{} : headersFor(uri);
    return (url: url, headers: headers.isEmpty ? null : headers);
  }

  static int _effectivePort(Uri uri) => uri.hasPort
      ? uri.port
      : switch (uri.scheme) {
          'https' => 443,
          _ => 80,
        };
}
