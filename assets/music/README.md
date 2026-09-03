# Background music

The game plays **`zoomies.mp3`** (installed here) on both the menu and during
races — it loops automatically. **Night** worlds instead play the moodier
**`zoomieslevel1.mp3`**. Wiring lives in `src/main.js`, where the track is chosen
by the world's time of day and passed to `audio.registerMusic(...)`.

## Replacing or splitting the track

- **Swap the song:** replace `zoomies.mp3` with your own file of the same name
  (or change the paths in `src/main.js`).
- **Separate menu vs. race music:** drop a second file (e.g. `menu.mp3`) and
  point the `registerMusic("menu", ...)` call at it.

## Tips

- `.mp3` is the safest cross-browser format.
- Tracks loop, so a clean loop point (or a song that tolerates a hard loop)
  works best.
- Make sure you have the rights to whatever you ship.
- Keep files reasonably small so the page loads fast on mobile.

All sound effects are synthesized in code and need no files. Volume/mute is
shared across music + SFX via the **Sound** button on the menu and pause screen.

## Rights

Both MP3s were generated with **Suno**: their ID3 `TXXX` comment frames read
`made with suno; created=2026-06-25` (`zoomies.mp3`) and `created=2026-06-21`
(`zoomieslevel1.mp3`), each with a Suno generation id. Nothing in this repo
asserts more than that — what you may DO with them depends on Suno's terms
and on the plan the account was on when they were generated (at the time of
writing, Suno's free tier does not grant commercial rights to generated
songs; paid tiers do, for songs made while subscribed). Before shipping on
Steam (or any paid channel), the owner needs to confirm the following:

- [ ] Which Suno plan the generating account was on at each creation date
      above, and that it grants commercial use of songs made then. If it was
      the free tier, either upgrade and regenerate, or replace the tracks.
- [ ] Keep the Suno account / generation ids (above) reachable as the record
      of provenance, in case a store or claimant asks.
- [ ] Suno's terms may require attribution or disallow registering the songs
      with a content-ID system; check the current terms and comply.
- [ ] Steam's store submission includes an **AI-generated content
      disclosure** (pre-generated content section). These tracks must be
      declared there as AI-generated music. The same disclosure applies to
      any other AI-made asset in the game.
- [ ] If either track is ever replaced by a human-composed or licensed one,
      update this section and `THIRD-PARTY.md` (which points here).

The "make sure you have the rights to whatever you ship" tip above is the
rule; this section is what "the rights" concretely means for these two files.
