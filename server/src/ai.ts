import { type Config, aiConfigured } from "./config.js";
export async function generate(
  config: Config,
  system: string,
  user: string,
): Promise<string | null> {
  if (!aiConfigured(config)) return null;
  try {
    const result = await fetch(
      config.aiBaseURL.replace(/\/$/, "") + "/chat/completions",
      {
        method: "POST",
        headers: {
          Authorization: `Bearer ${config.aiKey}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          model: config.aiModel,
          messages: [
            { role: "system", content: system },
            { role: "user", content: user },
          ],
          temperature: 0.2,
          max_tokens: 1000,
        }),
        signal: AbortSignal.timeout(config.aiTimeoutMS),
      },
    );
    if (!result.ok) return null;
    const body = (await result.json()) as {
      choices?: { message?: { content?: unknown } }[];
    };
    const text = body.choices?.[0]?.message?.content;
    return typeof text === "string" && text.trim() && text.length < 12000
      ? text.trim()
      : null;
  } catch {
    return null;
  }
}
export interface RideEvidence {validSpeedSamples:number;validLocationSamples:number;maxSpeedMPS:number|null;}
export function localReport(ride:Record<string,unknown>,evidence:RideEvidence):string {
 const km=Number(ride.distanceM || 0)/1000,minutes=Number(ride.durationS || 0)/60;
 const distance=evidence.validLocationSamples>0?`按有效定位段累计记录 ${km.toFixed(1)} 公里`:'未获得有效定位样本，里程暂无法核对';
 const speed=evidence.validSpeedSamples>0 && evidence.maxSpeedMPS!==null?`有效样本最高速度 ${(evidence.maxSpeedMPS*3.6).toFixed(1)} km/h`:'未获得有效速度，不能把缺测当作静止';
 return `${ride.source==='simulated'?'本次为模拟骑行。':'本次骑行已记录。'}${distance}，时长 ${minutes.toFixed(1)} 分钟。${speed}。手机传感器只提供观测或估计，不能独立确认挡位、发动机转速或车辆故障。请结合实际车况复核；完成停车后再查看详细复盘。`;
}
export function numberSupported(answer: string, evidence: string): boolean {
  // Decimal values, ranges, dimensions and units must occur verbatim in cited evidence.
  const normalize = (v: string) =>
    v.normalize("NFKC").replace(/\s/g, "").replace(/[–—]/g, "-").toLowerCase();
  const source = normalize(evidence);
  const tokens =
    answer.match(
      /[-+]?\d+(?:[.,]\d+)?(?:\s*[-~～–—]\s*\d+(?:[.,]\d+)?)?(?:\s*(?:毫升|毫安|毫米|厘米|千米|公里|千帕|兆帕|摄氏度|牛顿米|牛[·・]?米|升|米|伏特|安培|千克|克|度|kg|g|N[·・.]?m|Nm|kPa|MPa|bar|psi|mm|cm|km\/h|km|mL|ml|L|rpm|r\/min|°C|℃|V|A|Hz|cc|m\/s|%))?/g,
    ) || [];
  return tokens.every((token) => {
    const escaped = normalize(token).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    return new RegExp("(?<![0-9.])" + escaped + "(?![0-9.])").test(source);
  });
}
