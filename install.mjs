/**
 * 把 dsh-balance-card 装进某个 DSH profile（默认 desktop），幂等可重复执行。
 *
 *   node install.mjs                # 装进 desktop profile
 *   node install.mjs --profile web  # 装进别的 profile
 *   node install.mjs --uninstall    # 撤掉 bundle 行（包目录留着）
 *
 * 为什么用 Node 而不是 .ps1：Windows PowerShell 默认禁止执行脚本文件，
 * 而 DSH 本身就带 Node，`node install.mjs` 不需要改任何执行策略。
 *
 * 装完需要重启 DSH：desktop profile 不做热重载。
 */
import { cp, mkdir, readFile, writeFile, rm } from "node:fs/promises";
import { existsSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const SOURCE = path.dirname(fileURLToPath(import.meta.url));
const args = process.argv.slice(2);
const profile = (() => {
  const i = args.indexOf("--profile");
  return i === -1 ? "desktop" : (args[i + 1] ?? "desktop");
})();
const uninstall = args.includes("--uninstall");

const dshHome = process.env.DSH_HOME?.trim() || path.join(os.homedir(), ".dsh");
const profileDir = path.join(dshHome, "profiles", profile);
const patchPath = path.join(profileDir, "cordis.patch.yml");
const target = path.join(profileDir, "node_modules", "dsh-balance-card");
const MARKER = "id: dsh-balance-card";
const BLOCK = `\n# dsh-balance-card：左栏余额 / 近日消耗 / 峰谷倒计时卡片。\n- insert:\n    - id: dsh-balance-card\n      name: dsh-balance-card\n`;

if (!existsSync(path.join(profileDir, "package.json"))) {
  console.error(`profile 不存在：${profileDir}`);
  console.error("先打开一次 DeepSeek Harness 让它初始化 profile，再重跑。");
  process.exit(1);
}

const raw = existsSync(patchPath) ? await readFile(patchPath, "utf8") : "";
// 有 BOM 先去掉：YAML 解析器不认 BOM，写回去时也不能带。
const patch = raw.charCodeAt(0) === 0xfeff ? raw.slice(1) : raw;

if (uninstall) {
  if (!patch.includes(MARKER)) {
    console.log("cordis.patch.yml 里没有 dsh-balance-card 行，无需处理。");
    process.exit(0);
  }
  const updated = patch.replace(
    /\n?# dsh-balance-card[^\n]*\n- insert:\n\s+- id: dsh-balance-card\n\s+name: dsh-balance-card\n?/,
    "\n",
  );
  await writeFile(patchPath, updated, "utf8");
  console.log(`已从 ${patchPath} 移除 dsh-balance-card 行（包目录 ${target} 保留）。`);
  process.exit(0);
}

// 1) 拷包
await mkdir(target, { recursive: true });
for (const item of ["lib", "package.json", "cordis.patch.yml", "README.md"]) {
  const from = path.join(SOURCE, item);
  if (!existsSync(from)) throw new Error(`缺少 ${from}`);
  await cp(from, path.join(target, item), { recursive: true, force: true });
}
console.log(`已复制到 ${target}`);

// 2) 幂等插入 bundle 行
if (patch.includes(MARKER)) {
  console.log("cordis.patch.yml 里已有 dsh-balance-card 行，跳过。");
} else {
  const next = patch + (patch.endsWith("\n") || patch.length === 0 ? "" : "\n") + BLOCK;
  await writeFile(patchPath, next, "utf8");
  console.log(`已在 ${patchPath} 插入 dsh-balance-card 行。`);
}

console.log("");
console.log("完成。重启 DeepSeek Harness 后，左侧边栏底部（设置上方）会出现 DeepSeek 余额卡片。");
