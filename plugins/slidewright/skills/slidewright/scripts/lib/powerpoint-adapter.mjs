export function buildPowerPointAdapterStatus({ platform, powerPointAvailable, generationAvailable }) {
  const supportedPlatform = platform === "win32";
  const adapterEnabled = supportedPlatform && Boolean(powerPointAvailable);
  return {
    valid: Boolean(generationAvailable),
    adapterEnabled,
    generationEnabled: Boolean(generationAvailable),
    optional: true,
    reason: adapterEnabled
      ? "Direct PowerPoint editing is available."
      : supportedPlatform
        ? "Microsoft PowerPoint is unavailable; generation remains enabled."
        : "Direct PowerPoint editing is Windows-only; generation remains enabled.",
  };
}

export function buildPowerPointAdapterScorecard({ actualStatus, unavailableControl, unavailableGenerationProof, adapterReport }) {
  const optionalGenerationValid = Boolean(
    unavailableControl?.valid
    && unavailableControl?.adapterEnabled === false
    && unavailableControl?.generationEnabled
    && unavailableGenerationProof?.valid
  );
  const c21ProofComplete = Boolean(
    optionalGenerationValid
    && actualStatus?.adapterEnabled
    && adapterReport?.valid
    && adapterReport?.selectionVerified
    && adapterReport?.exactMemberSetPreserved
  );
  return {
    valid: c21ProofComplete,
    c21ProofComplete,
    optionalGenerationValid,
    actualStatus,
    unavailableControl,
    unavailableGenerationProof,
    actualAdapter: adapterReport ?? { skipped: true, reason: actualStatus?.reason },
  };
}
