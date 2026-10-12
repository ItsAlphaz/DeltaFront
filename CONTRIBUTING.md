# Contributing to DeltaFront

Thanks for helping build DeltaFront.

## Licensing of contributions

- Code is licensed under the GNU AGPL v3.0, like the rest of the codebase.
- Assets added under `resources/` are licensed under CC BY-SA 4.0 (see `LICENSE-ASSETS`).
- Keep existing copyright and attribution notices intact, including "© OpenFront and Contributors" in the UI (AGPL §7 additional terms in `LICENSE`).

## Workflow

1. Fork and clone the repository, then install dependencies with `npm run inst` (not `npm install`).
2. Create a branch for your change.
3. Before opening a pull request, run:

   ```bash
   npm run lint
   npm run typecheck
   npm test
   ```

4. Changes to `packages/engine`, `packages/engine-api` or `packages/engine-lib` must include tests. The simulation is deterministic: use the seeded PRNG and `DetMath`, never `Math.random` or the approximated `Math` functions.
5. Player-visible text goes through `translateText()` with an entry in `resources/lang/en.json` (keys sorted).

## Styling

Use the DeltaFront tokens and shared classes in `src/client/styles.css` (`bg-df-*`, `text-df-*`, `border-df-border`, `.df-btn`, `.df-input`, `.df-panel`) rather than hard-coded colours. Red is for primary actions, selection, focus and brand accents, not whole surfaces.

## Upstream

DeltaFront tracks [OpenFront](https://github.com/openfrontio/OpenFrontIO). Fixes that are not DeltaFront-specific are worth offering upstream too; follow [OpenFront's contributing guide](https://github.com/openfrontio/OpenFrontIO/blob/main/CONTRIBUTING.md) for those.
