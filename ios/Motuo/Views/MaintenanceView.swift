import SwiftUI
import SwiftData

struct MaintenanceView:View {
    var vehicle:Vehicle
    @Environment(\.dismiss) private var dismiss
    @Environment(\.modelContext) private var context
    @Query(sort:\MaintenanceEntry.performedAt,order:.reverse) private var allEntries:[MaintenanceEntry]
    @State private var adding=false
    @State private var performedAt=Date()
    @State private var odometer=""
    @State private var category="日常检查"
    @State private var note=""
    @State private var status="保养记录先存本地，配对后可同步私人 NAS。"
    var entries:[MaintenanceEntry] { allEntries.filter{$0.vehicleId==vehicle.id} }
    var body:some View {
        NavigationStack {
            ScrollView {
                VStack(alignment:.leading,spacing:22) {
                    PageTitle(eyebrow:"MACHINE TIMELINE",title:"照顾好你的机器",subtitle:vehicle.name + " · 实际保养与检查记录")
                    ActionButton(title:"记一次保养 / 检查",symbol:"plus") { odometer=String(format:"%.0f",vehicle.odometerKM);adding=true }
                    Text(status).font(.system(size:11)).foregroundStyle(Cyber.muted).lineSpacing(4)
                    if entries.isEmpty { EmptyState(symbol:"wrench.and.screwdriver",title:"从一次检查开始",detail:"写下已经做过的检查、维护或更换。\n不会自动推断车辆已经完成保养。") }
                    ForEach(entries) { entry in Panel { VStack(alignment:.leading,spacing:12) { HStack { Text(entry.category).font(.system(size:17,weight:.semibold));Spacer();StatusPill(text:entry.syncStatus=="synced" ? "已同步":"本地记录",color:Cyber.cyan) };Text(entry.performedAt.formatted(.dateTime.year().month().day())+" · "+String(format:"%.0f km",entry.odometerKM)).font(Cyber.mono(11)).foregroundStyle(Cyber.muted);Text(entry.note).font(.system(size:13)).lineSpacing(5) } } }
                    if APIClient.shared.isPaired && !entries.isEmpty { Button("同步未上传的保养记录") { Task{await syncPending()} }.font(.system(size:13)) }
                }.padding(24).frame(maxWidth:800)
            }.background(Cyber.ink).navigationTitle("保养记录").navigationBarTitleDisplayMode(.inline).toolbar { ToolbarItem(placement:.topBarTrailing) { Button("完成"){dismiss()} } }
        }.sheet(isPresented:$adding) {
            NavigationStack { Form {
                Section("实际完成的事项") { DatePicker("日期",selection:$performedAt,in:...Date(),displayedComponents:.date);TextField("里程 km",text:$odometer).keyboardType(.decimalPad);Picker("类型",selection:$category) { ForEach(["日常检查","机油 / 滤芯","链条维护","制动系统","轮胎","故障检修","其他"],id:\.self){Text($0)} };TextField("实际检查、处理结果与更换部件",text:$note,axis:.vertical).lineLimit(4...8) }
                Section { Text("不确定的结果请直接写明待核对。记录不会改写原始维修手册。").font(.footnote).foregroundStyle(Cyber.muted) }
            }.navigationTitle("添加记录").toolbar { ToolbarItem(placement:.cancellationAction){Button("取消"){adding=false}};ToolbarItem(placement:.confirmationAction){Button("保存"){save()}.disabled(note.trimmingCharacters(in:.whitespacesAndNewlines).isEmpty || Double(odometer)==nil)} } }
        }
    }
    private func save() {
        guard let km=Double(odometer),km.isFinite,km>=0 else {return}
        let entry=MaintenanceEntry(vehicleId:vehicle.id,performedAt:performedAt,odometerKM:km,category:category,note:note)
        context.insert(entry);vehicle.odometerKM=max(vehicle.odometerKM,km)
        do {try context.save();adding=false;note="";Task{await syncPending()}}catch{status=error.localizedDescription}
    }
    private func syncPending() async {
        guard APIClient.shared.isPaired else{return}
        do {
            let _:EmptyAPIResponse=try await APIClient.shared.request("/v1/vehicles/\(vehicle.id.uuidString)",method:"PUT",body:try APIClient.encoder.encode(vehicle.payload))
            for entry in entries where entry.syncStatus != "synced" {
                let _:EmptyAPIResponse=try await APIClient.shared.request("/v1/maintenance",method:"POST",body:try APIClient.encoder.encode(entry.payload));entry.syncStatus="synced"
            }
            try context.save();status="保养记录已同步私人 NAS。"
        }catch{status="记录仍保存在本机，同步可重试：\(error.localizedDescription)"}
    }
}
