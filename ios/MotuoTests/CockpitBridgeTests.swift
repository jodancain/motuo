import XCTest
@testable import Motuo

final class CockpitBridgeTests:XCTestCase {
    func testVelocityBridgeRequiresAnchorCalibrationAndContinuity(){
        var bridge=InertialVelocityBridge()
        bridge.motion(acceleration:1,time:0);XCTAssertNil(bridge.estimate(at:0))
        bridge.gps(speed:10,accuracy:0.5,time:0)
        bridge.motion(acceleration:1,time:0.1)
        XCTAssertEqual(bridge.estimate(at:0.1)?.speed ?? 0,10.1,accuracy:0.0001)
        bridge.motion(acceleration:nil,time:0.2);XCTAssertNil(bridge.estimate(at:0.2))
        bridge.gps(speed:12,accuracy:0.5,time:1)
        bridge.motion(acceleration:0,time:1);bridge.motion(acceleration:0,time:1.1)
        XCTAssertNotNil(bridge.estimate(at:1.1));XCTAssertNil(bridge.estimate(at:2))
        bridge.motion(acceleration:0,time:2);XCTAssertNil(bridge.estimate(at:2))
    }
    func testVelocityBridgeExpiresAndNeverInventsDistance(){
        var bridge=InertialVelocityBridge();bridge.motion(acceleration:0,time:0);bridge.gps(speed:20,accuracy:0.5,time:0)
        for i in 1...149{bridge.motion(acceleration:0,time:Double(i)/10)}
        XCTAssertEqual(bridge.estimate(at:14.9)?.speed,20)
        bridge.motion(acceleration:0,time:15.1);XCTAssertNil(bridge.estimate(at:15.1))
        bridge.reset();XCTAssertNil(bridge.estimate(at:15.2))
    }
    func testSoundFeaturesSilenceToneAndInvalidInput(){
        let silence=SoundFeatures.analyze(Array(repeating:0,count:1024),sampleRate:48000)
        XCTAssertEqual(silence.level,0);XCTAssertEqual(silence.wave.count,64);XCTAssertEqual(silence.spectrum.count,32)
        let tone=(0..<1024).map{Float(0.2*sin(2*Double.pi*500*Double($0)/48000))}
        let f=SoundFeatures.analyze(tone,sampleRate:48000)
        XCTAssertGreaterThan(f.level,0);XCTAssertFalse(f.clipped);XCTAssertTrue(f.spectrum.allSatisfy{$0.isFinite && (0...1).contains($0)})
        XCTAssertGreaterThan(f.spectrum.max() ?? 0,0.1)
        XCTAssertEqual(SoundFeatures.analyze([.nan],sampleRate:48000).level,0)
    }
    @MainActor func testBridgeAcceptsRecapHandoffActions(){
        // The cockpit recap must be able to confirm itself and hand over to the native detail.
        for action in ["wrappedShown","rideDetail","wrappedDone","finish","primary"]{XCTAssertTrue(CockpitWebView.Coordinator.commands.contains(action),action)}
        XCTAssertFalse(CockpitWebView.Coordinator.commands.contains("eval"))
    }
    func testAssetHandlerConfinesLocalResourcePaths(){
        let root=URL(fileURLWithPath:"/tmp/motuo-cockpit")
        XCTAssertEqual(CockpitAssetHandler.resource(URL(string:"motuo://bundle/vendor/three/three.module.js?v=2")!,root:root)?.lastPathComponent,"three.module.js")
        XCTAssertNil(CockpitAssetHandler.resource(URL(string:"motuo://bundle/../../credentials.env")!,root:root))
        XCTAssertNil(CockpitAssetHandler.resource(URL(string:"https://example.com/index.html")!,root:root))
        XCTAssertNil(CockpitAssetHandler.resource(URL(string:"motuo://other/index.html")!,root:root))
        XCTAssertNil(CockpitAssetHandler.resource(URL(string:"motuo://bundle/user.pdf")!,root:root))
    }
}
