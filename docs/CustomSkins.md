# Create Your Own (custom skins)

The shop item **Create Your Own** (`create_your_own`, 10,000 Credits, legendary) lets an account draw its
own territory skin. It is sold like any other item: it is a catalog _pattern_ with no colours of its own, so
its flare `pattern:create_your_own` is the right to use the creator (`SKIN_CREATOR_FLARE` in
`packages/shared/src/CustomSkins.ts`). It is not a tile and is never worn itself: the client lists it first in
the Skins tab with its own artwork (the pattern's optional `url`), a bigger legendary hover, and opens the creator
once owned.

## What a design is

Two plain colours and a small grid of cells, the same one-bit tile format the catalog's skins use
(`PatternDecoder`). Limits, enforced when saving **and** again at join (`CustomSkinBodySchema`):

- a grid up to 32 by 32 cells, a cell size (`scale`) of 0 to 3, so the pattern data is at most 1403 characters;
- colours are lower-case `#rrggbb`;
- a name of up to 20 characters: letters, digits, spaces, dashes and underscores (it is only shown to its owner);
- five slots per account.

## Where it lives

| Piece                     | Where                                                                                                                                                                                                                                                                                                                               |
| ------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Table                     | `custom_skins` (migration `0011_custom_skins.sql`), cascades with the account                                                                                                                                                                                                                                                       |
| Routes                    | `PUT /users/@me/skins/:slot`, `DELETE /users/@me/skins/:slot` (`routes/customSkins.ts`): signed in, registered, not banned, owns the flare, rate limited (`skinWrite`)                                                                                                                                                              |
| Reported with the account | `GET /users/@me` carries `player.customSkins` (absent when there are none)                                                                                                                                                                                                                                                          |
| In a match                | the join message carries only `cosmetics.customSkin` (a slot). The game server looks the design up in the account's own `customSkins` from `/users/@me` and checks the flare (`PrivilegeCheckerImpl.isAllowed`), so nothing a client draws or sends is trusted; a slot the account does not have is refused like any other cosmetic |
| Creator window            | `skin-creator-modal` (`#modal=skin-creator`), drawing surface `skin-editor-canvas`, operations in `SkinEditorOps.ts`                                                                                                                                                                                                                |
| Worn                      | the equipped-skin setting holds `custom:<slot>` (it replaces a catalog pattern or skin, and the other way round); the Inventory's Skins tab lists the designs                                                                                                                                                                       |

## Moderation

Players draw these, so staff can remove one: `skin:remove <publicId> <slot|all> --reason <text> --yes` (audited).
The player is not notified. Removing the right to draw: `item:revoke <publicId> pattern:create_your_own --reason <text> --yes`.
There is no report button yet: designs are only ever seen as a tiled colour pattern on someone's territory.

## The private catalog

The item and its artwork live in `DeltaFront-Private-Store` (`overlays/cosmetics.json` and
`overlays/assets/create_your_own.png`). The public sample catalog does not carry it (its tests assume a fixed small
item list); the account API tests add it to a temporary copy.
