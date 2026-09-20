import Foundation
import Observation
import SwiftData

struct EmptyAPIResponse: Decodable { }
struct RideReportResponse: Decodable {
    var status: String; var dataVersion: Int; var source: String?; var text: String?; var createdAt: Date?
}
@MainActor @Observable final class CloudRideSync {
    static let shared = CloudRideSync()
    var activeRideIDs: Set<UUID> = []
    var statusMessage = "记录先保存在本机"
    func sync(_ ride: Ride, vehicle: Vehicle?, context: ModelContext) async {
        guard ride.isFinished, !activeRideIDs.contains(ride.id), APIClient.shared.isPaired else { return }
        activeRideIDs.insert(ride.id); ride.syncStatus = "syncing"
        defer { activeRideIDs.remove(ride.id) }
        let version = ride.dataVersion
        do {
            if let vehicle { let _: EmptyAPIResponse = try await APIClient.shared.request("/v1/vehicles/\(vehicle.id.uuidString)",method:"PUT",body:try APIClient.encoder.encode(vehicle.payload)) }
            let _: EmptyAPIResponse = try await APIClient.shared.request("/v1/rides/\(ride.id.uuidString)",method:"PUT",body:try APIClient.encoder.encode(ride.payload))
            let journal = try TelemetryJournal(rideId:ride.id)
            let chunks = try journal.flush()
            for chunk in chunks {
                try Task.checkCancellation()
                try await APIClient.shared.upload("/v1/rides/\(ride.id.uuidString)/chunks/\(chunk.sequence)",data:try journal.data(for:chunk),sha256:chunk.sha256)
                ride.syncedChunks = chunk.sequence + 1; statusMessage = "同步记录 \(chunk.sequence+1)/\(chunks.count)"
            }
            struct FinishPayload: Encodable { var dataVersion:Int; var expectedChunks:Int; var summary:LocalSummaryPayload; var endedAt:Date }
            let payload = FinishPayload(dataVersion:version,expectedChunks:chunks.count,summary:ride.payload.summary,endedAt:ride.endedAt ?? Date())
            let _: EmptyAPIResponse = try await APIClient.shared.request("/v1/rides/\(ride.id.uuidString)/finish",method:"POST",body:try APIClient.encoder.encode(payload))
            for event in ride.events where event.feedback != nil && event.source == "inferred" {
                let body = try JSONSerialization.data(withJSONObject:["label":event.feedback!,"note":event.note])
                let _: EmptyAPIResponse = try await APIClient.shared.request("/v1/rides/\(ride.id.uuidString)/events/\(event.id.uuidString)/feedback",method:"POST",body:body)
            }
            guard ride.dataVersion == version else { ride.syncStatus = "local"; statusMessage = "记录已更新，需要重新同步"; return }
            ride.syncStatus = "synced"; statusMessage = "已同步私人 NAS"; try context.save()
            await fetchReport(ride,context:context)
        } catch {
            ride.syncStatus = "failed"; statusMessage = "同步未完成，可安全重试：\(error.localizedDescription)"; try? context.save()
        }
    }
    func fetchReport(_ ride:Ride,context:ModelContext) async {
        guard APIClient.shared.isPaired else { return }
        let version = ride.dataVersion
        do {
            let report: RideReportResponse = try await APIClient.shared.request("/v1/rides/\(ride.id.uuidString)/report")
            guard ride.dataVersion == version, report.dataVersion == version else { return }
            ride.reportStatus = report.status
            if report.status == "ready",report.source == "ai" { ride.aiText = report.text ?? "" }
            try context.save()
        } catch { statusMessage = "AI 复盘稍后可重试；本地复盘已可用" }
    }
}
