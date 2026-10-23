import Foundation
import AVFoundation
import Observation
import UIKit

struct SoundFeatures: Sendable {
    var level:Double,db:Double,clipped:Bool,spectrum:[Double],wave:[Double]
    /// Coarse logarithmic spectrum via Goertzel; no RPM or engine classification.
    static func analyze(_ samples:[Float],sampleRate:Double)->SoundFeatures {
        guard !samples.isEmpty,sampleRate.isFinite,sampleRate>0,samples.allSatisfy({$0.isFinite}) else{return .init(level:0,db:-120,clipped:false,spectrum:Array(repeating:0,count:32),wave:Array(repeating:0,count:64))}
        let n=samples.count,energy=samples.reduce(0.0){$0+Double($1*$1)}/Double(samples.count)
        let db=max(-120,20*log10(max(sqrt(energy),0.000001)))
        let spectrum=(0..<32).map{index -> Double in
            let frequency=80*pow(min(8000,sampleRate*0.45)/80,Double(index)/31)
            let coefficient=2*cos(2*Double.pi*frequency/sampleRate)
            var a=0.0,b=0.0
            for (i,x) in samples.enumerated(){let window=0.5-0.5*cos(2*Double.pi*Double(i)/Double(max(1,n-1)));let next=Double(x)*window+coefficient*a-b;b=a;a=next}
            return min(1,max(0,sqrt(max(0,a*a+b*b-coefficient*a*b))/Double(n)*16))
        }
        return .init(level:max(0,min(1,(db+60)/50)),db:db,clipped:samples.contains{abs($0)>0.98},spectrum:spectrum,wave:(0..<64).map{Double(samples[min(n-1,$0*n/64)])})
    }
    /// 121 low-frequency PSD values (dBFS/Hz, 20–500 Hz every 4 Hz) → 24 display bands 0…1 (−110…−40 dB/Hz).
    static func lowBands(_ frame:LowFrequencySpectrum.Frame)->[Double]{
        (0..<24).map{i in let slice=frame.db[(i*5)..<min(frame.db.count,i*5+5)];let mean=slice.reduce(0,+)/Double(max(1,slice.count));return ((max(0,min(1,(mean+110)/70)))*1000).rounded()/1000}
    }
}

@MainActor @Observable final class EngineSoundService {
    static let shared=EngineSoundService()
    private(set) var status="麦克风关闭"
    private(set) var live=false
    private(set) var features:SoundFeatures?
    private(set) var sampleUptime=0.0
    /// 24 low-frequency bands (20–500 Hz, 0…1) for the cockpit's "声浪" ripple, ≈4 per second. Not RPM.
    private(set) var lowBands:[Double]?
    var isCapturing:Bool { engine != nil }
    private var engine:AVAudioEngine?
    private var revision=UUID()
    private var observers:[NSObjectProtocol]=[]
    init(){
        for name in [AVAudioSession.interruptionNotification,AVAudioSession.routeChangeNotification,UIApplication.didEnterBackgroundNotification]{
            observers.append(NotificationCenter.default.addObserver(forName:name,object:nil,queue:.main){notification in
                if notification.name == AVAudioSession.routeChangeNotification {
                    let reason=notification.userInfo?[AVAudioSessionRouteChangeReasonKey] as? UInt
                    guard reason == AVAudioSession.RouteChangeReason.oldDeviceUnavailable.rawValue || reason == AVAudioSession.RouteChangeReason.newDeviceAvailable.rawValue else{return}
                }
                if notification.name == AVAudioSession.interruptionNotification,
                   notification.userInfo?[AVAudioSessionInterruptionTypeKey] as? UInt != AVAudioSession.InterruptionType.began.rawValue {return}
                Task{@MainActor in
                if EngineSoundService.shared.engine != nil {EngineSoundService.shared.stop("输入已中断 · 点击重新开启")}
            }})
        }
    }
    func start() async {
        stop();let current=UUID();revision=current;status="等待麦克风授权"
        let granted=await AVAudioApplication.requestRecordPermission()
        guard revision==current else{return}
        guard granted,UIApplication.shared.applicationState == .active else{status=granted ? "后台已停止":"麦克风未授权";return}
        do{
            let session=AVAudioSession.sharedInstance()
            try session.setCategory(.playAndRecord,mode:.default,options:[.mixWithOthers,.defaultToSpeaker,.allowBluetoothA2DP])
            // Prefer the handset microphone for the vehicle; do not silently use a headset mic.
            if let builtIn=session.availableInputs?.first(where:{$0.portType == .builtInMic}){try session.setPreferredInput(builtIn)}
            try session.setActive(true)
            let audio=AVAudioEngine(),input=audio.inputNode,format=audio.inputNode.outputFormat(forBus:0)
            guard format.sampleRate>0,format.channelCount>0 else{throw NSError(domain:"MotuoAudio",code:1,userInfo:[NSLocalizedDescriptionKey:"手机麦克风暂不可用"])}
            let low=LowFrequencySpectrum()
            input.installTap(onBus:0,bufferSize:1024,format:format){[weak self] buffer,_ in
                guard let values=buffer.floatChannelData?[0] else{return}
                RoadlogAudioTap.shared.deliver(buffer,uptime:ProcessInfo.processInfo.systemUptime)
                let all=Array(UnsafeBufferPointer(start:values,count:Int(buffer.frameLength)))
                let samples=Array(all.prefix(2048))
                let features=SoundFeatures.analyze(samples,sampleRate:buffer.format.sampleRate),time=ProcessInfo.processInfo.systemUptime
                let bands=low.push(all,sampleRate:buffer.format.sampleRate,endUptime:time).last.map(SoundFeatures.lowBands)
                Task{@MainActor in guard let self,self.revision==current else{return};self.features=features;if let bands{self.lowBands=bands};self.sampleUptime=time;self.live=true;self.status="正在聆听 · 手机麦克风"}
            }
            engine=audio;audio.prepare();try audio.start();status="正在聆听 · 手机麦克风"
        }catch{stop("声音输入不可用：\(error.localizedDescription)")}
    }
    func stop(_ message:String="麦克风关闭"){
        revision=UUID();let wasRunning=engine != nil
        engine?.inputNode.removeTap(onBus:0);engine?.stop();engine=nil;if wasRunning{RoadlogAudioTap.shared.inputStopped()};live=false;features=nil;lowBands=nil;sampleUptime=0;status=message
        if wasRunning {try? AVAudioSession.sharedInstance().setCategory(.playback,mode:.default,options:[])}
    }
}
