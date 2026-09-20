import Foundation
import SwiftData

@MainActor enum CloudGarageSync {
    /// Bring existing NAS vehicles into a freshly paired phone; preserve local edits and ride identities.
    static func restore(context:ModelContext,settings:AppSettings) async throws {
        guard APIClient.shared.isPaired else{return}
        let response:ItemsResponse<VehiclePayload>=try await APIClient.shared.request("/v1/vehicles")
        let locals=try context.fetch(FetchDescriptor<Vehicle>())
        let rides=try context.fetch(FetchDescriptor<Ride>())
        let maintenance=try context.fetch(FetchDescriptor<MaintenanceEntry>())
        let seedId=UserDefaults.standard.string(forKey:"autoSeedVehicleID")
        for remote in response.items where !locals.contains(where:{$0.id==remote.id}) {
            let emptySeed=locals.first {
                $0.id.uuidString==seedId && $0.make.caseInsensitiveCompare(remote.make) == .orderedSame && $0.model.caseInsensitiveCompare(remote.model) == .orderedSame &&
                $0.name=="我的 GSX250R" && $0.odometerKM==0 && $0.plate.isEmpty && $0.modifications.isEmpty &&
                $0.tyres.isEmpty && $0.year==nil && $0.abs==nil
            }
            // Nested closures use explicit IDs to avoid confusing a ride ID with a vehicle ID.
            let reusable=emptySeed.flatMap { seed in
                rides.contains(where:{$0.vehicleId==seed.id}) || maintenance.contains(where:{$0.vehicleId==seed.id}) ? nil:seed
            }
            let vehicle=reusable ?? Vehicle(name:remote.name,make:remote.make,model:remote.model)
            if reusable==nil {context.insert(vehicle)}
            let previousId=vehicle.id
            vehicle.id=remote.id;vehicle.name=remote.name;vehicle.make=remote.make;vehicle.model=remote.model
            vehicle.year=remote.year;vehicle.abs=remote.abs;vehicle.displacementCC=remote.displacementCC
            vehicle.plate=remote.plate;vehicle.tyres=remote.tyres;vehicle.modifications=remote.modifications;vehicle.odometerKM=remote.odometerKM
            if reusable != nil && settings.selectedVehicleID==previousId.uuidString {settings.selectedVehicleID=remote.id.uuidString;UserDefaults.standard.removeObject(forKey:"autoSeedVehicleID")}
        }
        try context.save()
    }
}
