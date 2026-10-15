import test from "node:test";
import assert from "node:assert/strict";
import { isCarouselAssetInScope } from "../pipeline/carouselAssetScope.js";

const scoped = (overrides = {}) => ({ projectId: "ttchop2", userId: "user-1", accountId: "account-1", ...overrides });

test("strictly matches project, user, and account", () => {
 assert.equal(isCarouselAssetInScope(scoped(), scoped()), true);
 for (const projectId of [undefined, null, "", "ttchop", "TTCHOP2"]) { assert.equal(isCarouselAssetInScope(scoped({projectId}), scoped()), false); assert.equal(isCarouselAssetInScope(scoped(), scoped({projectId})), false); }
 for (const userId of [undefined, null, "", "user-2"]) { assert.equal(isCarouselAssetInScope(scoped({userId}), scoped()), false); assert.equal(isCarouselAssetInScope(scoped(), scoped({userId})), false); }
 assert.equal(isCarouselAssetInScope(scoped({accountId: "account-2"}), scoped()), false);
 assert.equal(isCarouselAssetInScope(scoped(), scoped({accountId: "account-2"})), false);
});

test("matches only absent, null, or empty account IDs as general container", () => {
 const general = [undefined, null, ""];
 for (const a of general) for (const b of general) assert.equal(isCarouselAssetInScope(scoped({accountId:a}), scoped({accountId:b})), true);
 for (const a of general) { assert.equal(isCarouselAssetInScope(scoped({accountId:a}), scoped()), false); assert.equal(isCarouselAssetInScope(scoped(), scoped({accountId:a})), false); }
});
