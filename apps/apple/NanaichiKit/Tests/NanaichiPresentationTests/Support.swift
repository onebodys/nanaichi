import Foundation
import NanaichiDomain
import NanaichiPresentation

let t0 = Instant(milliseconds: 1_793_610_000_000)
let tokyo = TimeZoneName("Asia/Tokyo")!

func minutes(_ value: Int64, _ seconds: Int64 = 0) -> Instant {
    t0.adding(milliseconds: value * 60_000 + seconds * 1000)
}

func newEventId() -> SessionEventId { SessionEventId(UUID().uuidString.lowercased())! }

let manualToJournal = AdvanceMode(
    focusToJournal: .manual, journalToFocus: .auto, journalToBreak: .auto, breakToFocus: .auto)

func started(mode: AdvanceMode = .allAuto) -> Session {
    Session.start(
        id: SessionId("0b7a2c4e-1f3d-4a5b-8c6d-7e8f9a0b1c2d")!, startEventId: newEventId(), now: t0,
        advanceModeChanges: [AdvanceModeChange(at: t0.adding(milliseconds: -1), mode: mode)])
}

func operated(_ session: Session, _ kind: SessionOperationKind, at: Instant) throws -> Session {
    try session.operate(RecordedSessionEvent(id: newEventId(), event: SessionOperation(kind: kind, at: at))).get()
        .session
}

func received(_ session: Session, at serverTime: Instant) -> Received {
    Received(snapshot: session.snapshot(at: serverTime), offset: ClockOffset(serverAheadMs: 0))
}
