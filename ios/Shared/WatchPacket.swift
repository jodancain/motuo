import Foundation

struct WatchRideContext: Codable {
    var isRiding: Bool
    var isSimulated: Bool
    var speedKPH: Double?
    var distanceKM: Double
    var elapsedSeconds: Double
    var status: String
    var updatedAt: Date
    var isSummary: Bool?
    var navTitle: String?
    var navInstruction: String?
    var cleared: Bool?
}

struct RideHapticEvent: Codable, Identifiable {
    var id: UUID = UUID()
    var kind: Kind
    var createdAt: Date = Date()
    var expiresAt: Date
    enum Kind: String, Codable { case start, milestone, pause, finish }
    init(kind: Kind, now: Date = Date(), ttl: TimeInterval = 3) {
        self.kind = kind; self.createdAt = now; self.expiresAt = now.addingTimeInterval(ttl)
    }
}

/// Delivery eligibility is deliberately independent of transport success.
struct HapticGate {
    private(set) var seen: [UUID: Date] = [:]
    private(set) var lastPlayedAt: Date?
    mutating func accept(_ event: RideHapticEvent, now: Date, isActive: Bool) -> Bool {
        seen = seen.filter { now.timeIntervalSince($0.value) < 120 }
        guard seen[event.id] == nil else { return false }
        seen[event.id] = now
        guard isActive, event.createdAt <= now.addingTimeInterval(2), event.expiresAt > now,
              event.expiresAt.timeIntervalSince(event.createdAt) <= 10 else { return false }
        if let lastPlayedAt, now.timeIntervalSince(lastPlayedAt) < 3 { return false }
        lastPlayedAt = now
        return true
    }
}
