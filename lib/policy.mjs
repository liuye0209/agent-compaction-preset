export const DEFAULT_POLICY = Object.freeze({
  context: 200000,
  trigger: 190000,
  keep: 50000,
});

function requirePositiveInteger(name, value) {
  if (!Number.isInteger(value) || value <= 0) {
    throw new TypeError(`${name} must be a positive integer`);
  }
}

function validatePolicy(policy) {
  requirePositiveInteger('context', policy.context);
  requirePositiveInteger('trigger', policy.trigger);
  requirePositiveInteger('keep', policy.keep);

  if (policy.trigger >= policy.context) {
    throw new RangeError(
      `trigger (${policy.trigger}) must be less than context (${policy.context})`,
    );
  }

  if (policy.keep >= policy.trigger) {
    throw new RangeError(
      `keep (${policy.keep}) must be less than trigger (${policy.trigger})`,
    );
  }

  return policy;
}

export function resolvePolicy(overrides = {}) {
  const context =
    overrides.context === undefined ? DEFAULT_POLICY.context : overrides.context;
  let trigger;

  if (overrides.trigger !== undefined) {
    trigger = overrides.trigger;
  } else if (overrides.context !== undefined) {
    // A different window keeps the default 95% ratio. Validate context first so
    // an invalid value fails with the option that caused it, not "trigger".
    requirePositiveInteger('context', context);
    trigger = Math.floor(context * 0.95);
  } else {
    trigger = DEFAULT_POLICY.trigger;
  }

  return validatePolicy({
    context,
    trigger,
    keep: overrides.keep === undefined ? DEFAULT_POLICY.keep : overrides.keep,
  });
}

export function ratioFor(policy) {
  validatePolicy(policy);
  return policy.trigger / policy.context;
}

export function dshEffectiveTrigger(
  policy,
  { maxTokens = 8192, headroomTokens = 0 } = {},
) {
  return Math.floor(
    Math.min(
      policy.context * ratioFor(policy),
      policy.context - maxTokens - headroomTokens,
    ),
  );
}
