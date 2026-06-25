# Background music

The game now plays a **procedural, Don Toliver–style melodic trap loop**
synthesized in code (`src/audio.js`) — dreamy pads, an echoing lead, hard 808s,
and trap drums. It needs no files: there's a mellow version on the menu and the
full beat during a race. Volume/mute is the **Sound** button on the menu and
pause screen.

## Want to use a real audio track instead?

The file-based player is still available if you'd rather ship your own song:

1. Drop e.g. `race.mp3` and `menu.mp3` in this folder.
2. In `src/main.js`, register and play them instead of `audio.playBeat(...)`:
   ```js
   audio.registerMusic("menu", "./assets/music/menu.mp3");
   audio.registerMusic("race", "./assets/music/race.mp3");
   // ...then call audio.playMusic("race") / audio.playMusic("menu")
   // where audio.playBeat("race") / audio.playBeat("menu") are called now.
   ```

Tips: `.mp3` is the safest cross-browser format; pick seamless loops; make sure
you have the rights to anything you ship; keep files small for fast mobile loads.
