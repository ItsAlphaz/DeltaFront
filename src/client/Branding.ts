/**
 * DeltaFront product identity: the name, community links and storefront IDs
 * the UI shows. Anything player-facing that links off-site reads from here,
 * so pointing the fork at its own community is one edit. Leave a link empty
 * (or the Steam app null) and the UI hides whatever would have used it.
 */
export const BRAND = {
  name: "DeltaFront",

  // AGPL-3.0 §13: players of a modified network game must be offered its
  // source. TODO(deltafront): point this at the DeltaFront repository before
  // running a public server; until then it names the upstream project.
  sourceRepoUrl: "https://github.com/openfrontio/OpenFrontIO",

  discordUrl: "",
  redditUrl: "",
  wikiUrl: "",

  // Attribution for the upstream code and assets DeltaFront is built on.
  upstreamName: "OpenFront",
  upstreamCreditsUrl:
    "https://github.com/openfrontio/OpenFrontIO/blob/main/CREDITS.md",

  // Tutorial video embedded in Help and on the post-game screen. This is
  // OpenFront's own video (the gameplay it shows matches DeltaFront for now).
  // Replace it with your own embed URL when you have one; "" hides the video.
  tutorialVideoUrl: "https://www.youtube.com/embed/7J5zwb_s_Cg",

  // Ads. Off: the upstream ad scripts (Playwire, Admiral) are not shipped, and
  // with this false the homepage/in-game ad slots and adblock polling stay
  // inert. Set true only after adding your own ad provider's script to
  // index.html.
  adsEnabled: false,

  // Steam app for the wishlist promos and "open lobby in the Steam app".
  // null: DeltaFront has no Steam build, so those stay hidden.
  steamAppId: null as string | null,
};
