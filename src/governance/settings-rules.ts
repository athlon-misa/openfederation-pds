/**
 * What a community's governance settings are allowed to say (#198).
 *
 * These predicates used to live inside `setGovernanceModel`, which was fine
 * while that endpoint was the only way to change the governance model. It is no
 * longer: a change to `net.openfederation.community.settings` under a voting
 * model now goes through a proposal, and a proposal applies its
 * `proposedRecord` verbatim. So the validation has to live where both routes
 * can reach it — and both routes have to use it, or the governed route becomes
 * the unvalidated one.
 *
 * The failure this guards against is not cosmetic. `enforceGovernance` switches
 * on the model string; a settings record naming a model nobody recognizes
 * (`simple_majority`, `plutocracy`) would leave the community with no governance
 * at all, every protected collection directly writable, applied by a quorum that
 * thought it was voting for something else. `enforcement.ts` refuses unknown
 * models as a backstop; this is the fix.
 */

export const VALID_GOVERNANCE_MODELS = ['benevolent-dictator', 'simple-majority', 'on-chain'] as const;

/** Models whose changes to protected collections are decided from vote records. */
export const VOTING_MODELS = ['simple-majority', 'on-chain'] as const;

export const SETTINGS_COLLECTION = 'net.openfederation.community.settings';

/** Collections that MUST always be protected — cannot be removed from governance. */
export const MANDATORY_PROTECTED_COLLECTIONS = [
  SETTINGS_COLLECTION,
  'net.openfederation.community.role',
];

export interface SettingsProblem {
  message: string;
}

/** A usable CAIP-2 chain id: a non-empty string. Empty is absent, not a value. */
function isChainId(value: unknown): value is string {
  return typeof value === 'string' && value.trim().length > 0;
}

function isVotingModel(model: string): boolean {
  return (VOTING_MODELS as readonly string[]).includes(model);
}

/**
 * Validation shared by every model that resolves proposals from vote records.
 * `on-chain` is that same governance plus anchoring, so it answers to the same
 * rules rather than to a parallel set of its own.
 *
 * Normalizes `protectedCollections` in place when `normalize` is set: the
 * mandatory entries are added back, and bare names are qualified.
 */
function checkVotingConfig(
  governanceConfig: any,
  requireQuorum: boolean,
  normalize: boolean,
): SettingsProblem | null {
  if (requireQuorum) {
    if (!governanceConfig.quorum || typeof governanceConfig.quorum !== 'number' || governanceConfig.quorum < 1) {
      return { message: 'governanceConfig.quorum must be a positive integer' };
    }
    if (!governanceConfig.voterRole || typeof governanceConfig.voterRole !== 'string') {
      return { message: 'governanceConfig.voterRole is required' };
    }
  } else if (governanceConfig.quorum !== undefined
    && (typeof governanceConfig.quorum !== 'number' || governanceConfig.quorum < 1)) {
    return { message: 'governanceConfig.quorum must be a positive integer' };
  }

  // The contest window a passed proposal waits out before its change is
  // applied. Optional: absent means the default (see `timelockHours` in
  // decision-rules.ts). Instant application has to be asked for by name.
  if (governanceConfig.timelockHours !== undefined) {
    const hours = governanceConfig.timelockHours;
    if (typeof hours !== 'number' || !Number.isFinite(hours) || hours < 0) {
      return {
        message: 'governanceConfig.timelockHours must be a non-negative number of hours (0 applies changes immediately)',
      };
    }
  }

  // How many countable objections hold a decided change. Optional: absent means
  // the default of 1 (see `objectionThreshold` in decision-rules.ts), under
  // which a single eligible objector holds the change indefinitely.
  if (governanceConfig.objectionThreshold !== undefined) {
    const threshold = governanceConfig.objectionThreshold;
    if (typeof threshold !== 'number' || !Number.isInteger(threshold) || threshold < 1) {
      return {
        message: 'governanceConfig.objectionThreshold must be a positive integer '
          + '(1, the default, means a single eligible objection holds the change)',
      };
    }
  }

  if (governanceConfig.protectedCollections !== undefined) {
    if (!Array.isArray(governanceConfig.protectedCollections)) {
      return { message: 'protectedCollections must be an array' };
    }
    if (governanceConfig.protectedCollections.some((c: unknown) => typeof c !== 'string')) {
      return { message: 'protectedCollections must contain only collection name strings' };
    }
    const qualified = governanceConfig.protectedCollections.map((c: string) =>
      c.startsWith('net.openfederation.community.') ? c : `net.openfederation.community.${c}`
    );
    for (const mandatory of MANDATORY_PROTECTED_COLLECTIONS) {
      if (!qualified.includes(mandatory)) {
        if (!normalize) {
          return { message: `protectedCollections must include ${mandatory}` };
        }
        qualified.push(mandatory);
      }
    }
    if (normalize) governanceConfig.protectedCollections = qualified;
  }

  return null;
}

/**
 * Anchoring is a plain setting, not a mode. It says which notary to publish
 * decisions to, never who decides them.
 */
function checkAnchoring(governanceConfig: any): SettingsProblem | null {
  const anchoring = governanceConfig.anchoring;
  if (anchoring === undefined) return null;
  if (!anchoring || typeof anchoring !== 'object' || Array.isArray(anchoring)) {
    return { message: 'governanceConfig.anchoring must be an object with { enabled, chainId }' };
  }
  if (typeof anchoring.enabled !== 'boolean') {
    return { message: 'governanceConfig.anchoring.enabled must be a boolean' };
  }
  if (anchoring.chainId !== undefined && typeof anchoring.chainId !== 'string') {
    return { message: 'governanceConfig.anchoring.chainId must be a CAIP-2 chain id string' };
  }
  if (anchoring.enabled && !anchoring.chainId && !isChainId(governanceConfig.chainId)) {
    return { message: 'governanceConfig.anchoring.chainId is required when anchoring is enabled' };
  }
  return null;
}

/**
 * Check the governance half of a settings record — the model and its config.
 *
 * Returns the first problem found, or `null` when the settings are coherent. A
 * record with no `governanceModel` is `benevolent-dictator`, which is what
 * `enforceGovernance` assumes, so it is valid.
 *
 * `normalize` (used on the authoring paths, not the apply-time backstop)
 * rewrites `protectedCollections` in place to add the mandatory entries; with it
 * off, a config that omits them is rejected rather than silently repaired.
 */
export function checkGovernanceSettings(
  settings: { governanceModel?: unknown; governanceConfig?: unknown },
  options: { normalize?: boolean } = {},
): SettingsProblem | null {
  const normalize = options.normalize === true;

  // A proposal's config is a merge patch, not a whole object (#202): `null`
  // means "remove this key". Validating a null as if it were a value would
  // reject a perfectly good proposal to drop one — so strip the removals and
  // judge what will actually remain. Apply time validates the merged record, so
  // the result is still checked in full before anything is written.
  settings = stripRemovals(settings);

  const model = settings.governanceModel ?? 'benevolent-dictator';

  if (typeof model !== 'string' || !(VALID_GOVERNANCE_MODELS as readonly string[]).includes(model)) {
    return { message: `governanceModel must be one of: ${VALID_GOVERNANCE_MODELS.join(', ')}` };
  }

  const config = settings.governanceConfig;

  if (isVotingModel(model)) {
    if (!config || typeof config !== 'object' || Array.isArray(config)) {
      return {
        message: model === 'simple-majority'
          ? 'governanceConfig is required for simple-majority (quorum, voterRole)'
          : 'governanceConfig is required for on-chain (chainId, and the quorum config governance runs on)',
      };
    }

    // `simple-majority` has always had to state its quorum. `on-chain` did not,
    // because it did not use one; it does now, so an unstated quorum falls back
    // to the same default resolution applies rather than breaking communities
    // configured under the old meaning.
    const invalid = checkVotingConfig(config, model === 'simple-majority', normalize);
    if (invalid) return invalid;

    // The one thing `on-chain` still needs: somewhere to anchor. Not an Oracle
    // credential — an Oracle is a way of carrying authority into a request, not
    // a precondition for a community deciding its own affairs.
    // Empty counts as absent. An `on-chain` community with `chainId: ''`
    // resolves to anchoring disabled, which is an on-chain community that
    // silently never anchors — the one failure this model exists to make
    // visible.
    if (model === 'on-chain' && !isChainId((config as any).chainId)) {
      return { message: 'governanceConfig.chainId is required' };
    }
  }

  if (config && typeof config === 'object' && !Array.isArray(config)) {
    const invalid = checkAnchoring(config);
    if (invalid) return invalid;
  }

  return null;
}

/**
 * Drop `governanceConfig` keys set to `null`.
 *
 * Those are removals under the merge-patch semantics `recordToWrite` applies,
 * so they describe what will be *absent* after the merge. Validating them as
 * values would reject a proposal whose only fault is asking for a key to go.
 */
function stripRemovals<T extends { governanceModel?: unknown; governanceConfig?: unknown }>(settings: T): T {
  const config = settings.governanceConfig;
  if (!config || typeof config !== 'object' || Array.isArray(config)) return settings;
  const entries = Object.entries(config as Record<string, unknown>);
  if (!entries.some(([, v]) => v === null)) return settings;
  return {
    ...settings,
    governanceConfig: Object.fromEntries(entries.filter(([, v]) => v !== null)),
  };
}
