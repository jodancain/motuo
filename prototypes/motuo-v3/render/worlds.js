/* 四个世界（关卡）：配色、视差层风格、天气。只决定画面，不触碰任何数据。 */

export const WORLDS = Object.freeze({
  neon: Object.freeze({
    key: 'neon', chapter: '第1话', name: '霓虹都市夜', en: 'NEON NIGHT',
    sky: ['#0d0826', '#2a0f55', '#6a1c78'], band: '#ff3d9a', celestial: {kind: 'moon', x: .2, y: .2, r: .11, fill: '#ffe9a8', shade: '#f2a94f'},
    stars: .5, far: {kind: 'city', fill: '#2a1652', top: .3}, mid: {kind: 'city', body: ['#1a0f38', '#22134a', '#160c2e'], window: ['#ffd76a', '#5ef2ff', '#ff4fa3'], roof: 'flat', signs: ['MOTUO', '夜', 'GO!', '漫画', '24H', '骑行']},
    near: {kind: 'rail', post: '#3b3466', rail: '#5ef2ff', lamp: '#ffd76a'}, road: {fill: '#16112a', lane: '#ffe45c', edge: '#5ef2ff', grid: false, wet: true},
    weather: 'rain', ink: '#07040f', c: '#38f0ff', m: '#ff3da6', y: '#ffe45c', paper: '#f3ead6', line: '#ffffff', accent: '#ff3da6',
  }),
  sunset: Object.freeze({
    key: 'sunset', chapter: '第2话', name: '落日海岸', en: 'SUNSET COAST',
    sky: ['#ff5a5f', '#ff8a4c', '#ffd27a'], band: '#ffef9a', celestial: {kind: 'sun', x: .7, y: .42, r: .2, fill: '#fff3b0', shade: '#ff9a3d'},
    stars: 0, far: {kind: 'sea', fill: '#3a4fa8', top: .56, land: '#7b2e63'}, mid: {kind: 'coast', body: ['#8a2f5e', '#a33b5f', '#6f2552'], window: ['#ffe39a', '#fff6d8'], roof: 'peak', signs: ['SURF', '海', 'CAFE']},
    near: {kind: 'rail', post: '#fff6e6', rail: '#e8484f', lamp: '#fff3b0'}, road: {fill: '#3b2243', lane: '#fff2c4', edge: '#ffd27a', grid: false, wet: false},
    weather: 'gulls', ink: '#1a0b1e', c: '#2ed3ff', m: '#ff2f7a', y: '#ffd23a', paper: '#f6ecd6', line: '#fff6e0', accent: '#ff2f7a',
  }),
  snow: Object.freeze({
    key: 'snow', chapter: '第3话', name: '雪山隧道', en: 'SNOW TUNNEL',
    sky: ['#7fa8d8', '#bcd6f0', '#eef5ff'], band: '#ffffff', celestial: {kind: 'sun', x: .78, y: .18, r: .07, fill: '#ffffff', shade: '#cfe3ff'},
    stars: 0, far: {kind: 'mountain', fill: '#5f7fae', cap: '#ffffff', top: .22}, mid: {kind: 'pines', body: ['#2f4268', '#3a5079', '#263655'], window: ['#ffcf6a'], roof: 'peak', signs: ['雪', 'KM']},
    near: {kind: 'tunnel', post: '#8e9ab2', rail: '#c4cede', lamp: '#ffb347'}, road: {fill: '#454e64', lane: '#ffffff', edge: '#ffb347', grid: false, wet: false},
    weather: 'snow', ink: '#0d1220', c: '#22c7ff', m: '#ff3d8b', y: '#ffd23a', paper: '#f4f1ea', line: '#ffffff', accent: '#22c7ff',
  }),
  cosmic: Object.freeze({
    key: 'cosmic', chapter: '第4话', name: '紫夜宇宙公路', en: 'COSMIC HIGHWAY',
    sky: ['#05021a', '#1a0a40', '#4b1880'], band: '#7cf9ff', celestial: {kind: 'planet', x: .25, y: .26, r: .16, fill: '#ff9ee8', shade: '#7a36c8'},
    stars: 1, far: {kind: 'asteroids', fill: '#2a1460', top: .4}, mid: {kind: 'crystal', body: ['#2b1660', '#371d77', '#22104d'], window: ['#7cf9ff', '#ff7cf0'], roof: 'spire', signs: ['宇宙', 'STAR', 'WARP']},
    near: {kind: 'pylon', post: '#ff4fd8', rail: '#7cf9ff', lamp: '#7cf9ff'}, road: {fill: '#110828', lane: '#7cf9ff', edge: '#ff4fd8', grid: true, wet: false},
    weather: 'stars', ink: '#04020e', c: '#3ef6ff', m: '#ff3df0', y: '#fff36a', paper: '#efe6f5', line: '#d8f6ff', accent: '#ff3df0',
  }),
});
export const WORLD_ORDER = Object.freeze(['neon', 'sunset', 'snow', 'cosmic']);
export const nextWorld = key => WORLD_ORDER[(WORLD_ORDER.indexOf(key) + 1) % WORLD_ORDER.length];
export const normalizeWorld = key => (WORLDS[key] ? key : 'neon');
