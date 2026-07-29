/** Canonical V2 database opening and one-shot pristine initialization. */

import {
  V2Database,
  type ExistingV2DatabaseValidation,
  type OpenV2DatabaseOptions,
} from "./database.js";
import { V2DataRootError } from "./errors.js";
import {
  HITCH_V2_SQLITE_APPLICATION_ID,
  HITCH_V2_SQLITE_USER_VERSION,
  initializeCanonicalHitchV2Schema,
  validateCanonicalHitchV2Schema,
} from "./schema.js";

export interface OpenCanonicalHitchV2DatabaseOptions {
  readonly dataRoot: string;
  readonly transactionFaults?: OpenV2DatabaseOptions["transactionFaults"];
}

function isExactPristineFoundation(validation: ExistingV2DatabaseValidation): boolean {
  return (
    validation.applicationId === 0 &&
    validation.userVersion === 0 &&
    validation.schemaObjects.length === 0
  );
}

/**
 * Accept only an exact former-pristine foundation or an exact canonical V2 DB
 * while the original file is still isolated from SQLite configuration.  The
 * former can only arise when the all-or-nothing schema transaction rolled
 * back; it is safe to retry, whereas every partial/nonzero/unknown state is
 * rejected without opening the real file normally.
 */
export function validateExistingCanonicalHitchV2Database(
  validation: ExistingV2DatabaseValidation,
): void {
  if (isExactPristineFoundation(validation)) return;
  validateCanonicalHitchV2Schema(validation);
}

function currentSchemaIdentity(database: V2Database): readonly [number, number] {
  return database.transaction((transaction) => {
    const application = transaction.get("PRAGMA application_id");
    const version = transaction.get("PRAGMA user_version");
    const applicationId = application === undefined ? undefined : Object.values(application)[0];
    const userVersion = version === undefined ? undefined : Object.values(version)[0];
    if (typeof applicationId !== "number" || typeof userVersion !== "number" || !Number.isSafeInteger(applicationId) || !Number.isSafeInteger(userVersion)) {
      throw new V2DataRootError("SQLite returned an invalid canonical schema identity");
    }
    return [applicationId, userVersion] as const;
  });
}

/**
 * The application-facing composition.  Repositories receive the resulting
 * bound-only V2Database, never an initialization capability or DDL access.
 */
export function openCanonicalHitchV2Database(
  options: OpenCanonicalHitchV2DatabaseOptions,
): V2Database {
  const database = V2Database.open({
    dataRoot: options.dataRoot,
    validateExistingDatabase: validateExistingCanonicalHitchV2Database,
    ...(options.transactionFaults === undefined ? {} : { transactionFaults: options.transactionFaults }),
  });
  try {
    const [applicationId, userVersion] = currentSchemaIdentity(database);
    if (applicationId === 0 && userVersion === 0) {
      database.initializePristineSchema(initializeCanonicalHitchV2Schema);
      return database;
    }
    if (
      applicationId !== HITCH_V2_SQLITE_APPLICATION_ID ||
      userVersion !== HITCH_V2_SQLITE_USER_VERSION
    ) {
      throw new V2DataRootError("opened SQLite schema identity drifted after canonical validation");
    }
    return database;
  } catch (error) {
    try {
      database.close();
    } catch {
      // The original initialization/validation failure remains authoritative.
    }
    throw error;
  }
}
