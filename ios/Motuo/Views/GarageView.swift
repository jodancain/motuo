import SwiftUI
import SwiftData

struct GarageView: View {
    @Environment(\.modelContext) private var context
    @Environment(AppSettings.self) private var settings
    @Query(sort: \Vehicle.createdAt) private var vehicles:[Vehicle]
    @State private var editingVehicle:Vehicle?
    @State private var createVehicle = false
    @State private var manualVehicle:Vehicle?
    @State private var maintenanceVehicle:Vehicle?
    @State private var learningVehicle:Vehicle?
    var body: some View {
        NavigationStack {
            ScrollView {
                VStack(alignment:.leading,spacing:24) {
                    HStack { PageTitle(eyebrow:"THE GARAGE",title:"认识你的机器",subtitle:"车辆档案、手册证据与保养记忆。")
                        Button { createVehicle = true } label: { Image(systemName:"plus").font(.system(size:20)).frame(width:44,height:44).background(Cyber.accent.opacity(0.1),in:Circle()) }
                    }
                    ForEach(vehicles) { vehicle in
                        VStack(alignment:.leading,spacing:18) {
                            HStack { VStack(alignment:.leading,spacing:6) { Eyebrow(text:vehicle.make.uppercased(),color:Cyber.accent); Text(vehicle.model).font(.system(size:34,weight:.heavy,design:.rounded)).italic() }; Spacer(); StatusPill(text:settings.selectedVehicleID == vehicle.id.uuidString ? "当前座驾" : "车库档案") }
                            MotorcycleArtwork().frame(height:180)
                            HStack {
                                Metric(title:"ENGINE",value:"\(vehicle.displacementCC)",unit:"cc")
                                Metric(title:"ODOMETER",value:String(format:"%.0f",vehicle.odometerKM),unit:"km")
                                VStack(alignment:.leading,spacing:8) { Eyebrow(text:"CONFIG"); Text(vehicle.abs.map { $0 ? "ABS" : "无 ABS" } ?? "待核对").font(Cyber.mono(19)) }.frame(maxWidth:.infinity,alignment:.leading)
                            }
                            Divider().overlay(Cyber.stroke)
                            Button { learningVehicle = vehicle } label: { Label("车辆学习与版本", systemImage:"waveform.path.ecg").frame(maxWidth:.infinity, alignment:.leading) }.accessibilityIdentifier("garage.learning")
                            HStack { Text(vehicle.name).font(.system(size:15,weight:.semibold)); Spacer(); Button("编辑档案") { editingVehicle = vehicle }.font(.system(size:12)) }
                            HStack(spacing:10) {
                                ActionButton(title:"维修手册",symbol:"book.closed",primary:false) { manualVehicle = vehicle }
                                ActionButton(title:"保养记录",symbol:"wrench.and.screwdriver",primary:false) { maintenanceVehicle = vehicle }
                                if settings.selectedVehicleID != vehicle.id.uuidString { ActionButton(title:"设为座驾",symbol:"checkmark") { settings.selectedVehicleID = vehicle.id.uuidString } }
                            }
                        }.padding(22).background(LinearGradient(colors:[Cyber.panel,Cyber.panel.opacity(0.4)],startPoint:.topLeading,endPoint:.bottomTrailing),in:RoundedRectangle(cornerRadius:28))
                            .overlay { RoundedRectangle(cornerRadius:28).stroke(Cyber.accent.opacity(0.18)) }
                    }
                    Panel { HStack(alignment:.top,spacing:12) { Image(systemName:"point.3.connected.trianglepath.dotted").foregroundStyle(Cyber.cyan); VStack(alignment:.leading,spacing:8) { Text("车辆理解，从证据开始").font(.system(size:15,weight:.semibold)); Text("手册描述车型；你的里程、保养与确认片段描述这辆车。手机动态不会被当作故障结论。").font(.system(size:12)).foregroundStyle(Cyber.muted).lineSpacing(5) } } }
                }.padding(24).frame(maxWidth:850)
            }.background(Cyber.ink).toolbar(.hidden,for:.navigationBar)
        }
        .sheet(item:$editingVehicle) { VehicleEditor(vehicle:$0) }
        .sheet(isPresented:$createVehicle) { VehicleEditor(vehicle:nil) }
        .sheet(item:$manualVehicle) { ManualAssistantView(vehicle:$0) }
        .sheet(item:$maintenanceVehicle) { MaintenanceView(vehicle:$0) }
        .sheet(item:$learningVehicle) { VehicleLearningView(vehicle:$0) }
    }
}

struct VehicleEditor: View {
    var vehicle:Vehicle?
    @Environment(\.modelContext) private var context
    @Environment(\.dismiss) private var dismiss
    @Environment(AppSettings.self) private var settings
    @State private var name = "我的 GSX250R"
    @State private var make = "SUZUKI"
    @State private var model = "GSX250R"
    @State private var year = ""
    @State private var absIndex = 0
    @State private var displacement = "248"
    @State private var odometer = "0"
    @State private var plate = ""
    @State private var tyres = ""
    @State private var modifications = ""
    @State private var error:String?
    var body:some View {
        NavigationStack {
            Form {
                Section("车辆身份") { TextField("车辆昵称",text:$name); TextField("品牌",text:$make); TextField("型号",text:$model); TextField("年份（待核对可留空）",text:$year).keyboardType(.numberPad); TextField("车牌（可选）",text:$plate) }
                Section("实际配置") { TextField("排量 cc",text:$displacement).keyboardType(.numberPad); TextField("当前里程 km",text:$odometer).keyboardType(.decimalPad); Picker("ABS",selection:$absIndex) { Text("待核对").tag(0); Text("有 ABS").tag(1); Text("无 ABS").tag(2) }; TextField("轮胎规格 / 使用情况",text:$tyres,axis:.vertical); TextField("改装记录",text:$modifications,axis:.vertical) }
                Section { Text("维修参数需要匹配年份与 ABS 配置；不确定的信息保留待核对。").font(.footnote).foregroundStyle(Cyber.muted) }
                if let error { Section { Text(error).foregroundStyle(Cyber.orange) } }
            }.scrollContentBackground(.hidden).background(Cyber.ink).navigationTitle(vehicle == nil ? "新建车辆" : "车辆档案")
                .toolbar { ToolbarItem(placement:.cancellationAction) { Button("取消") { dismiss() } }; ToolbarItem(placement:.confirmationAction) { Button("保存",action:save) } }
        }.onAppear {
            guard let v = vehicle else { return }; name=v.name; make=v.make; model=v.model; year=v.year.map(String.init) ?? ""
            absIndex=v.abs.map { $0 ? 1 : 2 } ?? 0; displacement=String(v.displacementCC); odometer=String(format:"%.0f",v.odometerKM); plate=v.plate; tyres=v.tyres; modifications=v.modifications
        }
    }
    private func save() {
        guard !name.trimmingCharacters(in:.whitespacesAndNewlines).isEmpty,!model.isEmpty,
              let cc=Int(displacement),(1...3000).contains(cc),let km=Double(odometer),km.isFinite,km>=0 else { error="请填写车辆名称、型号、有效排量与里程。"; return }
        let parsedYear=Int(year)
        if !year.isEmpty && (parsedYear == nil || !(1980...2100).contains(parsedYear!)) { error="请核对车辆年份。"; return }
        let v=vehicle ?? Vehicle(name:name,make:make,model:model)
        if vehicle == nil { context.insert(v) }
        v.name=name;v.make=make;v.model=model;v.year=parsedYear;v.abs=absIndex==0 ? nil : absIndex==1
        v.displacementCC=cc;v.odometerKM=km;v.plate=plate;v.tyres=tyres;v.modifications=modifications
        do { try context.save(); if settings.selectedVehicleID.isEmpty { settings.selectedVehicleID=v.id.uuidString };dismiss() } catch { self.error=error.localizedDescription }
    }
}
