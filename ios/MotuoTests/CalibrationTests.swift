import XCTest
import simd
@testable import Motuo

final class CalibrationTests: XCTestCase {
    private func readings(gravity: SIMD3<Double> = SIMD3(0,0,-1), rotation: SIMD3<Double> = .zero) -> [CalibrationReading] {
        (0..<100).map { CalibrationReading(timestamp:Double($0)*0.02,gravity:gravity,acceleration:SIMD3(0.01,0,0),rotation:rotation) }
    }
    func testUprightMountProducesOrthonormalVehicleAxes() throws {
        let result = try CalibrationMath.basis(readings:readings(),forwardHint:SIMD3(0,1,0))
        XCTAssertEqual(result.0.z,1,accuracy:0.00001)
        XCTAssertEqual(result.1.y,1,accuracy:0.00001)
        XCTAssertEqual(result.2.x,1,accuracy:0.00001)
        XCTAssertEqual(simd_dot(result.0,result.1),0,accuracy:0.00001)
    }
    func testMovementAndAmbiguousForwardDirectionCannotCreateCalibration() {
        XCTAssertThrowsError(try CalibrationMath.basis(readings:readings(rotation:SIMD3(0.3,0,0)),forwardHint:SIMD3(0,1,0)))
        XCTAssertThrowsError(try CalibrationMath.basis(readings:readings(gravity:SIMD3(0,-1,0)),forwardHint:SIMD3(0,1,0)))
        XCTAssertThrowsError(try CalibrationMath.basis(readings:Array(readings().prefix(30)),forwardHint:SIMD3(0,1,0)))
    }
}
