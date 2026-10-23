// SteedPilot GATT UUIDs and newline framing derived from Dean Edis' MIT project.
// See docs/licenses/SteedPilot-LICENSE and docs/ACCESSORY_PROTOCOL.md.
import Foundation
@preconcurrency import CoreBluetooth
@preconcurrency import Network
import Observation

struct APIAccessoryDevice: Identifiable {
    let id: UUID
    var name: String
    var transport: String
    var rssi: Int?
}
@MainActor @Observable final class AccessoryService: NSObject {
    static let shared = AccessoryService()
    private(set) var state = "disconnected"
    private(set) var statusMessage = "连接兼容的 HUD 或传感器"
    private(set) var devices: [APIAccessoryDevice] = []
    private(set) var capabilities: [String] = []
    private(set) var lastMeasurement = "暂无配件实测数据"
    private(set) var connectedName = "未连接"
    /// Read-only observer for raw newline-delimited frames (roadlog); does not change protocol handling.
    @ObservationIgnored var onFrame: ((Data, String) -> Void)?
    @ObservationIgnored private var central: CBCentralManager?
    @ObservationIgnored private var peers: [UUID:CBPeripheral] = [:]
    @ObservationIgnored private var endpoints: [UUID:NWEndpoint] = [:]
    @ObservationIgnored private var browser: NWBrowser?
    @ObservationIgnored private var connection: NWConnection?
    @ObservationIgnored private var peripheral: CBPeripheral?
    @ObservationIgnored private var output: CBCharacteristic?
    @ObservationIgnored private var outgoing = Data()
    @ObservationIgnored private var offset = 0
    @ObservationIgnored private var pending: Data?
    @ObservationIgnored private var input = Data()
    @ObservationIgnored private var lastSequence: Int = -1
    @ObservationIgnored private var wantsScan = false
    @ObservationIgnored private var timeout: Task<Void,Never>?
    @ObservationIgnored private var heartbeat: Task<Void,Never>?
    @ObservationIgnored private var lastHUD: Date = .distantPast
    @ObservationIgnored private let serviceID = CBUUID(string:"c6372234-79d6-4a5e-8a57-08a3b7a8a7d1")
    @ObservationIgnored private let outputID = CBUUID(string:"f6c8d747-fc2c-4ef4-906a-7c8cbf552814")
    @ObservationIgnored private let statusID = CBUUID(string:"fa62492e-5c6f-4a8d-9853-1a996b0c7c5d")
    override init() { super.init() }
    func startScanning() {
        wantsScan = true; state = "scanning"; statusMessage = "搜索兼容蓝牙与同一 Wi-Fi 配件"
        if central == nil { central = CBCentralManager(delegate:self, queue:.main, options:[CBCentralManagerOptionRestoreIdentifierKey:"motuo.accessories"]) }
        if central?.state == .poweredOn { central?.scanForPeripherals(withServices:[serviceID],options:nil) }
        browser?.cancel()
        let browser = NWBrowser(for:.bonjour(type:"_motuo-hud._tcp",domain:nil),using:.tcp)
        browser.browseResultsChangedHandler = { [weak self] results, _ in Task { @MainActor in
            guard let self else { return }
            for result in results {
                guard !self.endpoints.values.contains(result.endpoint) else { continue }
                let id = UUID(); self.endpoints[id] = result.endpoint
                var name = "Wi-Fi HUD"
                if case let .service(serviceName,_,_,_) = result.endpoint { name = serviceName }
                self.devices.append(APIAccessoryDevice(id:id,name:name,transport:"Wi-Fi",rssi:nil))
            }
        } }
        browser.stateUpdateHandler = { [weak self] value in if case .failed = value { Task { @MainActor in self?.statusMessage = "Wi-Fi 搜索不可用，请检查本地网络权限；蓝牙搜索仍可用" } } }
        self.browser = browser; browser.start(queue:.main)
    }
    func stopScanning() { wantsScan = false; central?.stopScan(); browser?.cancel(); browser = nil; if state == "scanning" { state = "disconnected" } }
    func connect(_ id: UUID) {
        disconnect(); stopScanning()
        connectedName = devices.first(where:{$0.id == id})?.name ?? "配件"
        state = "connecting"; statusMessage = "正在验证配件服务"
        if let peer = peers[id] { peripheral = peer; peer.delegate = self; central?.connect(peer,options:nil) }
        else if let endpoint = endpoints[id] {
            let connection = NWConnection(to:endpoint,using:.tcp); self.connection = connection
            connection.stateUpdateHandler = { [weak self] value in Task { @MainActor in
                guard let self else { return }
                switch value {
                case .ready: self.ready(); self.receiveWiFi()
                case .failed: self.disconnect(); self.statusMessage = "Wi-Fi 连接失败"
                default: break
                }
            } }; connection.start(queue:.main)
        } else { state = "disconnected"; statusMessage = "设备已离线，请重新扫描" }
    }
    func disconnect() {
        if let peripheral { central?.cancelPeripheralConnection(peripheral) }
        connection?.cancel(); connection = nil; peripheral = nil; output = nil
        outgoing = Data(); input = Data(); pending = nil; offset = 0; lastSequence = -1
        heartbeat?.cancel(); heartbeat = nil; timeout?.cancel(); timeout = nil
        capabilities = []; state = "disconnected"; connectedName = "未连接"
    }
    /// Accept a fresh full HUD snapshot. Keep only the latest pending state under backpressure.
    func sendHUD(_ data: Data) {
        guard state == "ready", data.count <= 8192,
              let object = try? JSONSerialization.jsonObject(with:data) as? [String:Any],
              object["v"] as? Int == 1, ["state","update","heartbeat"].contains(object["type"] as? String ?? "") else { return }
        lastHUD = Date()
        if let connection {
            var frame = data; frame.append(10)
            connection.send(content:frame,completion:.contentProcessed { [weak self] error in
                if error != nil { Task { @MainActor in self?.disconnect(); self?.statusMessage = "Wi-Fi 数据发送中断" } }
            })
        } else {
            pending = data; if outgoing.isEmpty { beginNext() }
        }
    }
    private func beginNext() {
        guard let next = pending else { return }; pending = nil
        outgoing = next; outgoing.append(10); offset = 0; writeNext()
    }
    private func writeNext() {
        guard let peripheral, let output else { return }
        timeout?.cancel()
        if offset >= outgoing.count { outgoing = Data(); offset = 0; beginNext(); return }
        let length = max(1,min(128,peripheral.maximumWriteValueLength(for:.withResponse)))
        let end = min(offset+length,outgoing.count)
        peripheral.writeValue(outgoing.subdata(in:offset..<end),for:output,type:.withResponse); offset = end
        timeout = Task { [weak self] in
            try? await Task.sleep(for:.seconds(3)); guard !Task.isCancelled else { return }
            self?.disconnect(); self?.statusMessage = "配件未确认接收，请重新连接"
        }
    }
    private func ready() {
        state = "ready"; statusMessage = "已连接；传感器支持以实际协议为准"
        heartbeat?.cancel()
        heartbeat = Task { [weak self] in
            while !Task.isCancelled {
                try? await Task.sleep(for:.seconds(3)); guard !Task.isCancelled, let self else { return }
                // No stale state is replayed on reconnect; heartbeat carries no historic maneuver.
                if Date().timeIntervalSince(self.lastHUD) > 2 { self.sendHUD(Data("{\"v\":1,\"type\":\"heartbeat\"}".utf8)) }
            }
        }
    }
    private func receiveWiFi() {
        connection?.receive(minimumIncompleteLength:1,maximumLength:8192) { [weak self] data,_,complete,error in Task { @MainActor in
            guard let self else { return }
            if let data { self.ingest(data) }
            if complete || error != nil { self.disconnect(); self.statusMessage = "Wi-Fi 配件已断开" }
            else { self.receiveWiFi() }
        } }
    }
    private func ingest(_ data: Data) {
        input.append(data)
        guard input.count <= 16384 else { input = Data(); statusMessage = "已拒绝过大的配件数据包"; return }
        while let newline = input.firstIndex(of:10) {
            let frame = input.prefix(upTo:newline); input.removeSubrange(...newline)
            onFrame?(Data(frame), connection != nil ? "Wi-Fi" : "BLE")
            guard let object = try? JSONSerialization.jsonObject(with:frame) as? [String:Any], object["v"] as? Int == 1 else { continue }
            if object["type"] as? String == "capabilities" {
                let allowed = Set(["hud","tyrePressure","imu","rpm","gear"])
                capabilities = (object["capabilities"] as? [String] ?? []).filter{allowed.contains($0)}
            }
            if object["type"] as? String == "measurement", let sequence = object["sequence"] as? Int, sequence > lastSequence,
               let timestamp = object["timestamp"] as? Double, abs(Date().timeIntervalSince1970-timestamp) < 5,
               let metric = object["metric"] as? String, capabilities.contains(metric),
               let value = object["value"] as? Double, value.isFinite, let unit = object["unit"] as? String {
                let valid = (metric == "tyrePressure" && unit == "kPa" && (0...600).contains(value)) || (metric == "rpm" && unit == "rpm" && (0...20000).contains(value)) || (metric == "gear" && unit == "index" && (0...6).contains(value) && value.rounded() == value)
                guard valid else { continue }
                lastSequence = sequence; lastMeasurement = "\(metric) · \(value.formatted()) \(unit) · 配件实测"
                NotificationCenter.default.post(name:NSNotification.Name("MotuoAccessoryObservation"),object:nil,userInfo:object)
            }
        }
    }
}
extension AccessoryService: CBCentralManagerDelegate, CBPeripheralDelegate {
    func centralManagerDidUpdateState(_ central: CBCentralManager) {
        if central.state == .poweredOn && wantsScan { central.scanForPeripherals(withServices:[serviceID]) }
        else if central.state != .poweredOn { state = "unavailable"; statusMessage = central.state == .unauthorized ? "请在设置中允许蓝牙访问" : "蓝牙未开启或不可用" }
    }
    func centralManager(_ central: CBCentralManager, willRestoreState dict: [String:Any]) {
        // Restore references, then let the user intentionally reconnect; never auto-replay telemetry.
        for peer in dict[CBCentralManagerRestoredStatePeripheralsKey] as? [CBPeripheral] ?? [] { peers[peer.identifier] = peer; peer.delegate = self; if !devices.contains(where:{$0.id == peer.identifier}) { devices.append(APIAccessoryDevice(id:peer.identifier,name:peer.name ?? "HUD",transport:"BLE",rssi:nil)) } }
    }
    func centralManager(_ central: CBCentralManager,didDiscover peer:CBPeripheral,advertisementData:[String:Any],rssi RSSI:NSNumber) {
        peers[peer.identifier] = peer
        if let i = devices.firstIndex(where:{$0.id == peer.identifier}) { devices[i].rssi = RSSI.intValue }
        else { devices.append(APIAccessoryDevice(id:peer.identifier,name:peer.name ?? "SteedPilot HUD",transport:"BLE",rssi:RSSI.intValue)) }
    }
    func centralManager(_ central:CBCentralManager,didConnect peer:CBPeripheral) { peer.delegate = self; peer.discoverServices([serviceID]) }
    func centralManager(_ central:CBCentralManager,didFailToConnect peer:CBPeripheral,error:Error?) { disconnect(); statusMessage = "配件连接失败" }
    func centralManager(_ central:CBCentralManager,didDisconnectPeripheral peer:CBPeripheral,error:Error?) { if peripheral?.identifier == peer.identifier { disconnect(); statusMessage = "配件已断开，等待重新连接" } }
    func peripheral(_ peer:CBPeripheral,didDiscoverServices error:Error?) {
        guard error == nil, let service = peer.services?.first(where:{$0.uuid == serviceID}) else { disconnect(); statusMessage = "设备缺少兼容服务"; return }
        peer.discoverCharacteristics([outputID,statusID],for:service)
    }
    func peripheral(_ peer:CBPeripheral,didDiscoverCharacteristicsFor service:CBService,error:Error?) {
        guard error == nil, let characteristic = service.characteristics?.first(where:{$0.uuid == outputID && $0.properties.contains(.write)}) else { disconnect(); statusMessage = "配件缺少可确认写入通道"; return }
        output = characteristic
        if let status = service.characteristics?.first(where:{$0.uuid == statusID && $0.properties.contains(.notify)}) { peer.setNotifyValue(true,for:status) }
        ready()
    }
    func peripheral(_ peer:CBPeripheral,didWriteValueFor characteristic:CBCharacteristic,error:Error?) { if error != nil { disconnect(); statusMessage = "蓝牙写入失败" } else { writeNext() } }
    func peripheral(_ peer:CBPeripheral,didUpdateValueFor characteristic:CBCharacteristic,error:Error?) { if error == nil, let data = characteristic.value { ingest(data) } }
}
