# 完全开源地图与导航：已选路线，待原型确认后接入

2026-09-20 用户明确要求国内也不用高德，先看 HTML 效果再改 App。当前 TestFlight 0.1.0 (1) 仍是原安装版；本文不是已部署能力。HTML 中的地图为虚构示意道路，不调用下面任何服务。

## 固定组合

- 地图：MapLibre Native iOS；矢量底图、冰蓝道路、真实轨迹和目的地叠加。它不提供地图数据或算路。[官方文档](https://maplibre.org/maplibre-native/ios/latest/documentation/maplibre/)
- 数据：用户选定地区及周边的 OSM PBF，使用 tilemaker 的 OpenMapTiles 配置在 Mac 构建版本化 MBTiles；NAS 不进行全国地图构建。[tilemaker](https://github.com/systemed/tilemaker/blob/master/docs/RUNNING.md)、[中国地区数据](https://download.geofabrik.de/asia/china.html)
- 分发：独立 Martin 容器，提供只读地图包、样式、中文字体字形与图标。运行时资源全部走自家 HTTPS，避免依赖海外演示站。[Martin](https://maplibre.org/martin/)
- 算路：Valhalla 固定 motorcycle，不自动切换汽车或自行车模式；通过 NAS 网关鉴权，返回真实道路路径和转向信息。[路线 API](https://valhalla.github.io/valhalla/api/route/api-reference/)
- 导航：Ferrostar 处理位置匹配、路线进度、偏航和指引，接入自家 HUD、语音与 Watch；锁定依赖版本。[Ferrostar](https://stadiamaps.github.io/ferrostar/)
- 搜索：Pyosmium 从同一数据包提取地名/POI及中文别名，复用 PostgreSQL；先支持区域地点名称搜索，不承诺完整地址解析或全国 POI。[Pyosmium](https://docs.osmcode.org/pyosmium/latest/user_manual/04-Working-with-Filters/)

## 最小接口与数据约定

原生增加 `MapDataProvider` 和 `NavigationProvider`，把地点搜索、地图显示、算路与实时指引分开。模拟实现始终带 `source=simulated`，不把 HTML 模拟数据写入真实骑行。

- 扩展 `/v1/capabilities`：地区、地图数据版本、搜索/算路可用状态；未上线必须是不可用。
- `GET /v1/maps/regions`：地区边界、数据日期、资源版本与署名。
- `GET /v1/navigation/places`：查询词、地区与可选附近位置，返回地点名、地区、WGS84 坐标及 OSM 来源。
- `POST /v1/navigation/routes`：WGS84 起终点、地区和避让偏好，保留导航引擎所需的完整路线信息，附数据版本和 `restrictionCoverage=unverified`。

原始定位、搜索、路径统一 WGS84；GeoJSON 为 `[longitude, latitude]`，Valhalla 输入显式 `lat/lon`。地图投影不等于坐标加偏。不混入来源不明的 GCJ-02 坐标。

## 产品边界与验收

Valhalla 官方 motorcycle 仍标 beta；路线偏好不等于中国摩托禁限行完整覆盖。初版标注「开源路线 · 试验版」，详情显示地区、数据日期与限制未校验状态。无实时交通来源时不显示实时路况。区域外或无路可达明确返回失败；不能用直线或汽车路线冒充。

缓存地图和已取得路线可继续显示，但 NAS 不可达时不能重新规划。手机本地离线算路不包含在首轮集成中。真实 OSM 地图保留可见署名和许可入口，不使用公共瓦片站做批量离线下载。

顺序为：HTML 评审 → SwiftUI 全屏/地图布局 → 真实底图与轨迹 → NAS 主服务恢复后增加 Martin/Valhalla → 区域搜索与算路 → Ferrostar 指引/语音/Watch。先测 NAS 空闲容量和地图峰值内存，再设资源限制，避免影响手册 OCR 或其他业务。

首个实测地区尚待用户提供。至少抽查 30 个中文地点、重名/短名称、坐标对齐、区域边缘、单行/掉头/封闭道路、已知禁摩样例、偏航重算、隧道与断网；记录缺失率和错误路线。HTML 测试不替代以上验收。
