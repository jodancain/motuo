import Foundation
import SwiftData

@Model final class Vehicle {
    @Attribute(.unique) var id: UUID
    var name: String
    var make: String
    var model: String
    var year: Int?
    var abs: Bool?
    var displacementCC: Int
    var plate: String
    var tyres: String
    var modifications: String
    var odometerKM: Double
    var createdAt: Date
    init(name: String = "我的 GSX250R", make: String = "SUZUKI", model: String = "GSX250R") {
        id = UUID(); self.name = name; self.make = make; self.model = model
        displacementCC = 248; plate = ""; tyres = ""; modifications = ""; odometerKM = 0; createdAt = Date()
    }
    var payload: VehiclePayload {
        .init(id: id, name: name, make: make, model: model, year: year, abs: abs,
              displacementCC: displacementCC, plate: plate, tyres: tyres,
              modifications: modifications, odometerKM: odometerKM)
    }
}

struct VehiclePayload: Codable {
    var id: UUID; var name: String; var make: String; var model: String
    var year: Int?; var abs: Bool?; var displacementCC: Int; var plate: String
    var tyres: String; var modifications: String; var odometerKM: Double
}

@Model final class Ride {
    @Attribute(.unique) var id: UUID
    var vehicleId: UUID
    var vehicleName: String
    var startedAt: Date
    var endedAt: Date?
    var status: String
    var source: String
    var distanceM: Double
    var durationS: Double
    var maxSpeedMPS: Double
    var validSpeedSamples: Int = 0
    var dataVersion: Int
    var eventsData: Data
    var summaryText: String
    var aiText: String
    var reportStatus: String
    var syncStatus: String
    var syncedChunks: Int
    var segmentStartedAt: Date?
    var calibrationId: UUID?
    var learningVersionId: UUID?
    var notes: String
    init(vehicle: Vehicle, simulated: Bool) {
        id = UUID(); vehicleId = vehicle.id; vehicleName = vehicle.name
        startedAt = Date(); status = "recording"; source = simulated ? "simulated" : "measured"
        distanceM = 0; durationS = 0; maxSpeedMPS = 0; dataVersion = 1
        eventsData = Data(); summaryText = ""; aiText = ""; reportStatus = "local"
        syncStatus = "local"; syncedChunks = 0; segmentStartedAt = Date(); notes = ""
    }
    var isSimulated: Bool { source == "simulated" }
    var isFinished: Bool { status == "finished" }
    var meanSpeedMPS: Double { durationS > 0 ? distanceM / durationS : 0 }
    var events: [RideEvent] {
        get { (try? JSONDecoder().decode([RideEvent].self, from: eventsData)) ?? [] }
        set { eventsData = (try? JSONEncoder().encode(newValue)) ?? Data() }
    }
    var payload: RidePayload {
        .init(id: id, vehicleId: vehicleId, startedAt: startedAt, endedAt: endedAt,
              status: status, source: source, distanceM: distanceM, durationS: durationS,
              maxSpeedMPS: maxSpeedMPS, meanSpeedMPS: meanSpeedMPS,
              dataVersion: dataVersion, events: events,
              summary: .init(text: summaryText, confirmedEvents: events.filter { $0.feedback == "confirmed" }.count, validSpeedSamples:validSpeedSamples))
    }
}

struct RidePayload: Codable {
    var id: UUID; var vehicleId: UUID; var startedAt: Date; var endedAt: Date?
    var status: String; var source: String; var distanceM: Double; var durationS: Double
    var maxSpeedMPS: Double; var meanSpeedMPS: Double; var dataVersion: Int
    var events: [RideEvent]; var summary: LocalSummaryPayload
}
struct LocalSummaryPayload: Codable { var text: String; var confirmedEvents: Int; var validSpeedSamples:Int }

struct RideEvent: Codable, Identifiable, Equatable, Sendable {
    var id: UUID = UUID()
    var kind: String
    var timestamp: Date
    var windowStart: Date
    var windowEnd: Date
    var confidence: Double
    var source: String
    var feedback: String?
    var note: String = ""
    var title: String {
        switch kind {
        case "suspectedShift": return "疑似换挡"
        case "braking": return "减速变化"
        case "turn": return "转向片段"
        case "dataGap": return "记录间断"
        default: return "动态变化"
        }
    }
}

struct TelemetrySample: Codable, Sendable {
    var timestamp: Date
    var monotonicS: Double
    var source: String
    var stream: String?
    var segmentId: String?
    var speedMPS: Double?
    var latitude: Double?
    var longitude: Double?
    var horizontalAccuracyM: Double?
    var speedAccuracyMPS: Double?
    var accelerationX: Double?
    var accelerationY: Double?
    var accelerationZ: Double?
    var rotationX: Double?
    var rotationY: Double?
    var rotationZ: Double?
    var rollRad: Double?
    var quality: String
    var calibrationId: String?
}

struct ManualRecord: Codable, Identifiable {
    var id: String; var vehicleId: String?; var fileName: String; var totalBytes: Int
    var pageCount: Int; var status: String; var progress: Int; var error: String?
}
struct ManualCitation: Codable, Identifiable {
    var manualId: String; var fileName: String; var page: Int
    var printedPage: String?; var section: String?; var quote: String
    var id: String { "\(manualId)-\(page)-\(quote.prefix(20))" }
}
struct ManualAnswer: Codable {
    var answer: String; var source: String; var citations: [ManualCitation]; var limitations: [String]
}
struct ItemsResponse<T: Decodable>: Decodable { var items: [T] }

@Model final class MaintenanceEntry {
    @Attribute(.unique) var id:UUID
    var vehicleId:UUID
    var performedAt:Date
    var odometerKM:Double
    var category:String
    var note:String
    var syncStatus:String
    init(vehicleId:UUID,performedAt:Date,odometerKM:Double,category:String,note:String) {
        id=UUID();self.vehicleId=vehicleId;self.performedAt=performedAt;self.odometerKM=odometerKM
        self.category=category;self.note=note;syncStatus="local"
    }
    var payload:MaintenancePayload { .init(vehicleId:vehicleId,id:id,performedAt:performedAt,odometerKM:odometerKM,category:category,note:note) }
}
struct MaintenancePayload:Codable {
    var vehicleId:UUID;var id:UUID;var performedAt:Date;var odometerKM:Double;var category:String;var note:String
}

enum MotuoJSON {
    static func encoder() -> JSONEncoder {
        let e = JSONEncoder(); e.outputFormatting = [.sortedKeys]
        e.dateEncodingStrategy = .custom { date,encoder in
            var container=encoder.singleValueContainer()
            try container.encode(date.ISO8601Format(.init(includingFractionalSeconds:true)))
        }; return e
    }
    static func decoder() -> JSONDecoder {
        let d = JSONDecoder(); d.dateDecodingStrategy = .custom { decoder in
            let string=try decoder.singleValueContainer().decode(String.self)
            let formatter=ISO8601DateFormatter();formatter.formatOptions=[.withInternetDateTime,.withFractionalSeconds]
            if let date=formatter.date(from:string){return date};formatter.formatOptions=[.withInternetDateTime]
            guard let date=formatter.date(from:string) else { throw DecodingError.dataCorrupted(.init(codingPath:decoder.codingPath,debugDescription:"Invalid timestamp")) };return date
        }; return d
    }
}
