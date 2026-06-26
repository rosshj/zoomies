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
