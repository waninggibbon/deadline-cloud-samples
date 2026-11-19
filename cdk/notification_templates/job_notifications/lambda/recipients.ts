// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.

// Resolves the principals a notification is addressed to into recipients: a
// person or team with their preferences and, where one is known, an email
// address.

import { isPermanent } from './errors';
import { Logger } from './log';
import { Preferences } from './preferences';
import { Principal, PrincipalType } from './types';

/** IAM Identity Center lookups. */
export interface IdentityDirectory {
  /**
   * A user's primary email address, or `undefined` for a user with none. Throws
   * a `PermanentError` for a user or store that cannot be read.
   */
  userEmail(identityStoreId: string, userId: string): Promise<string | undefined>;
  /** The user IDs of a group's direct members, at most `limit` of them. */
  groupMembers(
    identityStoreId: string,
    groupId: string,
    limit: number,
  ): Promise<{ userIds: string[]; truncated: boolean }>;
}

export interface PreferencesStore {
  get(principalId: string): Promise<Preferences | undefined>;
}

export interface Recipient {
  readonly type: PrincipalType;
  readonly principalId: string;
  readonly email?: string;
  readonly preferences?: Preferences;
}

/**
 * A principal that could not be resolved, in whole or in part, and why. Logged,
 * never an error. A user whose email lookup failed can still be a recipient on
 * a webhook channel from their preferences.
 */
export interface Unresolved {
  readonly principal: Principal;
  readonly reason: string;
}

export interface Resolution {
  readonly recipients: Recipient[];
  readonly unresolved: Unresolved[];
}

export interface ResolveOptions {
  readonly identity: IdentityDirectory;
  /** The identity store the stack is configured with, if any. */
  readonly identityStoreId?: string;
  readonly preferences: PreferencesStore;
  readonly maxGroupMembers: number;
  /** Principal IDs never to notify, such as whoever made the decision being reported. */
  readonly exclude?: ReadonlySet<string>;
  readonly log: Logger;
}

/**
 * The identity store to look a principal up in.
 *
 * A configured store is authoritative: a principal the event places in another
 * store is not looked up, which the function's IAM policy would refuse anyway.
 * Without one, the store the event names is used, so approvers resolve even
 * when the stack was deployed without an IdentityStoreId.
 */
export function identityStoreFor(
  configured: string | undefined,
  named: string | undefined,
): { storeId: string } | { reason: string } {
  if (configured) {
    return !named || named === configured ? { storeId: configured } : { reason: 'IdentityStoreMismatch' };
  }
  return named ? { storeId: named } : { reason: 'IdentityStoreNotConfigured' };
}

/**
 * Resolve principals to recipients, each person at most once.
 *
 * - A user gets their preferences, and the email address from their
 *   preferences or from the identity store.
 * - A group is expanded to its direct members, each resolved as a user. The
 *   group is also a recipient in its own right when it has preferences, which
 *   is how a team channel is notified.
 * - An IAM principal has no directory entry, so it is a recipient only when it
 *   has preferences, and is skipped otherwise.
 */
export async function resolveRecipients(
  audience: readonly Principal[],
  options: ResolveOptions,
): Promise<Resolution> {
  const recipients = new Map<string, Recipient>();
  const unresolved: Unresolved[] = [];
  const excluded = options.exclude ?? new Set<string>();

  /**
   * Run an identity store lookup. A lookup that can never succeed, such as one
   * in a store the function may not read, leaves that principal unresolved
   * rather than failing the event for everyone else.
   */
  const lookUp = async <T>(principal: Principal, lookup: () => Promise<T>, fallback: T): Promise<T> => {
    try {
      return await lookup();
    } catch (error) {
      if (!isPermanent(error)) throw error;
      unresolved.push({ principal, reason: error.code });
      return fallback;
    }
  };

  const addUser = async (userId: string, storeId: string | undefined): Promise<void> => {
    if (recipients.has(userId) || excluded.has(userId)) return;
    const preferences = await options.preferences.get(userId);
    const email =
      preferences?.email ??
      (storeId
        ? await lookUp(
            { type: 'USER', id: userId, identityStoreId: storeId },
            () => options.identity.userEmail(storeId, userId),
            undefined,
          )
        : undefined);
    recipients.set(userId, { type: 'USER', principalId: userId, email, preferences });
  };

  for (const principal of dedupePrincipals(audience)) {
    if (excluded.has(principal.id)) continue;
    const store = identityStoreFor(options.identityStoreId, principal.identityStoreId);
    const storeId = 'storeId' in store ? store.storeId : undefined;
    switch (principal.type) {
      case 'USER':
        await addUser(principal.id, storeId);
        break;
      case 'GROUP': {
        const groupPreferences = await options.preferences.get(principal.id);
        if (groupPreferences && !recipients.has(principal.id)) {
          recipients.set(principal.id, {
            type: 'GROUP',
            principalId: principal.id,
            email: groupPreferences.email,
            preferences: groupPreferences,
          });
        }
        if (!storeId) {
          unresolved.push({ principal, reason: 'reason' in store ? store.reason : 'NoIdentityStore' });
          break;
        }
        const { userIds, truncated } = await lookUp(
          principal,
          () => options.identity.groupMembers(storeId, principal.id, options.maxGroupMembers),
          { userIds: [], truncated: false },
        );
        if (truncated) {
          options.log.warn('Group has more members than MAX_GROUP_MEMBERS; notifying the first ones', {
            groupId: principal.id,
            maxGroupMembers: options.maxGroupMembers,
          });
        }
        for (const userId of userIds) {
          await addUser(userId, storeId);
        }
        break;
      }
      case 'IAM': {
        const preferences = await options.preferences.get(principal.id);
        if (!preferences) {
          unresolved.push({ principal, reason: 'IamPrincipalWithoutPreferences' });
          break;
        }
        recipients.set(principal.id, {
          type: 'IAM',
          principalId: principal.id,
          email: preferences.email,
          preferences,
        });
        break;
      }
    }
  }

  return { recipients: [...recipients.values()], unresolved };
}

function dedupePrincipals(audience: readonly Principal[]): Principal[] {
  const seen = new Set<string>();
  return audience.filter((principal) => {
    const key = `${principal.type}:${principal.id}:${principal.identityStoreId ?? ''}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}
