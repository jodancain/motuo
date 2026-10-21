/* 突破画廊：逐个预览每种剧目 × 世界 × 等级。只生成计划，不经过导演、不读写任何历史。 */
import {ACT_IDS, buildPlan} from './milestone-director.js';
import {rng} from './geometry.js';
import {WORLD_ORDER} from '../render/worlds.js';

export const GALLERY_TIERS = Object.freeze([{key: 1, th: 30, label: '小'}, {key: 2, th: 50, label: '中'}, {key: 3, th: 80, label: '大'}, {key: 4, th: 100, label: '大事件'}]);
// 剧目 + 三个特别条目：回归、今日新高、100 大事件（三幕串联）
export const GALLERY_ITEMS = Object.freeze([...ACT_IDS, 'comeback', 'new-high', 'grand']);

export function galleryPlan(index, {world = WORLD_ORDER[0], tier = 2, seed = 7} = {}) {
  const item = GALLERY_ITEMS[((index % GALLERY_ITEMS.length) + GALLERY_ITEMS.length) % GALLERY_ITEMS.length];
  const t = item === 'grand' ? GALLERY_TIERS[3] : GALLERY_TIERS.find(x => x.key === tier) || GALLERY_TIERS[1];
  // 预览读数：阈值 + 3（只用于剧目里的“超过 X”判定与画面，明确标“预览 · 非骑行数据”）
  const reading = item === 'compare' ? Math.max(t.th, 75) + 3 : t.th + 3, threshold = item === 'compare' ? Math.max(t.th, 80) : t.th;
  const rand = rng(seed + index * 97);
  const plan = buildPlan({threshold: item === 'grand' ? 100 : threshold, reading: item === 'grand' ? 103 : reading, world, rand, preview: true,
    comeback: item === 'comeback', newHigh: item === 'new-high', forceAct: ACT_IDS.includes(item) ? item : item === 'new-high' ? 'stamp' : null});
  return {...plan, item};
}
