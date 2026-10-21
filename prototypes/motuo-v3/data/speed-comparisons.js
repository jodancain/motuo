/* 趣味速度对比表（“速度突破剧场”里“你已超过 X”的依据）。
 * 只收录能查到可靠来源的近似值；数值都是“约”，口径各不相同（峰值冲刺 / 短距离 / 纪录均速）。
 * 比较时用区间上限 kmhMax：只有读数大于上限才说“已超过”。
 * 来源均于 2026-10-21 访问核对（检索工具：ezr web_search）。家猫、狮子等找不到权威来源的条目未收录。 */
export const ACCESSED = '2026-10-21';

export const COMPARISONS = Object.freeze([
  {id: 'marathon', name: '马拉松世界纪录配速', kmh: 21, kmhMax: 21, shape: 'runner', basis: '全程平均速度：基普图姆 2023 芝加哥马拉松 2:00:35（42.195 km）换算',
    sources: ['https://worldathletics.org/news/press-releases/ratified-world-marathon-record-kelvin-kiptum', 'https://en.wikipedia.org/wiki/2023_Chicago_Marathon']},
  {id: 'elephant', name: '大象', kmh: 25, kmhMax: 25, shape: 'elephant', basis: '最高速度（约）', sources: ['https://en.wikipedia.org/wiki/Elephant']},
  {id: 'bolt', name: '博尔特', kmh: 44.72, kmhMax: 44.72, shape: 'runner', basis: '2009 柏林世锦赛 100 米途中峰值速度', sources: ['https://en.wikipedia.org/wiki/Footspeed']},
  {id: 'grizzly', name: '灰熊', kmh: 48, kmhMax: 48, shape: 'bear', basis: '黄石公园可靠记录的最高速度', sources: ['https://en.wikipedia.org/wiki/Grizzly_bear']},
  {id: 'giraffe', name: '长颈鹿', kmh: 60, kmhMax: 60, shape: 'giraffe', basis: '短距离冲刺', sources: ['https://en.wikipedia.org/wiki/Giraffe']},
  {id: 'greyhound', name: '灰狗', kmh: 69, kmhMax: 69, shape: 'dog', basis: '最高速度“至少约 69 km/h”', sources: ['https://en.wikipedia.org/wiki/Greyhound']},
  {id: 'kangaroo', name: '红大袋鼠', kmh: 70, kmhMax: 70, shape: 'kangaroo', basis: '短距离最高速度', sources: ['https://en.wikipedia.org/wiki/Kangaroo']},
  {id: 'ostrich', name: '鸵鸟', kmh: 70, kmhMax: 70, shape: 'ostrich', basis: '短距离冲刺', sources: ['https://en.wikipedia.org/wiki/Common_ostrich']},
  {id: 'racehorse', name: '赛马纪录', kmh: 70.35, kmhMax: 70.35, shape: 'horse', basis: '吉尼斯纪录：Winning Brew，2008 年 402 米', sources: ['https://www.guinnessworldrecords.com/world-records/fastest-speed-for-a-race-horse']},
  {id: 'hare', name: '野兔', kmh: 80, kmhMax: 80, shape: 'hare', basis: '短距离最高速度', sources: ['https://en.wikipedia.org/wiki/Hare']},
  {id: 'pronghorn', name: '叉角羚', kmh: 88.5, kmhMax: 88.5, shape: 'antelope', basis: '最高速度', sources: ['https://en.wikipedia.org/wiki/Pronghorn']},
  {id: 'cheetah', name: '猎豹', kmh: 93, kmhMax: 104, shape: 'cheetah', basis: '短距离冲刺，约 93–104 km/h', sources: ['https://en.wikipedia.org/wiki/Cheetah', 'https://en.wikipedia.org/wiki/Fastest_animals']},
].map(Object.freeze));

export const approxLabel = c => (c.kmh === c.kmhMax ? `约 ${String(c.kmh)} km/h` : `约 ${c.kmh}–${c.kmhMax} km/h`);

// 读数已超过的最快一项（读数必须大于区间上限）；没有则 null。
export function overtaken(readingKmh) {
  if (!Number.isFinite(readingKmh)) return null;
  let best = null;
  for (const c of COMPARISONS) if (readingKmh > c.kmhMax && (!best || c.kmhMax > best.kmhMax)) best = c;
  return best;
}
