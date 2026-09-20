# Motuo

Native iOS 18+/watchOS 11+ motorcycle app; SwiftUI cyber HUD, local ride recording, MusicKit, evidence-based manual assistant. User approved implementation and isolated NAS deployment/TestFlight preparation on 2026-09-14.

- Preserve the supplied original PDF. Never commit manuals, credentials, telemetry or personal route data.
- Measured, inferred, user-confirmed and simulated values remain distinct. No fabricated RPM, gear, lean-angle accuracy or hardware/navigation availability.
- Watch haptics only when active/reachable; expire events, never use a fake workout for execution time.
- See docs/CONTRACT.md for shared interfaces. NAS/public/TestFlight/simulator/physical-device validation are distinct.
- Deploy Motuo containers/data independently; never change MedAgent business data or overwrite its deployments. Shared Nginx changes must be additive, backed up, checked with nginx -t and reload only.
- Keep README and docs/STATUS.md accurate and update Obsidian projects/motuo.md and TODO.md at closeout.
