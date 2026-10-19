const isGeneralAccount = (id) => id === undefined || id === null || id === "";

export function isCarouselAssetInScope(asset, scope) {
  if (!asset?.userId || !scope?.userId) return false;
  if (asset.projectId !== "ttchop2" || scope.projectId !== "ttchop2") return false;
  if (asset.userId !== scope.userId) return false;
  const assetGeneral = isGeneralAccount(asset.accountId);
  const scopeGeneral = isGeneralAccount(scope.accountId);
  return assetGeneral && scopeGeneral || !assetGeneral && !scopeGeneral && asset.accountId === scope.accountId;
}
