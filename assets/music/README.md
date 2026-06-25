# Background music

Drop two audio files here and they'll play automatically — no code changes needed:

| File | When it plays | Suggested vibe |
|------|---------------|----------------|
| `menu.mp3` | Main menu / between races | Light, loopable theme |
| `race.mp3` | During a race | Upbeat, driving loop |

## Requirements / tips

- **Format:** `.mp3` is the safest cross-browser choice. (If you'd rather use
  `.ogg`/`.m4a`, change the paths in `src/main.js` where `audio.registerMusic(...)`
  is called.)
- **Looping:** the tracks loop seamlessly, so pick loops (or songs that tolerate
  a hard loop point). No need to fade the ends yourself.
- **Licensing:** make sure you have the rights to whatever you ship. Royalty-free
  / CC0 game-music sources work well.
- **Size:** keep them reasonably small (a 1–2 min loop is plenty) so the page
  loads fast on mobile.

Until these files exist the game just runs silent on the music layer — all the
sound effects are synthesized in code and need no files. Volume/mute is shared
with the rest of the audio via the **Sound** button on the menu and pause screen.
