// 一次性 script：由 free-exercise-db 抽出我哋用到嘅動作，生成 exercises.json 同下載示範圖。
// 用法：cd site/gym && node tools/build-exercises.mjs
// ponytail: 圖片原檔約 70KB 一張，冇 resize。整個 workout 只 lazy-load 8-10 張，實測夠用；
//           如果手機載入慢，先加 sharp 縮到 400px 寬。

import { writeFile, mkdir } from 'node:fs/promises';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const SRC = 'https://raw.githubusercontent.com/yuhonas/free-exercise-db/main';
// 一定要用 fileURLToPath —— 路徑含中文（G:\我的雲端硬碟\…），
// 直接讀 URL.pathname 會攞到 percent-encoded 字串，寫檔會失敗。
const OUT_DIR = join(dirname(fileURLToPath(import.meta.url)), '..');

// id, 中文名, slot, upperLower, minWeight, metric, [要訣]
const PICKS = [
  ['Barbell_Squat', '槓鈴深蹲', 'squat', 'lower', 20, 'reps',
    ['腳掌全掌著地，膝頭同腳尖同方向', '落到大腿平行或以下', '核心收緊，唔好塌腰']],
  ['Front_Barbell_Squat', '前蹲', 'squat', 'lower', 20, 'reps',
    ['手肘抬高，槓放喺三角肌前束', '上身盡量直立', '膝頭唔好向內夾']],
  ['Leg_Press', '腿推機', 'squat', 'lower', 0, 'reps',
    ['腳掌與肩同寬放喺踏板中間', '唔好鎖死膝頭', '腰貼實椅背']],
  ['Goblet_Squat', '高腳杯深蹲', 'squat', 'lower', 0, 'reps',
    ['啞鈴貼實胸口', '手肘喺膝頭內側掃過', '慢落快起']],

  ['Romanian_Deadlift', '羅馬尼亞硬拉', 'hinge', 'lower', 20, 'reps',
    ['膝頭微曲但唔再彎', '髖向後推，槓貼住大腿滑落', '感覺膕繩拉緊就停']],
  ['Barbell_Deadlift', '傳統硬拉', 'hinge', 'lower', 20, 'reps',
    ['槓貼近小腿中段', '起身前先繃緊背闊肌', '髖同膝同時伸展']],
  ['Stiff-Legged_Barbell_Deadlift', '直腿硬拉', 'hinge', 'lower', 20, 'reps',
    ['背保持中立，唔好拱起', '重量放喺腳踭', '幅度以柔軟度為限']],
  ['Lying_Leg_Curls', '俯臥腿彎舉', 'hinge', 'lower', 0, 'reps',
    ['髖貼實墊，唔好翹起', '頂點停一秒', '慢放落']],

  ['Barbell_Bench_Press_-_Medium_Grip', '平板臥推', 'horizontal_push', 'upper', 20, 'reps',
    ['肩胛骨收緊落沉', '槓落到胸線位置', '腳踩實地面']],
  ['Dumbbell_Bench_Press', '啞鈴臥推', 'horizontal_push', 'upper', 0, 'reps',
    ['手腕保持中立', '落到胸肌有拉伸感', '頂點唔好互撞']],
  ['Incline_Dumbbell_Press', '上斜啞鈴推', 'horizontal_push', 'upper', 0, 'reps',
    ['椅背約 30 度就夠', '手肘唔好完全張開', '控制落嘅速度']],
  ['Dips_-_Triceps_Version', '雙槓臂屈伸', 'horizontal_push', 'upper', 0, 'reps',
    ['身體保持垂直練三頭', '肩膊唔好聳起', '落到手肘 90 度']],

  ['Standing_Military_Press', '站姿肩推', 'vertical_push', 'upper', 20, 'reps',
    ['臀同核心收緊，唔好用腰借力', '槓過頭後頭部微微向前', '手肘唔好過度外張']],
  ['Seated_Dumbbell_Press', '坐姿啞鈴推', 'vertical_push', 'upper', 0, 'reps',
    ['腰貼椅背', '啞鈴落到耳邊', '唔好鎖死手肘']],
  ['Dumbbell_Shoulder_Press', '啞鈴肩推', 'vertical_push', 'upper', 0, 'reps',
    ['起始位手肘微微向前', '軌跡呈微微內收', '核心保持穩定']],

  ['Bent_Over_Barbell_Row', '槓鈴划船', 'horizontal_pull', 'upper', 20, 'reps',
    ['上身約 45 度，背保持中立', '槓拉向肚臍', '頂點夾緊肩胛']],
  ['Seated_Cable_Rows', '坐姿繩索划船', 'horizontal_pull', 'upper', 0, 'reps',
    ['唔好用腰前後擺', '手肘貼近身體', '頂點停一停']],
  ['One-Arm_Dumbbell_Row', '單臂啞鈴划船', 'horizontal_pull', 'upper', 0, 'reps',
    ['背保持平', '拉到髖側', '唔好轉腰借力']],

  ['Wide-Grip_Lat_Pulldown', '寬握高位下拉', 'vertical_pull', 'upper', 0, 'reps',
    ['胸挺起，微微後仰', '拉到鎖骨位置', '慢放返上去']],
  ['Close-Grip_Front_Lat_Pulldown', '窄握高位下拉', 'vertical_pull', 'upper', 0, 'reps',
    ['肩膊先落沉再拉', '手肘向下向後', '唔好用身體擺動']],
  ['Pullups', '引體向上', 'vertical_pull', 'upper', 0, 'reps',
    ['起始位完全伸直', '下巴過槓', '做唔到就用彈力帶輔助']],

  ['Plank', '平板支撐', 'core', 'upper', 0, 'seconds',
    ['手肘喺膊頭正下方', '臀部唔好翹高或塌低', '正常呼吸']],
  ['Hanging_Leg_Raise', '懸垂舉腿', 'core', 'upper', 0, 'reps',
    ['唔好前後擺盪', '骨盆後傾先抬腿', '慢放落']],
  ['Cable_Crunch', '繩索捲腹', 'core', 'upper', 0, 'reps',
    ['髖固定，只捲腹', '用腹肌唔好用手臂拉', '頂點呼氣']],

  // minWeight 20：槓鈴動作一律用空槓做地板。0 會令 deload / 首次估算叫你做「0kg 槓鈴彎舉」。
  ['Barbell_Curl', '槓鈴彎舉', 'accessory', 'upper', 20, 'reps',
    ['手肘固定喺身側', '唔好用腰擺動', '慢放落']],
  ['Hammer_Curls', '錘式彎舉', 'accessory', 'upper', 0, 'reps',
    ['掌心相對', '手肘唔好前後移', '控制離心']],
  ['Triceps_Pushdown', '三頭下壓', 'accessory', 'upper', 0, 'reps',
    ['上臂貼實身側', '底部完全伸直', '唔好聳肩']],
  ['Side_Lateral_Raise', '側平舉', 'accessory', 'upper', 0, 'reps',
    ['用輕重量', '抬到肩高就夠', '手肘微曲']],
  ['Face_Pull', '面拉', 'accessory', 'upper', 0, 'reps',
    ['拉向額頭高度', '外旋肩膊', '對肩膊健康好重要']],
  ['Standing_Calf_Raises', '站姿提踵', 'accessory', 'lower', 0, 'reps',
    ['頂點停一秒', '落到有拉伸感', '全程控制']],
  ['Leg_Extensions', '腿屈伸', 'accessory', 'lower', 0, 'reps',
    ['唔好用衝力甩上去', '頂點停一停', '膝頭有唔舒服就減重']]
];

const raw = await (await fetch(`${SRC}/dist/exercises.json`)).json();
const byId = new Map(raw.map((e) => [e.id, e]));

const out = [];
for (const [id, name, slot, upperLower, minWeight, metric, cues] of PICKS) {
  const src = byId.get(id);
  if (!src) throw new Error(`動作庫入面搵唔到 ${id} —— 上游資料可能改咗`);

  const images = [];
  for (let i = 0; i < src.images.length && i < 2; i++) {
    const rel = src.images[i];
    const buf = Buffer.from(await (await fetch(`${SRC}/exercises/${rel}`)).arrayBuffer());
    const dir = join(OUT_DIR, 'img', id);
    await mkdir(dir, { recursive: true });
    await writeFile(join(dir, `${i}.jpg`), buf);
    images.push(`img/${id}/${i}.jpg`);
  }

  out.push({ id, name, nameEn: src.name, slot, equipment: src.equipment,
             upperLower, minWeight, metric, images, cues });
  console.log(`✓ ${name} (${id})`);
}

await writeFile(join(OUT_DIR, 'exercises.json'), JSON.stringify(out, null, 1) + '\n');
console.log(`\n生成 ${out.length} 個動作 → exercises.json`);
