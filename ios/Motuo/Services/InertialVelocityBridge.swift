import Foundation

/// A short presentation estimate. Never feeds distance, recorded GPS, gear, or learning truth.
struct InertialVelocityBridge {
    private(set) var speedMPS:Double?
    private(set) var uncertaintyMPS=0.0
    private var anchorTime:Double?
    private var lastMotionTime:Double?
    private var previousAcceleration:Double?
    private var initialVariance=0.0
    private var noiseVariance=0.0
    private var invalid=true
    mutating func reset(){self=Self()}
    mutating func gps(speed:Double,accuracy:Double,time:Double){
        guard speed.isFinite,(0...100).contains(speed),accuracy.isFinite,accuracy>=0,time.isFinite else{return}
        speedMPS=speed;anchorTime=time;initialVariance=accuracy*accuracy;noiseVariance=0;uncertaintyMPS=accuracy;invalid=false
        if let lastMotionTime,time-lastMotionTime>0.5{previousAcceleration=nil}
    }
    mutating func motion(acceleration:Double?,time:Double){
        defer{lastMotionTime=time;previousAcceleration=acceleration}
        guard time.isFinite,let acceleration,acceleration.isFinite,abs(acceleration)<=30 else{invalid=true;speedMPS=nil;return}
        guard !invalid,let anchorTime,let lastMotionTime,let previousAcceleration,let speedMPS else{return}
        let dt=time-lastMotionTime,age=time-anchorTime
        guard dt>0,dt<=0.5,age>=0,age<=15 else{invalid=true;self.speedMPS=nil;return}
        noiseVariance += pow(0.25*dt,2)
        uncertaintyMPS=sqrt(initialVariance+noiseVariance+pow(0.4*age,2))
        let value=speedMPS+(acceleration+previousAcceleration)*0.5*dt
        guard value.isFinite,value<=100,uncertaintyMPS*3.6<=25 else{invalid=true;self.speedMPS=nil;return}
        self.speedMPS=max(0,value)
    }
    func anchorAge(at time:Double)->Double?{anchorTime.map{time-$0}}
    func estimate(at time:Double)->(speed:Double,uncertainty:Double)?{
        guard !invalid,let speedMPS,let anchorTime,let lastMotionTime,time.isFinite,
              time>=lastMotionTime,time-lastMotionTime<=0.5,time-anchorTime<=15 else{return nil}
        return (speedMPS,uncertaintyMPS)
    }
}
