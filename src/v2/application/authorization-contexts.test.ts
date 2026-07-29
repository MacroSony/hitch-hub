import assert from "node:assert/strict";
import { test } from "node:test";

import type {
  BackgroundServiceAuthorizationComponent,
  TrustedServiceAuthorizationContext,
} from "../model/application.js";
import { SQLiteBootstrapPublicationUnitOfWork } from "../persistence/bootstrap-publication.js";
import { openCanonicalHitchV2Database } from "../persistence/initialize.js";
import { createBootstrapPublicationRecords } from "../test-support/bootstrap-publication.js";
import {
  DeterministicClock,
  DeterministicIdSource,
} from "../test-support/deterministic.js";
import { withDisposableDataRoot } from "../test-support/disposable-data-root.js";
import {
  createFirstSliceAuthorizationTrust,
  ServiceAuthorizationTrustError,
} from "./authorization-contexts.js";

const COMPONENTS = [
  "turn-coordinator",
  "supervisor",
  "broker",
  "delivery",
  "recovery",
] as const satisfies readonly BackgroundServiceAuthorizationComponent[];

test("service authority issuer mints only frozen first-slice background contexts", async () => {
  await withDisposableDataRoot(async (root) => {
    const database = openCanonicalHitchV2Database({
      dataRoot: root.resolve("state"),
    });
    try {
      const trust = createFirstSliceAuthorizationTrust({
        database,
        clock: new DeterministicClock(),
        ids: new DeterministicIdSource("authority"),
      });
      for (const component of COMPONENTS) {
        const context =
          await trust.serviceContextIssuer.forComponent(component);
        assert.ok(Object.isFrozen(context));
        assert.ok(Object.isFrozen(context.actor));
        assert.deepEqual(context, {
          actor: { kind: "system", component },
        });
        assert.deepEqual(trust.contextVerifier.classify(context), {
          kind: "service",
          component,
          context,
        });
      }
      await assert.rejects(
        trust.serviceContextIssuer.forComponent(
          "authorization" as BackgroundServiceAuthorizationComponent,
        ),
        ServiceAuthorizationTrustError,
      );
    } finally {
      database.close();
    }
  });
});

test("authorization context verifier rejects casts, clones, and foreign trust domains", async () => {
  await withDisposableDataRoot(async (root) => {
    const database = openCanonicalHitchV2Database({
      dataRoot: root.resolve("state"),
    });
    try {
      await new SQLiteBootstrapPublicationUnitOfWork({
        database,
        clock: new DeterministicClock("2026-07-29T12:00:01.000Z"),
        ids: new DeterministicIdSource("bootstrap"),
      }).publishBootstrap(createBootstrapPublicationRecords());
      const first = createFirstSliceAuthorizationTrust({
        database,
        clock: new DeterministicClock("2026-07-29T12:03:00.000Z"),
        ids: new DeterministicIdSource("first"),
      });
      const second = createFirstSliceAuthorizationTrust({
        database,
        clock: new DeterministicClock("2026-07-29T12:04:00.000Z"),
        ids: new DeterministicIdSource("second"),
      });
      const authentication = await first.localAuthentication.authenticate(
        first.localConnectionIssuer.issueAcceptedConnection(),
      );
      assert.equal(authentication.status, "authenticated");
      if (authentication.status !== "authenticated") return;
      assert.deepEqual(
        first.contextVerifier.classify(authentication.context),
        {
          kind: "connector",
          context: authentication.context,
        },
      );
      assert.equal(
        second.contextVerifier.classify(authentication.context),
        undefined,
      );
      assert.equal(
        first.contextVerifier.classify(
          structuredClone(authentication.context),
        ),
        undefined,
      );

      const service =
        await first.serviceContextIssuer.forComponent("broker");
      const forged = {
        actor: { kind: "system", component: "broker" },
      } as TrustedServiceAuthorizationContext<"broker">;
      assert.equal(first.contextVerifier.classify(forged), undefined);
      assert.equal(
        first.contextVerifier.classify(structuredClone(service)),
        undefined,
      );
      assert.equal(second.contextVerifier.classify(service), undefined);
      assert.equal(first.contextVerifier.classify(null), undefined);
      assert.equal(first.contextVerifier.classify("broker"), undefined);
    } finally {
      database.close();
    }
  });
});
