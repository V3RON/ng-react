import {
  DuplicateProviderError,
  DuplicateRegistrationError,
  InvalidDescriptorError,
  ProviderKindConflictError,
} from '../errors';
import type { AnyProviderRecord, ProviderRecord } from '../provider';
import type { Scope } from '../types';
import type { AnyToken, Token } from '../token';

/**
 * A `ProviderRecord` together with the module that registered it.
 *
 * `owner` is the `moduleId` argument passed to `register()`, never a field
 * read off the record, so a module cannot misreport its own identity.
 */
export interface RegisteredProvider<T = unknown> {
  readonly record: ProviderRecord<T>;
  readonly owner: string;
}

/** One row of `inspect()`'s provider table. */
export interface ProviderSnapshotEntry {
  readonly tokenLabel: string;
  readonly kind: 'provide' | 'contribute';
  readonly scope: Scope;
  readonly owner: string;
  readonly override: boolean;
  /**
   * The module id of the `override: true` registration that displaced this
   * row, set only on a plain `provide` that is not the effective provider for
   * its token.
   *
   * A row without this field is live: it is either the token's effective
   * provider or a contribution.
   */
  readonly overriddenBy?: string;
}

/** One row of `inspect()`'s per-module table. */
export interface ModuleSnapshotEntry {
  readonly moduleId: string;
  /** Labels of every token this module provides or contributes to, sorted. */
  readonly tokenLabels: readonly string[];
}

/**
 * A JSON-serialisable snapshot of everything the registry knows.
 *
 * Both arrays are sorted deterministically — `providers` by `tokenLabel` then
 * `owner`, `modules` by `moduleId` — so registering the same set of modules in
 * a different order produces identical output.
 */
export interface RegistrySnapshot {
  readonly providers: readonly ProviderSnapshotEntry[];
  readonly modules: readonly ModuleSnapshotEntry[];
}

/** Renders a value for an error message: `string 'x'`, `number`, `null`, … */
function describeValue(value: unknown): string {
  if (value === null) {
    return 'null';
  }
  if (value === undefined) {
    return 'undefined';
  }
  if (typeof value === 'string') {
    return `string '${value}'`;
  }
  return typeof value;
}

/** One validated action from `register()`'s first pass, applied in its second. */
type PlannedAction =
  | { readonly kind: 'provide'; readonly token: AnyToken; readonly entry: RegisteredProvider }
  | { readonly kind: 'contribute'; readonly token: AnyToken; readonly entry: RegisteredProvider }
  | {
      // A plain `provide` for a token an `override: true` registration already
      // holds: recorded, never effective, never fatal.
      readonly kind: 'superseded';
      readonly token: AnyToken;
      readonly entry: RegisteredProvider;
      readonly overriddenBy: string;
    };

/** One plain `provide` an override displaced — the backing store for `overriddenBy`. */
interface SupersededProvider {
  readonly entry: RegisteredProvider;
  readonly overriddenBy: string;
}

/**
 * Shared, frozen "no contributions" result.
 *
 * Returned by `getContributions` for a token that has never had one, so that
 * repeated calls observing no change return the same object and a caller's
 * identity comparison reads "unchanged".
 */
const EMPTY_CONTRIBUTIONS: readonly RegisteredProvider[] = Object.freeze([]);

/**
 * The store of provider and contribution records, keyed by token and attributed
 * to an owning module.
 *
 * Enforces every registration-time rule. Nothing here constructs instances.
 */
export class ProviderRegistry {
  /** `provide`d tokens: at most one `RegisteredProvider` per token. */
  private readonly providers = new Map<AnyToken, RegisteredProvider>();
  /**
   * `contribute`d tokens: an ordered, frozen list per token.
   *
   * Every array stored here is replaced wholesale rather than mutated, so a
   * reference handed out by `getContributions` is safe to cache and compare by
   * identity.
   */
  private readonly contributions = new Map<AnyToken, readonly RegisteredProvider[]>();
  /**
   * Plain `provide` registrations an `override: true` registration superseded,
   * keyed by token.
   *
   * Purely diagnostic: `getProvider`, `hasToken` and `ownerOf` never consult it,
   * and nothing here is resolvable. A superseded entry is dropped when its own
   * owner withdraws, not when the winning override does, and withdrawing the
   * override never promotes it back into the provider slot.
   */
  private readonly superseded = new Map<AnyToken, SupersededProvider[]>();
  /** Every token (provided or contributed) a module currently owns — drives `withdraw` and `inspect`. */
  private readonly moduleTokens = new Map<string, Set<AnyToken>>();
  /**
   * Module ids currently registered.
   *
   * Tracked separately from `moduleTokens` so that a module registered with
   * zero records still counts as registered.
   */
  private readonly registeredModules = new Set<string>();
  /** Populated by `setKnownModules` — backs `findModuleByTokenLabelPrefix`. */
  private knownModules = new Set<string>();

  /**
   * Records every provider and contribution in `records` as owned by `moduleId`.
   *
   * Registration is atomic: `records` is validated against both the existing
   * registry state and the records accepted earlier in the same call, and
   * nothing is written until every record has passed. A failing batch therefore
   * leaves the registry untouched and can be retried.
   *
   * @throws {InvalidDescriptorError} for a malformed `moduleId` or `records`.
   * @throws {DuplicateRegistrationError} if `moduleId` is already registered;
   *   call `withdraw(moduleId)` first.
   * @throws {DuplicateProviderError} for a second plain `provide()` of a token
   *   another plain `provide()` already holds. A plain `provide()` for a token
   *   an `override: true` registration holds is recorded as superseded instead.
   * @throws {ProviderKindConflictError} for a `provide()` or `contribute()` of a
   *   token the registry already holds under the other kind.
   */
  register(moduleId: string, records: readonly AnyProviderRecord[]): void {
    if (typeof moduleId !== 'string' || moduleId.trim().length === 0) {
      throw new InvalidDescriptorError(
        `ProviderRegistry.register() requires a non-empty module id, got ${describeValue(moduleId)}.`,
      );
    }
    if (!Array.isArray(records)) {
      throw new InvalidDescriptorError(
        `ProviderRegistry.register(${moduleId}): records must be an array, got ${describeValue(records)}.`,
        moduleId,
      );
    }
    if (this.registeredModules.has(moduleId)) {
      throw new DuplicateRegistrationError(moduleId);
    }

    // Pass 1 — validate. `batchProviders` and `batchContributionOwners` overlay
    // the real maps for the duration of this call, so later records in the batch
    // see the effect of earlier ones and the outcome matches what separate
    // `register` calls in the same order would produce.
    const batchProviders = new Map<AnyToken, RegisteredProvider>();
    const batchContributionOwners = new Map<AnyToken, string[]>();
    const plan: PlannedAction[] = [];

    for (const record of records) {
      const token = record.token;
      const existingProvider = batchProviders.get(token) ?? this.providers.get(token);
      const contributionOwners = [
        ...(this.contributions.get(token) ?? []).map((entry) => entry.owner),
        ...(batchContributionOwners.get(token) ?? []),
      ];

      if (record.kind === 'provide') {
        if (contributionOwners.length > 0) {
          throw new ProviderKindConflictError(
            record.token.label,
            'contribute',
            [...new Set(contributionOwners)].sort(),
            'provide',
            moduleId,
          );
        }
        // Override precedence, deliberately one-sided so the outcome does not
        // depend on registration order: `override: true` always takes the slot,
        // and a plain provide is superseded — recorded, ignored, not fatal —
        // when an override already holds it. Whichever provide ever set
        // `override: true` stays the effective provider. Two plain provides for
        // one token remain fatal.
        if (existingProvider !== undefined && !record.override) {
          if (!existingProvider.record.override) {
            throw new DuplicateProviderError(record.token.label, existingProvider.owner, moduleId);
          }
          plan.push({
            kind: 'superseded',
            token,
            entry: Object.freeze({ record, owner: moduleId }),
            overriddenBy: existingProvider.owner,
          });
          continue;
        }
        const entry: RegisteredProvider = Object.freeze({ record, owner: moduleId });
        batchProviders.set(token, entry);
        plan.push({ kind: 'provide', token, entry });
      } else {
        if (existingProvider !== undefined) {
          throw new ProviderKindConflictError(
            record.token.label,
            'provide',
            [existingProvider.owner],
            'contribute',
            moduleId,
          );
        }
        const entry: RegisteredProvider = Object.freeze({ record, owner: moduleId });
        const owners = batchContributionOwners.get(token) ?? [];
        owners.push(moduleId);
        batchContributionOwners.set(token, owners);
        plan.push({ kind: 'contribute', token, entry });
      }
    }

    // Pass 2 — commit. Every entry in `plan` already passed validation, so this
    // loop cannot throw.
    //
    // Contributions are copy-on-write: a new array replaces the stored one
    // rather than being pushed into. `getContributions` hands its return value
    // out by reference, and subscribers detect change by comparing that
    // reference, so an in-place push would report "unchanged" after a real
    // addition.
    const ownedTokens = new Set<AnyToken>();
    for (const action of plan) {
      if (action.kind === 'provide') {
        // An override taking a slot a plain provider held records the displaced
        // entry, so both registration orders leave the same observable state.
        const displaced = this.providers.get(action.token);
        if (displaced !== undefined) {
          this.addSuperseded(action.token, { entry: displaced, overriddenBy: action.entry.owner });
        }
        this.providers.set(action.token, action.entry);
      } else if (action.kind === 'superseded') {
        this.addSuperseded(action.token, { entry: action.entry, overriddenBy: action.overriddenBy });
      } else {
        const existing = this.contributions.get(action.token) ?? EMPTY_CONTRIBUTIONS;
        this.contributions.set(action.token, Object.freeze([...existing, action.entry]));
      }
      ownedTokens.add(action.token);
    }
    this.moduleTokens.set(moduleId, ownedTokens);
    this.registeredModules.add(moduleId);
  }

  /**
   * Removes every provider and contribution owned by `moduleId`.
   *
   * @returns the distinct set of tokens the module owned, so the caller knows
   *   which contribution subscribers to notify. The set over-reports: it
   *   includes `provide`-kind tokens and contribution tokens whose effective
   *   collection did not change.
   *
   * Withdrawing a module that was never registered, or was already withdrawn,
   * is a no-op returning an empty set.
   */
  withdraw(moduleId: string): ReadonlySet<AnyToken> {
    const tokens = this.moduleTokens.get(moduleId);
    if (tokens === undefined) {
      return new Set();
    }

    for (const token of tokens) {
      const provider = this.providers.get(token);
      if (provider !== undefined && provider.owner === moduleId) {
        this.providers.delete(token);
      }

      const displaced = this.superseded.get(token);
      if (displaced !== undefined) {
        const remaining = displaced.filter((row) => row.entry.owner !== moduleId);
        if (remaining.length > 0) {
          this.superseded.set(token, remaining);
        } else {
          this.superseded.delete(token);
        }
      }

      const contributors = this.contributions.get(token);
      if (contributors !== undefined) {
        const remaining = Object.freeze(contributors.filter((entry) => entry.owner !== moduleId));
        if (remaining.length > 0) {
          this.contributions.set(token, remaining);
        } else {
          this.contributions.delete(token);
        }
      }
    }

    this.moduleTokens.delete(moduleId);
    this.registeredModules.delete(moduleId);
    return tokens;
  }

  /** Appends one superseded row — see the `superseded` field. */
  private addSuperseded(token: AnyToken, row: SupersededProvider): void {
    const existing = this.superseded.get(token);
    if (existing === undefined) {
      this.superseded.set(token, [row]);
    } else {
      existing.push(row);
    }
  }

  /** The single provider for `token`, if any. Never returns a contribution. */
  getProvider<T>(token: Token<T>): RegisteredProvider<T> | undefined {
    return this.providers.get(token) as RegisteredProvider<T> | undefined;
  }

  /**
   * Every contribution registered for `token`, in registration order. Empty if
   * none.
   *
   * The returned array is frozen, and is a stable reference for as long as the
   * collection is unchanged, becoming a fresh reference the instant a
   * contribution is added or removed. Callers may use that identity as a sound
   * change signal.
   */
  getContributions<T>(token: Token<T>): readonly RegisteredProvider<T>[] {
    return (this.contributions.get(token) ?? EMPTY_CONTRIBUTIONS) as readonly RegisteredProvider<T>[];
  }

  /** Whether `token` has a provider or at least one contribution registered. */
  hasToken<T>(token: Token<T>): boolean {
    return this.providers.has(token) || (this.contributions.get(token)?.length ?? 0) > 0;
  }

  /**
   * The owning module of `token`'s single provider.
   *
   * @returns `undefined` both for an unknown token and for a contribution token,
   *   which has potentially many owners; use `getContributions` for those.
   */
  ownerOf<T>(token: Token<T>): string | undefined {
    return this.providers.get(token)?.owner;
  }

  /**
   * The module id prefix of a token label such as `'payments/PaymentGateway'`,
   * but only when a module with that id was passed to `setKnownModules`.
   *
   * @returns the prefix, or `undefined` if the label has no prefix or names no
   *   known module.
   */
  findModuleByTokenLabelPrefix(label: string): string | undefined {
    const separatorIndex = label.indexOf('/');
    if (separatorIndex <= 0) {
      return undefined;
    }
    const prefix = label.slice(0, separatorIndex);
    return this.knownModules.has(prefix) ? prefix : undefined;
  }

  /**
   * Replaces the set of module ids the registry treats as real when matching a
   * token label prefix.
   *
   * @param ids every module id the kernel knows about, registered or merely
   *   declared.
   */
  setKnownModules(ids: readonly string[]): void {
    this.knownModules = new Set(ids);
  }

  /**
   * A deterministic snapshot of the registry's state.
   *
   * Sorted explicitly rather than in `Map` insertion order, so callers cannot
   * observe registration order.
   */
  inspect(): RegistrySnapshot {
    const providerRows: ProviderSnapshotEntry[] = [];
    for (const provided of this.providers.values()) {
      providerRows.push({
        tokenLabel: provided.record.token.label,
        kind: 'provide',
        scope: provided.record.scope,
        owner: provided.owner,
        override: provided.record.override,
      });
    }
    for (const displaced of this.superseded.values()) {
      for (const row of displaced) {
        providerRows.push({
          tokenLabel: row.entry.record.token.label,
          kind: 'provide',
          scope: row.entry.record.scope,
          owner: row.entry.owner,
          override: row.entry.record.override,
          overriddenBy: row.overriddenBy,
        });
      }
    }
    for (const contributors of this.contributions.values()) {
      for (const contributed of contributors) {
        providerRows.push({
          tokenLabel: contributed.record.token.label,
          kind: 'contribute',
          scope: contributed.record.scope,
          owner: contributed.owner,
          override: contributed.record.override,
        });
      }
    }
    providerRows.sort(
      (a, b) =>
        a.tokenLabel.localeCompare(b.tokenLabel) ||
        a.owner.localeCompare(b.owner) ||
        // Effective rows before superseded ones, so a token with both is still
        // deterministically ordered.
        Number(a.overriddenBy !== undefined) - Number(b.overriddenBy !== undefined),
    );

    const moduleRows: ModuleSnapshotEntry[] = [];
    for (const [moduleId, tokens] of this.moduleTokens) {
      const tokenLabels = [...tokens].map((token) => token.label).sort();
      moduleRows.push({ moduleId, tokenLabels });
    }
    moduleRows.sort((a, b) => a.moduleId.localeCompare(b.moduleId));

    return Object.freeze({
      providers: Object.freeze(providerRows),
      modules: Object.freeze(moduleRows),
    });
  }
}
