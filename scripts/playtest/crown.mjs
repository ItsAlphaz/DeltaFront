// A crown cosmetic over a player's name in a real match: how large it is, and whether it reads on dark land.
//   scripts/playtest/stack.sh node scripts/playtest/crown.mjs [crown.svg ...]
// Each svg (default: the private catalog's staff, admin and owner crowns) is served to the page as the crown of "me",
// who leads the match; one screenshot per crown, zoomed in on the name. KEEP=30 leaves the first match open for 30 minutes.
import { readFileSync } from "node:fs";
import { openGame, sleep, startMatch } from "./game.mjs";

const ZOOM = Number(process.env.ZOOM ?? 2);
const files = process.argv.slice(2);
const dir = new URL(
  "../../../DeltaFront-Private-Store/assets/",
  import.meta.url,
);
const crowns = files.length
  ? files
  : [
      "crown_owner_majesty.svg",
      "crown_crimson_majesty.svg",
      "crown_staff_majesty.svg",
      "crown_pixel_owner.svg",
      "crown_ivory_owner.svg",
    ];

for (const file of process.env.KEEP ? crowns.slice(0, 1) : crowns) {
  const svg = readFileSync(file.includes("/") ? file : new URL(file, dir));
  const g = await openGame({ width: 1280, height: 800 });
  await g.b.send("Fetch.enable", {
    patterns: [{ urlPattern: "*crown_test*" }],
  });
  g.b.onEvent(async (d) => {
    if (d.method !== "Fetch.requestPaused") return;
    await g.b.send("Fetch.fulfillRequest", {
      requestId: d.params.requestId,
      responseCode: 200,
      responseHeaders: [
        { name: "content-type", value: "image/svg+xml" },
        { name: "access-control-allow-origin", value: "*" },
      ],
      body: svg.toString("base64"),
    });
  });
  const { inject } = await startMatch(g, {
    myName: "Alphaz",
    buyCapitals: false,
    myCosmetics: { crown: { name: "crown_test", url: "crown_test.svg" } },
  });
  for (let i = 0; i < 6; i++) {
    await inject("window.__cid", {
      type: "attack",
      targetID: null,
      troops: null,
    });
    await sleep(1200);
  }
  // zoom in on the middle of the screen, where the camera starts on the player
  for (let i = 0; i < ZOOM; i++) {
    await g.b.send("Input.dispatchMouseEvent", {
      type: "mouseWheel",
      x: 640,
      y: 400,
      deltaX: 0,
      deltaY: -240,
    });
    await sleep(150);
  }
  // drag the map so that the player's land (up and to the right) is in the middle
  const mouse = (type, x, y) =>
    g.b.send("Input.dispatchMouseEvent", {
      type,
      x,
      y,
      button: "left",
      buttons: type === "mouseReleased" ? 0 : 1,
      clickCount: 1,
    });
  await mouse("mouseMoved", 1300, 250);
  await mouse("mousePressed", 1300, 250);
  for (let i = 1; i <= 10; i++)
    await mouse("mouseMoved", 1300 - i * 60, 250 + i * 35);
  await mouse("mouseReleased", 700, 600);
  await sleep(1500);
  const name = file.replace(/^crown_|\.svg$/g, "").replace(/.*\//, "");
  await g.b.shot(`crown-${name}`);
  console.log("shot crown-" + name);
  if (process.env.KEEP) {
    // leave the match open to look at: it ends when the window is closed or after KEEP minutes
    console.log(
      "match open: close the window (or wait " +
        process.env.KEEP +
        " minutes) to stop",
    );
    for (let i = 0; i < Number(process.env.KEEP) * 12 && !g.b.isClosed(); i++)
      await sleep(5000);
  }
  await g.close();
}
