---
name: game-audio
description: Game sound with studio_audio - sfxr-style sound effects (pickup, jump, hit, explosion, laser, powerup, blip, or your own parameters), seamless music loops from a chord progression (chiptune or ambient), loudness normalization (LUFS) and WAV measurements, all deterministic by seed and saved as assets. Use for any sound effect or music a game needs.
---
# Game audio (studio_audio)

Everything is 16-bit PCM WAV at 44.1 kHz (`sampleRate` changes it), made in plain JS, saved as a Studio asset (kind `audio` or `music`) with its parameters, and shown as a waveform (red where it reaches full scale).

## Sound effects

```json
{"action":"sfx","preset":"pickup","seed":3,"variants":4}
```
Presets: `pickup` (coins), `laser`, `explosion`, `powerup`, `hit` (hurt), `jump`, `blip` (menus). A seed picks the variation; `variants: N` writes N of them (`pickup_1.wav`...) to play at random so repeats do not tire the ear. `params.json` records the synth settings.

Shape a sound with `params` (sfxr's ranges, 0 to 1 unless noted) over the preset:
- `wave`: square, saw, sine, noise; `duty` (square width), `dutyRamp`.
- Pitch: `baseFreq`, `freqLimit` (stops a falling pitch), `freqRamp` (-1..1: slide down or up), `freqDramp`; `vibStrength`, `vibSpeed`; `arpSpeed`, `arpMod` (-1..1: a jump in pitch).
- Envelope: `envAttack`, `envSustain`, `envPunch` (a louder start), `envDecay`.
- Filters and effects: `lpfFreq` (1 = open), `lpfResonance`, `lpfRamp`, `hpfFreq`, `hpfRamp`, `phaOffset`, `phaRamp` (phaser), `repeatSpeed` (retrigger).

Worked examples: a heavier landing thump `{"preset":"hit","params":{"wave":"noise","baseFreq":0.12,"envDecay":0.25,"lpfFreq":0.4}}`; a rising menu confirm `{"preset":"blip","params":{"freqRamp":0.25,"envSustain":0.08}}`; a door creak is better as a slow saw with vibrato `{"params":{"wave":"saw","baseFreq":0.18,"vibStrength":0.4,"vibSpeed":0.2,"envSustain":0.5,"envDecay":0.3}}`.

## Music loops

```json
{"action":"music","style":"chiptune","progression":"I V vi IV","key":"G","bpm":140,"barsPerChord":1,"repeats":2,"seed":5}
{"action":"music","style":"ambient","progression":"Am F C G","bpm":70,"barsPerChord":2}
```
- Progressions as roman numerals in the key (`I V vi IV`, `i VI III VII` with `scale: "minor"`, `ii7 V7 Imaj7`) or chord names (`Am F C G`, `Dm7 G7 Cmaj7`, `Bb`, `F#m`). Scales: major, minor, dorian, mixolydian, pentatonic, harmonic.
- chiptune: square lead (a melody in two-bar phrases, A A' B A''), a 12.5% square arpeggio, triangle bass, noise drums (kick, snare, hats). ambient: slow pads, a sub bass, a sparse bell melody, echoes.
- The loop is seamless: notes and echoes that ring past the end wrap to the start. Length = chords x barsPerChord x repeats bars. Loop it in the engine with no gap (Godot: the WAV's import loop mode Forward, or AudioStreamPlayer with the stream's loop on).

## Loudness

SFX are normalized to -14 LUFS, music to -16 LUFS (integrated loudness, ITU-R BS.1770), never past a -1 dBFS peak. Keep a game's sounds consistent by normalizing outside WAVs too: `{"action":"normalize","input":"audio/door.wav","target":-16}`; `{"action":"info","input":"audio/door.wav"}` measures length, peak, RMS, LUFS and clipping. Mix with bus volumes in the engine, not by re-rendering.

## Check

The `audio-valid` gate: every WAV of every audio and music asset parses, is not silent, not clipped, and lasts as long as recorded. Listen where the person can (the desktop plays WAVs); read the waveform otherwise: a sharp attack, a clean tail, no flat-topped (clipped) blocks.
