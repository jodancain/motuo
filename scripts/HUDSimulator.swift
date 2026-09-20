#!/usr/bin/swift
import Foundation
import Network

// Same-network fixture receiver; never represents real vehicle measurements.
final class HUDPeer {
    let connection:NWConnection
    var buffer=Data()
    var freshAt=Date.distantPast
    var sequence=0
    var timer:DispatchSourceTimer?
    init(_ connection:NWConnection) { self.connection=connection }
    func start() {
        connection.stateUpdateHandler = { [weak self] state in
            guard let self else{return}
            if case .ready=state {
                print("HUD fixture connected; simulated sensor values only")
                self.send(["v":1,"type":"capabilities","capabilities":["hud"]])
                self.read()
                let timer=DispatchSource.makeTimerSource(queue:.main)
                timer.schedule(deadline:.now()+1,repeating:1)
                timer.setEventHandler { [weak self] in
                    guard let self else{return}
                    if Date().timeIntervalSince(self.freshAt)>10 {print("HUD · DATA EXPIRED · speed — · navigation —")}
                }; self.timer=timer; timer.resume()
            }
            if case .failed=state {self.timer?.cancel()}
            if case .cancelled=state {self.timer?.cancel()}
        }
        connection.start(queue:.main)
    }
    func read() {
        connection.receive(minimumIncompleteLength:1,maximumLength:8192){[weak self] data,_,complete,error in
            guard let self else{return}
            if let data {self.buffer.append(data)}
            guard self.buffer.count<=16384 else {self.connection.cancel();return}
            while let index=self.buffer.firstIndex(of:10) {
                let line=self.buffer.prefix(upTo:index); self.buffer.removeSubrange(...index)
                guard let object=try? JSONSerialization.jsonObject(with:line) as? [String:Any],object["v"] as? Int==1 else{continue}
                if ["state","update"].contains(object["type"] as? String ?? "") {
                    self.freshAt=Date(); print(String(data:line,encoding:.utf8) ?? "invalid UTF8")
                }
            }
            if !complete && error==nil {self.read()} else {self.timer?.cancel();self.connection.cancel()}
        }
    }
    func send(_ object:[String:Any]) {
        guard var data=try? JSONSerialization.data(withJSONObject:object) else{return}
        data.append(10); connection.send(content:data,completion:.contentProcessed{_ in})
    }
}
let listener=try NWListener(using:.tcp,on:49251)
listener.service=NWListener.Service(name:"Motuo HUD Simulator",type:"_motuo-hud._tcp")
var peers:[HUDPeer]=[]
listener.newConnectionHandler={connection in let peer=HUDPeer(connection);peers.append(peer);peer.start()}
listener.stateUpdateHandler={state in print("Motuo simulator: \(state)")}
listener.start(queue:.main)
print("Select Motuo HUD Simulator in the iPhone accessories page. Port 49251; Ctrl-C stops it.")
dispatchMain()
