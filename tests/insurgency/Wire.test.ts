import type { Intent } from "@openfront/engine-api/Schemas";
import {
  createGameWireContext,
  decodeClientMessage,
  encodeClientMessage,
} from "@openfront/shared/ZbinWire";
import { describe, expect, it } from "vitest";

/**
 * Every order the Capital System and the resistance add, as a client puts it on
 * the wire and the server reads it back: the binary frame the real game server
 * gets (packages/shared/src/ZbinWire.ts). The rest of the suite hands intents
 * to the engine directly or checks only their zod schema; solo play never
 * crosses the wire at all, so this is the only place a field that does not
 * survive the binary encoding (a number too big for its type, an id the
 * dictionary does not know) would show before a real match.
 */

const ROSTER = [{ clientID: "aaaaaaaa" }, { clientID: "bbbbbbbb" }];

// A player id as the engine makes it (8 random characters); not a client id,
// so the dictionary does not know it and it rides inline.
const PLAYER_ID = "fqducplm";

const INTENTS: [string, Intent][] = [
  ["found a replacement capital", { type: "found_capital", tile: 1_234_567 }],
  [
    "found it on the last tile of a big map",
    { type: "found_capital", tile: 16_777_215 },
  ],
  ["recruit", { type: "resistance_recruit", troops: 7_500 }],
  [
    "recruit the most it may be",
    { type: "resistance_recruit", troops: 250_000 * 2 },
  ],
  ["establish a base", { type: "resistance_base", tile: 619_823 }],
  [
    "launch an uprising",
    { type: "resistance_uprising", region: 609, troops: 18_786 },
  ],
  [
    "launch one in the first region",
    { type: "resistance_uprising", region: 0, troops: 5_000 },
  ],
  ["gather intelligence", { type: "resistance_intel", region: 574 }],
  [
    "suppress a region of a player's resistance",
    { type: "suppress_region", target: PLAYER_ID, region: 574 },
  ],
  [
    "suppress as a client the dictionary knows",
    { type: "suppress_region", target: "bbbbbbbb", region: 3 },
  ],
];

describe("the resistance's and the capital's orders over the binary wire", () => {
  for (const ctx of [
    "with the roster's dictionary",
    "without one (before the game starts)",
  ]) {
    describe(ctx, () => {
      const make = () =>
        ctx.startsWith("with") ? createGameWireContext(ROSTER) : undefined;
      it.each(INTENTS)(
        "%s survives encoding and decoding unchanged",
        (_name, intent) => {
          const sent = encodeClientMessage({ type: "intent", intent }, make());
          const received = decodeClientMessage(sent, make());
          expect(received).toEqual({ type: "intent", intent });
        },
      );
    });
  }

  it("a frame is small: an order is a handful of bytes", () => {
    const sent = encodeClientMessage(
      {
        type: "intent",
        intent: { type: "resistance_uprising", region: 609, troops: 18_786 },
      },
      createGameWireContext(ROSTER),
    );
    expect(sent.byteLength).toBeLessThan(16);
  });
});
