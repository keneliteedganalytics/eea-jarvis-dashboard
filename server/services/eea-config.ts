// Shared EEA configuration: default figure weights + the v1 persona seed.
// Persisted into formula_versions on first boot.

export const DEFAULT_WEIGHTS = {
  // EEAS composite speed
  eeas: {
    brisnet_speed: 0.6,
    equibase_speed: 0.4,
    agreement_bonus: 2,
    disagreement_flag: -3,
    agreement_threshold: 3,
    disagreement_threshold: 8,
  },
  // EEAP composite pace
  eeap: {
    brisnet_e1: 0.25,
    brisnet_e2: 0.3,
    brisnet_lp: 0.25,
    equibase_pace_sanity: 0.2,
  },
  // EEAC composite class
  eeac: {
    brisnet_class: 0.5,
    equibase_class_avg3: 0.35,
    purse_band_overlay: 0.15,
  },
  // EEA Rating
  rating: { eeas: 0.5, eeap_fit: 0.3, eeac: 0.2 },
  // Class-aware adjusters
  classAware: {
    stakes_graded: { class_weight: 1.2, speed_weight: 1.0, form_weight: 0.8 },
    allowance: { class_weight: 1.0, speed_weight: 1.0, form_weight: 1.0 },
    claimer: { class_weight: 0.8, speed_weight: 1.0, form_weight: 1.2 },
    msw: {
      class_weight: 1.0,
      speed_weight: 0.6,
      form_weight: 0.4,
      breeding_weight: 1.5,
      works_weight: 1.5,
    },
  },
  // Layoff thresholds (days)
  layoff: {
    claimer: { normal_min: 14, normal_max: 21, needs_pattern_above: 30 },
    allowance: { normal_min: 21, normal_max: 35, needs_pattern_above: 45 },
    stakes_graded: { normal_min: 42, normal_max: 56, needs_pattern_above: 70 },
  },
  // Tier sizing as % of daily risk cap (3% of bankroll)
  tierSize: { SNIPER: 0.35, EDGE: 0.2, DUAL: 0.12, RECON: 0.08, PASS: 0 },
  dailyRiskCapPct: 0.03,
  // SNIPER gap requirement: EEA Rating must clear 2nd-best by this much.
  sniperGap: 4,
  // Weather factor (PR #18). Applied ONLY when surfaceImpact ∈ {wet,sloppy,muddy}
  // and we have real data — never on "unknown". All values are EEA-Rating points.
  weather: {
    // Per-point boost to a horse's rating, scaled by its wet-track win % (0-100)
    // and the surface severity. mudderBoostMax is the cap at 100% wet win on the
    // worst (muddy) surface.
    mudderBoostMax: 4,
    // Turf rained on: shave raw turf speed emphasis, since turf plays radically
    // different wet. Applied as a rating penalty on the speed term for turf races.
    turfSpeedPenalty: 3,
    // Sloppy dirt flattens pace advantages: small boost to closers (low EEAP
    // relative to field) and a small trim to pure speed types. Kept light.
    closerBias: 1.5,
    // Severity multipliers by surface (scales mudderBoost + closerBias).
    severity: { wet: 0.5, sloppy: 0.8, muddy: 1.0 },
  },
  // Bloodstock factor (PR #16 Phase 2). Sire/dam/damsire aptitude turned into a
  // small EEA-Rating bias. Composite weights are the documented initial guess;
  // tune via this config (the tier classifier is untouched).
  bloodstock: {
    // Composite = weighted blend of the four sub-fits. Must roughly sum to 1.
    weights: {
      surface: 0.45, // sire surface aptitude for today's surface (turf/dirt)
      distance: 0.3, // sire/damsire sprint-vs-route match to the distance bucket
      wet: 0.15, // sire + damsire off-track aptitude (only counts on wet surf)
      firstTimer: 0.1, // pedigree-leans-harder bonus for <3-start horses
    },
    // Bayesian shrinkage toward the league prior. A rate r observed over n
    // starters is shrunk to:  (n*r + k*PRIOR) / (n + k).  k is the prior weight
    // in "pseudo-starters": with k=20, a sire needs ~20 starters before its own
    // rate dominates the 13% league mean. PRIOR is a realistic win-rate floor.
    leaguePriorPct: 13,
    shrinkageK: 20,
    // <3 lifetime starts → first-timer bonus eligible; the bonus scales with
    // composite quality up to firstTimerBonusMax (0-15 scale per the spec).
    firstTimerStartsCutoff: 3,
    firstTimerBonusMax: 15,
    // Confidence thresholds: how many of {sire, damsire} aptitude signals we
    // recognize for THIS race context. 0 → none (never bias), 1 → low/medium,
    // 2 → high. Distance signal is always derivable, so it never alone lifts
    // confidence above low.
    // ── Fusion application (consumed in eea-fusion.ts) ──────────────────────
    // Normal bias is centered on the composite's distance from a neutral 50 and
    // capped at ±maxBiasPoints EEA-Rating points. First-timers with confidence
    // ≥ medium instead treat the composite as firstTimerRatingWeight of rating.
    maxBiasPoints: 3,
    firstTimerRatingWeight: 0.4,
    // Wet interaction with PR #18 surfaceImpact: on an off track, a strong wet
    // pedigree boost is multiplied by wetBoostMultiplier (≈ double); a weak wet
    // pedigree takes a modest penalty up to wetPenaltyMax points.
    wetBoostMultiplier: 2.0,
    wetPenaltyMax: 1.5,
    wetStrongComposite: 60, // wetFit ≥ this counts as a "strong" wet pedigree
    wetWeakComposite: 35, // wetFit ≤ this counts as a "weak" wet pedigree
  },
};

export type EeaWeights = typeof DEFAULT_WEIGHTS;

export const PERSONA_V1 = `You are Jarvis, the analytical engine for Elite Edge Analytics. Kenneth Young is a professional horseplayer based in Idaho Falls. You analyze races like a veteran handicapper who treats this as a business — not a hobby. Your reasoning must be conservative, evidence-first, and class/pace-driven.

FRAMEWORK (apply in order):
1. PACE FIRST. Identify the pace scenario — lone speed, contested pace, honest pace, slow pace. The pace shape dictates who benefits. Cross-reference with the bias card from yesterday's track.
2. CLASS LENS. Is this horse running into a class that has historically beaten it? Class drops in claimers are routine — class rises require evidence (figure improvement, trainer pattern, jockey upgrade).
3. FORM CYCLE. Is the horse in shape? Look at last 3 lines, layoff vs class norms (claimers normal 14-21 days, stakes/graded 42-56 days). Long layoffs in cheap races without a trainer-off-layoff stat are a red flag.
4. CONNECTIONS. Trainer angles, jockey/trainer combo, trainer off-claim stats. Hot-stable + live jockey adds confidence.
5. BREEDING & WORKS (maidens). For MSW, sire's first-time-starter %, dam's produce, bullet works, gate works, sales price, workmate.

TIER ASSIGNMENT (hard caps):
- SNIPER: 1 per card max. EEA Rating ≥ 4 above 2nd best. Strong pace fit AND class fit AND form. PASS is legitimate — if no horse qualifies, no SNIPER.
- EDGE: top horse with clear edge but not commanding.
- DUAL: two horses to use exotically.
- RECON: maiden default; or small-edge spots.
- PASS: when nothing rates. Always an acceptable answer.

OUTPUT FORMAT (strict — must validate against schema):
- Executive Race Summary (3-5 sentences: pace shape, key class angle, bias note)
- Top 4 horses ranked, each with:
  - Why bullets (3-5 short, specific, evidence-cited)
  - Pace Matchup (1-2 sentences on how this horse fits the projected shape)
- Betting Strategy (tier + suggested wagers — WIN/PLACE/SHOW/exotics)
- Tier (SNIPER | EDGE | DUAL | RECON | PASS)

NON-NEGOTIABLES:
- Do not invent figures. Use only what's in the structured payload.
- Do not assign SNIPER unless gap criteria met.
- "PASS" is a complete, professional answer when the card doesn't offer edge.
- Be concise. Kenneth is reading 8-12 cards a day.`;
