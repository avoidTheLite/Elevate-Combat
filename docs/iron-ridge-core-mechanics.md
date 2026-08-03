# Iron Ridge — Core Mechanics Reference

Working design document capturing locked and in-progress rules for prototype implementation. Companion file: `iron-ridge-units.json` (unit stats, damage types, armor classes).

## Design Pillars

- Elevation is a first-class mechanic, not a stat modifier. Terrain height drives line-of-sight, movement cost, and combat outcomes directly.
- Turn-based/RTS hybrid combining a strategic campaign layer with a tactical battle layer.
- The two layers should reinforce each other in both directions: strategic decisions set up tactical battles, and tactical outcomes feed back into durable strategic assets (not just abstract stat bonuses).
- High-ground advantage is mutual — exposure logic cuts both ways, creating genuine tactical tension rather than one-sided bonuses.
- Two test eras (medieval, WW2) validate that core systems work independent of unit skin. See `iron-ridge-units.json` for unit rosters.

---

## Map & Terrain

- Core data structure: integer height map `HM[row][col]`, discrete integer elevation values (Map-01 test range: 0–8).
- Terrain drives: line-of-sight blocking, movement cost tiers, ranged combat penalties/bonuses, indirect-fire arc clearance.
- Direct-fire units (rifles, cannons) can be blocked by ridgelines; indirect-fire/lobbed units (catapults, mortars, artillery) can arc over blocking terrain.
- Spotter mechanic: indirect-fire units require a spotter with line of sight to the target to enable fire — ties fog-of-war/vision directly to combat capability.
- Movement cost should use real per-tile terrain cost tiers consistently across all systems (deployment range, unit movement, escort logic) rather than flat distances.

## Camera & Views

- Default: birds-eye RTS pan (WASD), Q/E rotation, scroll zoom.
- Firing view: high-angle behind-unit perspective with a color-coded trajectory arc — green = clear, red = clipped, amber = marginal.
- Training-mode aesthetic (Neon Punk/Tron): black void background, glowing cyan wireframe terrain, geometric neon unit silhouettes, light-trail projectiles, monospace terminal HUD, calm synthetic-voice AI narration. Wireframe chosen deliberately — teaches terrain geometry better than realistic art. Distinct visual identity from the main game's wartime look.

---

## Two-Layer Loop: Strategic ↔ Tactical

**Design goal:** avoid the Total War failure mode where campaign turns become bookkeeping to rush through and battles become a chore to auto-resolve. The two layers should compete for player *attention*, not fight each other for relevance.

- Strategic layer = stakes generator: decides which battles matter, what advantages carry in (pre-positioned fortifications, spotter networks, supply status).
- Tactical layer = decision-dense, kept short. Battle length should track decision density, not unit count — small unit counts with real elevation puzzles beat large battles with idle marching.
- Auto-resolve exists as a deliberate escape valve for low-stakes engagements (formula-based on terrain + fortification + force ratio). Manual battles reserved for meaningful chokepoints or player-chosen fights.
- Campaign turns must stay fast relative to battle length, or players will avoid battles to keep pace.
- **Tactical → Strategic feedback is a core design goal, not an afterthought.** Contested territory should generally require an actual battle — deploy troops and engineers, take the ground — rather than resolving purely on the map. This is what makes territory control feel earned rather than automatic.

---

## Fortification System

Two fortification paths exist and are meant to be genuinely different tools, not one strictly better than the other.

### Strategic-layer fortification
- Built during peacetime campaign turns via Command Points (CP).
- Player acts as commander-in-chief: allocates resources/materials to a sector, does not hand-place individual structures.
- Reliable but generic — doesn't know the enemy's actual axis of attack.

### Tactical-layer fortification (engineers)
- Requires an engineer unit occupying a deployment slot (trade-off: fewer combat units in that slot).
- Precise placement, informed by the terrain actually being fought over.
- Requires action points during the battle to dig in — fortification quality is tied to *how* the battle was fought (a 3-turn win leaves less time to entrench than an 8-turn grind).
- Engineers are vulnerable while working — undefended engineers on a forward position are a target. Protecting engineers is a tactical sub-goal.

### Upgrade path
- Battlefield fortifications built by engineers persist and become strategic-layer assets when territory is held uncontested — the strategic layer can upgrade hasty entrenchments into permanent works over time.
- Fortifications should be legible directly on the height map / terrain overlay (trench lowers exposure at specific cells, sandbags add cover to a tile, spotter nest adds permanent vision at a hex) rather than abstracted into a flat "+2 defense" stat.
- Contested/recaptured territory: fortifications degrade or flip based on current holder rather than vanishing instantly.

### Placement categories

Every piece of equipment/fortification falls into one of four categories, tracked per-unit in the unit schema as `placementCategory`:

| Category | Placed when | Placed by | Notes |
|---|---|---|---|
| **automatic** | Strategic layer, standing garrison work | Commander-in-chief (abstracted) | Always present, including under surprise attack. Static infrastructure (walls, bunkers, pillboxes, minefields, wire). |
| **warned** | Pre-battle, if defender had warning | Field commander, via range-and-time-gated setup | Requires real movement points from the deployment zone, scaled by turns of warning, hard-capped regardless of warning length. Collapses toward zero under surprise attack. |
| **combat_fixed** | Live, during the tactical battle | Field commander | Cannot reposition once placed (MG nest set up, engineer-dug trench). Never gets a pre-placement bonus, warned or not — always reactive. |
| **combat_mobile** | Live, during the tactical battle | Field commander | Moves with the unit as part of normal movement/action economy. Flexible but never reaches the optimization of a fixed emplacement in the same slot. This is the deliberate trade-off for a mobile MG team vs. a static one. |

### Warned-category range mechanic
- Defender's placement range for warned-category items = real movement points from the deployment zone on the actual tactical map, scaled by number of warning turns.
- Range is hard-capped regardless of warning duration, to prevent unlimited pre-fortification.
- Enemy attack origin/axis is **not** revealed during setup — placement is informed by general threat direction only, simulating that this prep "should have already happened" rather than being a perfect read of the incoming attack.
- Surprise attack: warned-category placement collapses to minimal/zero range; automatic-category items are unaffected (already standing); combat-only categories are unaffected in rules but the field commander has less map information going in.

### Command Points (CP)
- Single unified resource governing both fortification spend and combat deployment — no separate currencies to balance against each other.
- Flat base cost to open a deployment, plus additive cost per unit/asset included (example given: 10 CP base + 5 CP per engineer squad = 15 CP total), regardless of whether those assets end up used in combat.
- Sunk-cost risk is intentional: CP spent fortifying a position that's never attacked is effectively lost. This is the core economic tension — balancing defense investment against offense investment and the risk of guessing wrong on where the enemy will strike.
- Heavy fortification also functions as a visible deterrent — an enemy scouting a heavily prepared sector may choose to attack elsewhere.

---

## Damage Type System

Three damage types, shared across both eras. Effectiveness is currently qualitative (high/medium/low/none); numeric multipliers are a pending follow-up once point-budget formulas are set. Full detail lives in `iron-ridge-units.json` under `damageTypes`.

| Type | vs Unarmored | vs Light Armor | vs Heavy Armor | vs Fortification | Variance |
|---|---|---|---|---|---|
| Piercing | Medium | High | Low | None | Low |
| Non-Piercing | High | Low | None | None | Low |
| Siege | Low | High | High | High | High |

- **Combat resolution is derived, not hand-authored per unit pair.** Look up `damageTypes[attacker.damageType].effectiveness[defender.armorClass]`. This is what produces correct asymmetric outcomes — e.g. a tank (siege/heavy_armor) beats rifle infantry (non_piercing/unarmored) primarily because the infantry's weapon does ~none against heavy armor, not because the tank's own weapon is especially effective against unarmored targets (it isn't — siege type is weak and high-variance there).
- **Siege is the only damage type that can damage fortifications.** This applies to both catapults (medieval) and rockets/mortars/artillery/tank-and-AT-gun rounds (WW2) — they're mechanically the same family (siege) even though flavored differently (concussive vs. explosive).
- **Variance/probability, not flat scalars, for siege-vs-unarmored.** A shell landing near infantry should mostly do little and occasionally be near-total-loss, rather than a predictable partial-damage tick. Small arms (non_piercing, piercing) stay low-variance/predictable, modeling attrition and suppression rather than gambling.
- **Balance goal, not yet resolved:** avoid a tank-always-beats-AT-gun outcome purely from raw combat math. The intended trade-off is mobility/exposure (AT Gun is static and easy to hit; Tank is mobile but not invulnerable), not asymmetric per-shot damage favoring the more expensive unit unconditionally. Needs playtesting once numeric values are set.

## Armor Classes

Three target classes: `unarmored`, `light_armor`, `heavy_armor`. (Fortified structures are handled separately as a map-feature target, not a unit armor class — see damage type table above, `vs_fortification` column.)

---

## Unit Classes (production/role categories)

- **Medieval:** infantry | cavalry | artillery
- **WW2:** infantry | vehicle | artillery

Class dictates general role and (for WW2 vehicles) armor category — not fixed stats. Multiple variants of the same unit type (e.g. several tank models) can exist with different armor/firepower levels within one class.

### Notable per-unit mechanics (see JSON for full detail)
- **Archers (medieval):** first-strike ranged attack before melee closes, offsetting otherwise weak survivability.
- **Horseman (medieval):** speed-based advantage vs. archers (denies volleys) and infantry (charge), countered by spearman's braced-formation bonus.
- **Spearman (medieval):** braced-formation bonus vs. cavalry layered on top of base piercing damage type.
- **Machine Gun (WW2):** suppression mechanic ties into the broader action-economy/exposure system; differentiates from Rifle Infantry via suppression rather than a different damage type.
- **AT Infantry (WW2):** inherits siege-type low/high-variance effectiveness vs. unarmored — reflects low hit probability against dispersed infantry targets despite high per-hit lethality against armor.
- **LAV (WW2):** uses piercing damage type (autocannon), distinct from Tank/AT Gun (siege) — this is what differentiates it as a light-armor specialist rather than a smaller tank. Flagged as a candidate for a future "mechanized infantry" pairing rule (LAV + infantry deployed as a combined package) rather than becoming its own unit type.
- **Artillery (both eras):** only unit type able to damage fortifications; no melee capability; vulnerable to fast flanking units closing distance.

---

## Suppression & Exposure

- High ground advantage is mutual: units on elevated positions gain benefits but are also more exposed/visible, creating genuine risk on both sides of an engagement rather than one-sided dominance.
- Units that fire while exposed can be suppressed — ties into the broader action-economy system (movement/action point costs, mutual exposure logic).
- Siege weapon vulnerability (arriving at a vantage point with no action points remaining to defend itself) is intentional design friction, not something to smooth over.

---

## Movement & Action Economy (in progress, not fully locked)

- Terrain movement cost tiers apply consistently across unit movement, deployment range calculations, and escort logic.
- Siege weapons/mobile artillery have braced-vs-mobile states with a pack-up cost to transition between them.
- Zone-of-control interactions and weather effects on movement are identified as pending design areas, not yet detailed.

---

## Logistics & Supply (placeholder — design pending)

- Managed primarily at the strategic layer, but defensible/interdictable at the tactical layer.
- Roads/connections on the map function as supply lines that can be captured if unfortified or undefended.
- Intended as a key strategic-layer factor beyond troop movement — maintaining supply lines affects reinforcement and resupply capability.
- Full mechanical detail (how cut supply affects units, how contested routes resolve, resupply rates) is intentionally deferred to a future design pass.

---

## Turn Flow (draft, pending player feedback)

**Strategic layer, per turn**
1. Intel/scouting update (adjacency warnings, spotted enemy movement)
2. Player issues orders: troop movement, resource allocation, CP spend on automatic-category fortification, *(placeholder: supply/logistics route allocation)*
3. Automatic-category defenses constructed at held positions
4. Turn resolves; warning clocks tick for sectors now facing possible attack

**Transition — attack triggered**
5. If warning existed: defender gets warned-category placement using real movement-point range scaled by warning turns, hard-capped, with no reveal of actual attack axis. Surprise attack: this step collapses to minimal/none.

**Tactical layer — combat phase**
6. Deployment: field commander takes control; automatic + warned-category defenses already on the map.
7. Combat-only category placed live: fixed items placed once and locked in place; mobile items move with the field commander's forces as part of normal movement.
8. Battle resolves using LOS/spotting/elevation/suppression systems.
9. Resolution: territory control updates; surviving battlefield fortifications flagged for strategic-layer absorption.

**Strategic layer — post-battle**
10. Held territory's battlefield fortifications become upgrade-eligible strategic assets.
11. *(placeholder: supply line status reassessed — cut, contested, or secured)*
12. Loop continues.

---

## Open Design Questions

- Numeric formulas and point-budget values for all damage-type/armor-class effectiveness pairs (currently qualitative only).
- Whether Tank-vs-AT-Gun balance goal (comparable shots-to-kill despite different raw numbers) is achievable without making one unit feel redundant — needs playtesting once numbers exist.
- LAV/mechanized infantry: standalone unit vs. future pairing mechanic — leaning toward starting standalone, adding pairing as a composition rule later.
- Whether warned-category setup should ever grant partial intel on attack axis via strong scouting/spotting, or stay strictly zero until battle start (explicitly deferred by design).
- Time limit (if any) on post-battle fortification upgrade eligibility, or whether it persists until the player spends strategic turns on it.
- Full logistics/supply mechanical design — how interdiction, resupply rate, and cut-supply penalties actually work in both layers.
- Zone-of-control and weather effects on movement — identified but not yet detailed.
- Tech stack for playable implementation (not yet chosen).
- LOS ray-cast algorithm (not yet designed).
- WASD direct-control mode (not yet designed).

---

## Reference: Companion Files

- `iron-ridge-units.json` — full unit schema, damage type matrix, per-unit stats for both eras.
