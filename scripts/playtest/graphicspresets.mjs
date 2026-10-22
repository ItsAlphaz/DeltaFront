// Screenshots the same match (fixed game id: same spawns, same bots, same tick) under each graphics preset, for
// judging the looks side by side.
//   scripts/playtest/stack.sh node scripts/playtest/graphicspresets.mjs [map] [preset-name-key ...]
// Presets come from src/client/render/gl/graphics-presets.json and are applied through the page's own UserSettings,
// the way the preset selector does. Shots go to $PLAYTEST_OUT as preset-<name>.png (close) and preset-<name>-wide.png.
import { readFileSync } from "node:fs";
import { openGame, sleep } from "./game.mjs";

const [map = "Europe", ...only] = process.argv.slice(2);
const presets = JSON.parse(
  readFileSync("src/client/render/gl/graphics-presets.json", "utf8"),
).filter((p) => only.length === 0 || only.some((o) => p.nameKey.includes(o)));

const g = await openGame({ viewport: { width: 1440, height: 900 }, dpr: 1 });
const start = () =>
  g.ev(`(()=>{ const cid='mepresets'; const gid='gpresets1';
  document.dispatchEvent(new CustomEvent('join-lobby',{bubbles:true,composed:true,detail:{gameID:gid,source:'singleplayer',gameStartInfo:{gameID:gid,lobbyCreatedAt:1,
   players:[{clientID:cid,username:'Delta',clanTag:null,cosmetics:{}}],
   config:{gameMap:${JSON.stringify(map)},gameMapSize:'Compact',gameType:'Singleplayer',gameMode:'Free For All',playerTeams:2,difficulty:'Medium',maxTimerValue:undefined,bots:150,infiniteGold:false,donateGold:false,donateTroops:false,infiniteTroops:false,instantBuild:false,randomSpawn:true,disabledUnits:[],nations:'default',startingGold:0,capitalSystem:{enabled:false}}}}}));return 1})()`);

// One match; the camera is set once (zoomed in on the middle of the map) and every preset is then applied live in
// turn, so each shot shows the same ground at the same zoom (a later preset keeps the camera).
await start();
for (let i = 0; i < 150; i++) {
  await sleep(1000);
  if ((await g.ev("window.__tick || 0")) >= 300) break;
}
await sleep(1500);
for (let i = 0; i < Number(process.env.ZOOM ?? 3); i++) {
  await g.b.send("Input.dispatchMouseEvent", {
    type: "mouseWheel",
    x: Number(process.env.ZX ?? 745),
    y: Number(process.env.ZY ?? 366),
    deltaX: 0,
    deltaY: -120,
  });
  await sleep(300);
}
await sleep(2500);
for (const preset of presets) {
  const name = preset.nameKey.replace("graphics_setting.preset_", "");
  await g.ev(
    `(async()=>{ const m = await import('/src/client/UserSettings.ts'); new m.UserSettings().setGraphicsOverrides(${JSON.stringify(preset.overrides)}); return 1 })()`,
  );
  await sleep(3500);
  await g.b.shot(`preset-${name}`);
  console.log("shot", name);
}
await g.ev(
  `(async()=>{ const m = await import('/src/client/UserSettings.ts'); new m.UserSettings().setGraphicsOverrides({}); return 1 })()`,
);
await g.close();
