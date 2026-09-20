import SwiftUI

enum Cyber {
    static let ink = Color(red: 0.025, green: 0.04, blue: 0.055)
    static let panel = Color(red: 0.055, green: 0.08, blue: 0.095)
    static let accent = Color(red: 0.46, green: 0.84, blue: 1.0)
    static let violet = Color(red: 0.64, green: 0.43, blue: 1.0)
    static let cyan = Color(red: 0.31, green: 0.87, blue: 0.94)
    static let orange = Color(red: 1, green: 0.58, blue: 0.30)
    static let muted = Color(red: 0.49, green: 0.59, blue: 0.61)
    static let stroke = Color.white.opacity(0.09)
    static func mono(_ size: CGFloat, weight: Font.Weight = .medium) -> Font { .system(size: size, weight: weight, design: .monospaced) }
}

struct Panel<Content: View>: View {
    var accent = Cyber.stroke
    @ViewBuilder var content: Content
    var body: some View {
        content.padding(18).background(Cyber.panel.opacity(0.92), in: RoundedRectangle(cornerRadius: 22))
            .overlay { RoundedRectangle(cornerRadius: 22).stroke(accent, lineWidth: 1) }
    }
}
struct Eyebrow: View {
    var text: String; var color = Cyber.muted
    var body: some View { Text(text).font(Cyber.mono(10, weight: .semibold)).tracking(2.5).foregroundStyle(color) }
}
struct StatusPill: View {
    var text: String; var color = Cyber.accent; var symbol: String? = nil
    var body: some View {
        HStack(spacing: 5) {
            if let symbol { Image(systemName: symbol).font(.system(size: 10, weight: .semibold)) }
            else { Circle().fill(color).frame(width: 5, height: 5) }
            Text(text).font(.system(size: 10, weight: .semibold))
        }.foregroundStyle(color).padding(.horizontal, 9).padding(.vertical, 6)
            .background(color.opacity(0.09), in: Capsule()).overlay { Capsule().stroke(color.opacity(0.2)) }
    }
}
struct ActionButton: View {
    var title: String; var symbol: String; var primary = true; var action: () -> Void
    var body: some View {
        Button(action: action) {
            HStack(spacing: 9) { Image(systemName: symbol); Text(title).fontWeight(.bold) }
                .font(.system(size: 15)).frame(maxWidth: .infinity).frame(height: 52)
                .foregroundStyle(primary ? Cyber.ink : .white)
                .background(primary ? Cyber.accent : Color.white.opacity(0.07), in: RoundedRectangle(cornerRadius: 16))
                .overlay { RoundedRectangle(cornerRadius: 16).stroke(primary ? Cyber.accent : Cyber.stroke) }
        }.buttonStyle(.plain)
    }
}
struct Metric: View {
    var title: String; var value: String; var unit: String; var accent = Color.white
    var body: some View {
        VStack(alignment: .leading, spacing: 7) {
            Eyebrow(text: title)
            HStack(alignment: .firstTextBaseline, spacing: 4) {
                Text(value).font(Cyber.mono(28, weight: .semibold)).foregroundStyle(accent).monospacedDigit()
                Text(unit).font(Cyber.mono(10)).foregroundStyle(Cyber.muted)
            }
        }.frame(maxWidth: .infinity, alignment: .leading)
    }
}
struct PageTitle: View {
    var eyebrow: String; var title: String; var subtitle: String
    var body: some View {
        VStack(alignment: .leading, spacing: 8) {
            Eyebrow(text: eyebrow, color: Cyber.accent)
            Text(title).font(.system(size: 32, weight: .bold))
            Text(subtitle).font(.system(size: 13)).foregroundStyle(Cyber.muted)
        }.frame(maxWidth: .infinity, alignment: .leading)
    }
}
struct EmptyState: View {
    var symbol: String; var title: String; var detail: String
    var body: some View {
        VStack(spacing: 14) {
            Image(systemName: symbol).font(.system(size: 35, weight: .ultraLight)).foregroundStyle(Cyber.accent)
                .frame(width: 86, height: 86).background(Cyber.accent.opacity(0.06), in: Circle())
            Text(title).font(.system(size: 20, weight: .semibold))
            Text(detail).font(.system(size: 13)).foregroundStyle(Cyber.muted).multilineTextAlignment(.center).lineSpacing(5)
        }.frame(maxWidth: .infinity).padding(.vertical, 42).padding(.horizontal, 24)
    }
}

struct MotorcycleArtwork: View {
    var body: some View {
        GeometryReader { geo in
            let w = geo.size.width; let h = geo.size.height
            Canvas { context, size in
                let rear = CGPoint(x: w * 0.25, y: h * 0.72), front = CGPoint(x: w * 0.78, y: h * 0.72)
                let r = h * 0.19
                for center in [rear, front] {
                    context.stroke(Path(ellipseIn: CGRect(x: center.x-r, y: center.y-r, width: 2*r, height: 2*r)), with: .color(.white.opacity(0.8)), lineWidth: 3)
                    context.stroke(Path(ellipseIn: CGRect(x: center.x-r*0.73, y: center.y-r*0.73, width: r*1.46, height: r*1.46)), with: .color(Cyber.muted.opacity(0.5)), lineWidth: 1)
                    for i in 0..<6 {
                        let angle = Double(i) * .pi / 3
                        var spoke = Path(); spoke.move(to: center)
                        spoke.addLine(to: CGPoint(x: center.x + cos(angle) * r * 0.7, y: center.y + sin(angle) * r * 0.7))
                        context.stroke(spoke, with: .color(Cyber.muted.opacity(0.5)), lineWidth: 1)
                    }
                }
                var shell = Path()
                shell.move(to: CGPoint(x:w*0.18,y:h*0.40)); shell.addLines([
                    CGPoint(x:w*0.34,y:h*0.42), CGPoint(x:w*0.43,y:h*0.31), CGPoint(x:w*0.58,y:h*0.28),
                    CGPoint(x:w*0.66,y:h*0.38), CGPoint(x:w*0.75,y:h*0.34), CGPoint(x:w*0.83,y:h*0.48),
                    CGPoint(x:w*0.73,y:h*0.55), CGPoint(x:w*0.63,y:h*0.77), CGPoint(x:w*0.44,y:h*0.75),
                    CGPoint(x:w*0.37,y:h*0.55), CGPoint(x:w*0.23,y:h*0.51), CGPoint(x:w*0.18,y:h*0.40)])
                shell.closeSubpath()
                context.fill(shell, with: .linearGradient(Gradient(colors: [Cyber.accent.opacity(0.25), Cyber.cyan.opacity(0.06)]), startPoint: CGPoint(x:0,y:0), endPoint: CGPoint(x:w,y:h)))
                context.stroke(shell, with: .color(Cyber.accent.opacity(0.85)), lineWidth: 1.5)
                var chassis = Path(); chassis.move(to: rear); chassis.addLines([CGPoint(x:w*0.48,y:h*0.64), CGPoint(x:w*0.63,y:h*0.45), front])
                context.stroke(chassis, with: .color(Cyber.cyan.opacity(0.7)), lineWidth: 2)
                var screen = Path(); screen.move(to: CGPoint(x:w*0.68,y:h*0.36)); screen.addLines([CGPoint(x:w*0.68,y:h*0.18),CGPoint(x:w*0.75,y:h*0.34)])
                context.stroke(screen, with: .color(Cyber.cyan), lineWidth: 1.5)
                var ground = Path(); ground.move(to: CGPoint(x: w*0.08,y:h*0.94)); ground.addLine(to: CGPoint(x:w*0.92,y:h*0.94))
                context.stroke(ground, with: .color(Cyber.accent.opacity(0.2)), style: StrokeStyle(lineWidth: 1,dash:[4,6]))
            }
            Text("GSX / 250R").font(Cyber.mono(10,weight:.bold)).tracking(2).foregroundStyle(Cyber.accent)
                .position(x:w*0.52,y:h*0.48)
        }.accessibilityLabel("GSX250R 摩托车线稿")
    }
}
