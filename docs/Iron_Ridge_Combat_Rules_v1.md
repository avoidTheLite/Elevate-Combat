# Iron Ridge — Ranged Combat Resolution (Draft v1)

Two rolls per attack: **To-Hit (d20)**, then if it connects, **Damage (dice pool)**.
Explosive/HE weapons get a third possible outcome: **Splash**. Facing (front/side/rear) folds straight into both rolls as a modifier — no extra dice.

---

## 1. Target Categories & Base To-Hit Numbers

To-hit difficulty is driven by target *size/exposure*, not armor. Armor is handled entirely in the damage step. This is why a lumbering heavy tank is *easier* to hit than a crouching rifleman.

| Target Category | Direct-Hit TN (flat ground, same elevation, short range) |
|---|---|
| Heavy Armor (tank, bunker, casemate) | 7 |
| Light Armor (halftrack, gun shield, light vehicle) | 10 |
| Unarmored (infantry, crew, soft vehicle) | 15 |

Roll a d20. Meet or beat the final adjusted TN (after range/elevation modifiers below) = hit.

**Tuned from 5 → 7.** At the old value, a tank cannon at its Medium "sweet spot" (+2, see Section 3) only needed a 7 to hit — a 70% shot on a d20, every single turn, forever. That's not a duel, that's a coin flip stacked in one direction. At 7, the same shot needs a 9: still the easiest category to hit by a wide margin (as it should be — a tank is enormous), but no longer a near-guarantee.

---

## 2. Splash Rule (HE weapons only — cannon, mortar, artillery, grenades)

Splash Threshold is a **fixed TN of 10**, independent of the target's category.

| Roll Result | Outcome |
|---|---|
| ≥ Direct-Hit TN | Direct Hit — full damage |
| ≥ 10, but < Direct-Hit TN | Splash Hit — splash damage only |
| < 10 | Miss |

**Design note:** this only matters against Unarmored targets (TN 15) — rolls of 10–14 still land a splash. Against Light Armor (TN 10) the bands coincide, so splash is moot. Against Heavy Armor (TN 5) any hit is already a direct hit, so splash never triggers separately — HE shells don't need a "near miss" against something that big.

Rifles, MGs, and other non-explosive weapons have **no splash tier** — it's a binary hit/miss vs. the Direct-Hit TN.

---

## 3. Range Bands

Look up **Effective Range** (see Section 4 for how elevation folds in) on this table to get the TN modifier. Add it to the target's base TN.

| Range Band | Distance (tiles) | Rifle/MG | AT Gun | Tank Cannon | Indirect (Mortar/Arty) |
|---|---|---|---|---|---|
| Point-Blank | 1 | −5 | −5 | **N/A — cannot fire on adjacent tile** | n/a (min range) |
| Short | 2–3 | +0 | +0 | +0 | +0 |
| Medium | 4–6 | +3 | +2 | +2 | +0 |
| Long | 7–10 | +6 | +4 | +4 | +2 |
| Extreme | 11+ | +10 | +4 | +4 | +4 |

**Design notes:**
- The AT gun keeps the rifle's −5 point-blank bonus — it's a crewed direct-fire weapon that can snap a shot at anything next to it. The tank cannon physically can't depress/traverse fast enough to engage an adjacent tile, so it's locked out of point-blank entirely rather than just losing the bonus.
- Medium range is the cannon "sweet spot" for both AT gun and tank cannon — same +2 as the baseline, no extra bonus yet, but nothing degrades it either.
- Extreme has been flattened to match Long (+4 for both AT gun and tank cannon) rather than continuing to climb — cannons don't lose accuracy at max range the way small arms do.
- **Open question flagged for later:** AT gun and tank cannon are currently identical everywhere except point-blank. If we want the tank to out-range the AT gun (or vice versa), Long/Extreme is where that split should happen — e.g. tank cannon could hold +4 at Extreme while AT gun degrades to +6, or the reverse if AT guns are the specialist long-range killers in this setting.

---

## 4. Elevation Adjustment

At equal elevation, distance alone drives the range band — exactly as you specified.

**Effective Range = Horizontal Distance + (Elevation Delta × 2)**, where Elevation Delta only applies when the shooter is firing **uphill** (target higher than shooter). Firing downhill uses horizontal distance only — no penalty, no bonus. This keeps high ground as a pure defensive/spotting advantage rather than double-dipping it into the accuracy math too.

| Elevation Levels Uphill | Added to Effective Range |
|---|---|
| +1 | +2 tiles |
| +2 | +4 tiles |
| +3 | +6 tiles |

This is linear/additive per your note — easy to re-tune to a steeper curve later (e.g. squared) without touching anything else in the system, since it only feeds the single Effective Range number.

**Worked example:** Rifle at horizontal distance 3, target 2 elevation levels higher → Effective Range = 3 + (2×2) = 7 → Long range band → +6 TN. What would've been a Short-range shot (+0) becomes a Long-range shot (+6) purely from the climb.

---

## 5. Line of Sight & Indirect Fire

- **Direct-fire weapons** (rifles, MGs, tank/AT cannons) require unobstructed LOS to the target tile. Ridgelines and terrain block per the height-map rules (as on Map-01).
- **Indirect-fire weapons** (grenades, mortars, artillery) do **not** need LOS to the target, but need one of:
  - A friendly spotter with LOS to the target and within spotting range → fires normally.
  - No spotter, known/guessed coordinates only → **Blind Fire**: +6 TN penalty, and the splash tier collapses into the Direct-Hit TN (no free "near miss" band).

---

## 6. Tank Gun Depression (Downward Fire Arc)

Fixed low-mount barrels cap depression at a conservative 33°, which on the integer height grid becomes:

**Max Elevation Drop = ⌊Horizontal Distance ÷ 3⌋**

If (Shooter Elevation − Target Elevation) exceeds this, the target is in the tank's **dead zone** — no direct fire is possible regardless of to-hit roll. The tank must reposition, or the target must be handled by infantry or indirect fire.

*Example:* Tank 3 tiles from a target 2 levels lower → Max Drop = ⌊3/3⌋ = 1. Actual drop is 2, which exceeds 1 → out of arc, can't fire.

| Horizontal Distance | Max Elevation Drop Allowed |
|---|---|
| 1–2 | 0 |
| 3–5 | 1 |
| 6–8 | 2 |
| 9–11 | 3 |

---

## 7. Damage Pools

Rolled only after a successful To-Hit (direct or splash).

| Weapon | Direct Damage | Splash Damage | Splash Radius |
|---|---|---|---|
| Rifle | 1d6 | — | — |
| Light MG | 1d6+1 | — | — |
| AT Gun / Light Tank Cannon | 2d6+2 | 1d6 | 1 |
| Heavy Tank Cannon | 3d6+3 | 2d6 | 1 |
| Mortar | 2d6+1 | 2d6+1 | 1–2 (by caliber) |
| Artillery | 3d8+4 | 3d8 | 2+ |
| Grenade | 2d4 | 2d4 | 1 |

Your reference case checks out: 2d6+2 ranges from **4 to 14** — full spread of outcomes on the same roll type.

**Armor** subtracts flat from the damage total after rolling (minimum 0 damage):

| Target Category | Armor Rating |
|---|---|
| Unarmored | 0 |
| Light Armor | 3 |
| Heavy Armor | 6 |

### 7a. Facing (Front / Side / Rear)

No extra roll, no separate armor table — facing is just a modifier you apply to the To-Hit and Damage numbers you're already rolling, based on which arc the shot is coming through.

| Facing Attacked | To-Hit TN Modifier | Damage Modifier |
|---|---|---|
| Front | +2 (harder to hit) | −2 |
| Rear | +1 (harder to hit) | +2 |
| Side | −1 (easier to hit) | +0 |

The logic: a glacis-sloped front is the hardest angle to line up a shot on *and* the most likely to deflect the round even when it connects — that's the whole "doesn't usually destroy it" effect, now baked straight into the numbers instead of needing a separate penetration roll. Side armor is a big flat easy target with no special deflection either way. Rear is trickier to line up than the side (tanks don't expose it often, and a moving/turning target can be awkward to catch square-on from behind) but the armor back there is thin, so a rear hit that lands does real damage.

**Front damage modifier is a placeholder** — you flagged this as "figure out later," and −2 here is just a starting number that mirrors the +2 To-Hit penalty for a memorable, symmetric table. Easy to push further negative once you've playtested a few rounds and have a feel for how bouncy you want frontal engagements to be.

This applies to Light and Heavy Armor targets. Unarmored targets don't have a meaningful "armored facing" — leave facing modifiers off infantry for now unless you want to model ambush/flanking bonuses separately later.

### 7b. Movement & Firing State

Moving costs accuracy, holding still earns it:

| Firing State | TN Modifier |
|---|---|
| Braced (did not move this turn) | −2 |
| Moved, then fired | +3 |

Stacks with everything else (range, elevation, facing). Applies to any crewed direct-fire weapon with mobility — tanks and AT guns primarily.

---

## 8. Turn Sequence Summary (for the table)

1. Apply tank depression check (Section 6) *first* for any tank direct-fire shot at a lower target — this can rule the shot out entirely.
2. Confirm LOS (direct) or spotter status (indirect). No LOS/spotter and not an indirect weapon → attack is illegal.
3. Compute Effective Range (horizontal + uphill elevation penalty, Section 4).
4. Look up Range Band TN modifier (Section 3) and add to target's base TN (Section 1).
5. Apply Movement/Braced modifier (7b) and, against armored targets, the Facing TN modifier (7a).
6. Roll d20. Compare to adjusted TN (and Splash Threshold of 10 if HE).
7. On hit, roll the damage pool (Section 7), subtract target's Armor Rating, then apply the Facing damage modifier (7a) if the target is armored.

---

## Open Questions / Tuning Knobs

- Elevation penalty currently linear (×2 per level). Could go quadratic for steeper "sniper's nest" feel at high delta.
- Downhill currently gets zero accuracy bonus — worth playtesting whether that undersells the high-ground payoff versus just spotting/LOS.
- Blind fire penalty (+6) is a placeholder — untested against how often spotters will realistically be in range on Map-01-scale boards.
- No cover modifiers yet (separate discussion) — this system assumes open ground; cover should stack as an additional TN modifier once we lock that system.
- Heavy Armor base TN moved 5 → 7; worth a few playtest rounds to confirm hit rates feel right rather than just eyeballing the math.
- Front damage modifier (7a) is an explicit placeholder (−2) — mirrors the To-Hit penalty for memorability, but the real number should come from playtesting how often frontal shots "bounce" versus reaching a kill.
- Facing TN/damage magnitudes (+2/+1/−1 and −2/+0/+2) are first-pass guesses — no play data yet on whether flanking is exactly as decisive as intended.
- Facing currently only applies to Light/Heavy Armor. Worth revisiting whether infantry should get a lesser version (e.g. a small rear-attack damage bonus for ambush/flanking) once cover rules are in place.
