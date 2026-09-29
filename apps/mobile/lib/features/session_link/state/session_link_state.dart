import 'package:freezed_annotation/freezed_annotation.dart';

import '../../../models/messages.dart';

part 'session_link_state.freezed.dart';

@freezed
sealed class SessionLinkState with _$SessionLinkState {
  const factory SessionLinkState.resolving() = SessionLinkResolving;

  const factory SessionLinkState.resuming() = SessionLinkResuming;

  const factory SessionLinkState.openLive({
    required String bridgeSessionId,
    required String provider,
  }) = SessionLinkOpenLive;

  const factory SessionLinkState.openResumed({
    required SystemMessage session,
    String? gitBranch,
  }) = SessionLinkOpenResumed;

  const factory SessionLinkState.openLegacy() = SessionLinkOpenLegacy;

  /// The link names an omp session, but the connected Bridge does not
  /// support omp (`provider_omp_v1`).
  const factory SessionLinkState.bridgeUpdateRequired() =
      SessionLinkBridgeUpdateRequired;

  const factory SessionLinkState.unavailable() = SessionLinkUnavailable;
}
