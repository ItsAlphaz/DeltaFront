import builtinPresets from "./graphics-presets.json";
import { GraphicsOverridesSchema } from "./GraphicsOverrides";

/**
 * DeltaFront's default look: the Blood Moon preset. New players start on it,
 * everyone is moved to it once (see applyDefaultLookOnce), and the Store's
 * previews are drawn with it. One place, so changing the default is one edit.
 */
export const DEFAULT_LOOK_KEY = "graphics_setting.preset_blood_moon";

export const DEFAULT_LOOK = GraphicsOverridesSchema.parse(
  builtinPresets.find((preset) => preset.nameKey === DEFAULT_LOOK_KEY)!
    .overrides,
);

/** Bump when the default look changes and everyone should be moved to it again. */
export const DEFAULT_LOOK_VERSION = "blood_moon-1";
